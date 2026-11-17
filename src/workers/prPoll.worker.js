/**
 * PR Poll Worker — Lead Developer AI: auto-merge gate
 *
 * Queue: "pr-poll"
 * Job name: "poll-pr"
 * Job data: { jobId: string, prNumber: number, repoFullName: string }
 *
 * Polls GitHub every 5 minutes (via BullMQ retry backoff).
 * Fully autonomous merge flow — no human required:
 *
 *  State machine per poll attempt:
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │ PR merged already  → onMerged() → deploy                        │
 *  │ PR closed          → fail job                                    │
 *  │ PR open:                                                         │
 *  │   CHANGES_REQUESTED review exists                                │
 *  │     → flag tasks, enqueue rework, wait                          │
 *  │   CI checks:                                                     │
 *  │     anyFailed      → enqueue rework, wait for rework to re-push  │
 *  │     pending        → throw (retry in 5 min)                     │
 *  │     allPassed      → auto-merge (squash) → onMerged()           │
 *  │     no checks yet  → throw (retry — give CI time to start)      │
 *  └──────────────────────────────────────────────────────────────────┘
 *
 * MAX_CI_FAIL_RETRIES: after this many consecutive CI failures the job
 * is escalated (failed) rather than looping rework forever.
 */
import { Worker } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { connectDb } from "../lib/db.js";
import { githubClient } from "../lib/githubClient.js";
import { pmsClient } from "../lib/pmsClient.js";
import { cleanupClone } from "../lib/gitOps.js";
import { audit } from "../lib/audit.js";
import { getQueues } from "../lib/queues.js";
import Job from "../models/Job.js";
import Task from "../models/Task.js";

await connectDb();

const MAX_CI_FAIL_RETRIES = Number(process.env.CI_FAIL_MAX_RETRIES ?? 3);

// ── Shared: handle a successfully merged PR ───────────────────────────────────

async function onMerged(orcJob, prNumber, repoFullName) {
  console.log(`[pr-poll-worker] PR #${prNumber} merged — completing job ${orcJob._id}`);

  // Move PMS tasks to done (best-effort)
  try {
    await pmsClient.ensureSession();
    for (const taskId of orcJob.pmsTaskIds ?? []) {
      try {
        await pmsClient.moveTask(taskId, "done", `PR #${prNumber} merged on ${new Date().toISOString()}`);
        console.log(`[pr-poll-worker] PMS task ${taskId} → done`);
      } catch (e) {
        console.warn(`[pr-poll-worker] could not move task ${taskId} to done:`, e.message);
      }
    }
  } catch (e) {
    console.warn("[pr-poll-worker] PMS session unavailable for task update:", e.message);
  }

  // Clean up clone directory
  if (orcJob.clonePath) {
    await cleanupClone(orcJob.clonePath).catch(() => {});
    console.log(`[pr-poll-worker] cleaned up clone ${orcJob.clonePath}`);
  }

  orcJob.status = "merged";
  orcJob.stage = 10;
  await orcJob.save();

  await Task.updateMany(
    { jobId: orcJob._id, status: { $in: ["pr_open", "changes_requested"] } },
    { status: "merged" },
  );

  audit("system", "pr.merged", {
    jobId: orcJob._id,
    details: { prNumber, repoFullName, autoMerged: true },
  });

  const queues = getQueues();
  await queues.deploy.add(
    "run-deploy",
    { jobId: String(orcJob._id) },
    { jobId: `deploy-${orcJob._id}` },
  ).catch((e) => console.warn("[pr-poll-worker] deploy enqueue warning:", e.message));
}

// ── Main processor ────────────────────────────────────────────────────────────

const processor = async (bullJob) => {
  const { jobId, prNumber, repoFullName } = bullJob.data;
  console.log(`[pr-poll-worker] checking PR #${prNumber} for job=${jobId} attempt=${bullJob.attemptsMade + 1}`);

  const orcJob = await Job.findById(jobId);
  if (!orcJob) {
    console.warn(`[pr-poll-worker] job ${jobId} not found — stopping poll`);
    return { stopped: "job_not_found" };
  }

  if (["merged", "failed", "cancelled"].includes(orcJob.status)) {
    console.log(`[pr-poll-worker] job ${jobId} already in terminal status ${orcJob.status} — stopping`);
    return { stopped: orcJob.status };
  }

  // ── Fetch PR state ────────────────────────────────────────────────────────
  let pr;
  try {
    pr = await githubClient.getPull(repoFullName, prNumber);
  } catch (err) {
    if (err.code === "NOT_FOUND") {
      await Job.findByIdAndUpdate(jobId, {
        status: "failed",
        errorMessage: `PR #${prNumber} not found on GitHub — may have been deleted`,
      });
      return { stopped: "pr_not_found" };
    }
    throw new Error(`GitHub getPull failed: ${err.message}`);
  }

  // ── Already merged (externally or by a previous attempt) ─────────────────
  if (pr.state === "merged") {
    await onMerged(orcJob, prNumber, repoFullName);
    return { merged: true, prNumber, autoMerged: false };
  }

  // ── Closed without merge ──────────────────────────────────────────────────
  if (pr.state === "closed") {
    console.log(`[pr-poll-worker] PR #${prNumber} closed without merge — failing job ${jobId}`);
    if (orcJob.clonePath) await cleanupClone(orcJob.clonePath).catch(() => {});
    await Job.findByIdAndUpdate(jobId, {
      status: "failed",
      errorMessage: `PR #${prNumber} was closed without merging. Start a new job to retry.`,
    });
    await Task.updateMany(
      { jobId: orcJob._id, status: { $in: ["pr_open", "changes_requested"] } },
      { status: "failed", errorMessage: `PR #${prNumber} closed without merging` },
    );
    audit("system", "pr.closed_without_merge", {
      jobId: orcJob._id,
      details: { prNumber, repoFullName },
    });
    return { closed: true, prNumber };
  }

  // ── PR is open — check for CHANGES_REQUESTED ─────────────────────────────
  let hasChangesRequested = false;
  try {
    const reviews = await githubClient.getPullReviews(repoFullName, prNumber);
    const latestByUser = new Map();
    for (const r of reviews) {
      if (r.state !== "DISMISSED") latestByUser.set(r.user, r.state);
    }
    hasChangesRequested = [...latestByUser.values()].some((s) => s === "CHANGES_REQUESTED");

    if (hasChangesRequested) {
      await Task.updateMany(
        { jobId: orcJob._id, status: "pr_open" },
        { status: "changes_requested" },
      );
      await Job.findByIdAndUpdate(orcJob._id, { status: "pr_open" });
      console.log(`[pr-poll-worker] PR #${prNumber} has changes_requested — tasks flagged`);
    } else {
      // Clear stale changes_requested flags if reviewer since approved
      await Task.updateMany(
        { jobId: orcJob._id, status: "changes_requested" },
        { status: "pr_open" },
      );
    }
  } catch (reviewErr) {
    console.warn(`[pr-poll-worker] could not fetch reviews for PR #${prNumber}:`, reviewErr.message);
  }

  // If a human reviewer requested changes, skip auto-merge this round and wait
  if (hasChangesRequested) {
    throw new Error(`PR #${prNumber} has CHANGES_REQUESTED — waiting for review resolution`);
  }

  // ── Check GitHub Actions CI status ───────────────────────────────────────
  let checks;
  try {
    checks = await githubClient.getCheckRuns(repoFullName, pr.headSha);
  } catch (err) {
    console.warn(`[pr-poll-worker] could not fetch check runs for PR #${prNumber}:`, err.message);
    // Treat as pending — retry
    throw new Error(`CI check fetch failed for PR #${prNumber}: ${err.message}`);
  }

  console.log(
    `[pr-poll-worker] PR #${prNumber} checks — allPassed=${checks.allPassed} anyFailed=${checks.anyFailed} pending=${checks.pending} total=${checks.runs.length}`,
  );

  // CI checks failed → enqueue rework for each pushed task (up to MAX_CI_FAIL_RETRIES)
  if (checks.anyFailed) {
    const failedNames = checks.runs.filter((r) => r.conclusion && !["success","neutral","skipped"].includes(r.conclusion)).map((r) => r.name).join(", ");
    const ciFailCount = (orcJob.ciFailCount ?? 0) + 1;
    console.error(`[pr-poll-worker] CI failed for PR #${prNumber} (attempt ${ciFailCount}/${MAX_CI_FAIL_RETRIES}): ${failedNames}`);

    if (ciFailCount > MAX_CI_FAIL_RETRIES) {
      await Job.findByIdAndUpdate(jobId, {
        status: "failed",
        errorMessage: `CI failed ${ciFailCount} times on PR #${prNumber}. Last failure: ${failedNames}. Manual intervention required.`,
      });
      audit("system", "pr.ci_escalated", {
        jobId: orcJob._id,
        details: { prNumber, repoFullName, ciFailCount, failedNames },
      });
      return { stopped: "ci_max_retries", prNumber };
    }

    await Job.findByIdAndUpdate(jobId, { ciFailCount });

    // Create rework tasks for each pushed task so the AI fixes the CI failures
    const pushedTasks = await Task.find({
      jobId: orcJob._id,
      status: { $in: ["pr_open", "pushed"] },
    }).lean();

    if (pushedTasks.length > 0) {
      const queues = getQueues();
      for (const task of pushedTasks) {
        const retryCount = (task.retryCount ?? 0) + 1;
        await queues.rework.add(
          "create-rework",
          {
            jobId: String(orcJob._id),
            taskId: String(task._id),
            reason: `CI check(s) failed on PR #${prNumber}: ${failedNames}. Fix the failing checks.`,
            retryCount,
          },
          { jobId: `rework-ci-${task._id}-${ciFailCount}` },
        );
      }
      console.warn(`[pr-poll-worker] enqueued ${pushedTasks.length} rework task(s) for CI failure`);
    }

    audit("system", "pr.ci_failed", {
      jobId: orcJob._id,
      details: { prNumber, repoFullName, ciFailCount, failedNames, reworkCount: pushedTasks.length },
    });

    // Throw so BullMQ retries — rework tasks will push new commits and re-trigger CI
    throw new Error(`CI failed on PR #${prNumber} (${failedNames}) — rework enqueued, will re-check`);
  }

  // CI checks still running — wait for them
  if (checks.pending) {
    throw new Error(`PR #${prNumber} CI checks still running — will check again in 5 minutes`);
  }

  // No checks registered yet — give CI time to start (treat as pending)
  if (checks.runs.length === 0) {
    throw new Error(`PR #${prNumber} has no CI checks yet — will check again in 5 minutes`);
  }

  // ── All CI checks passed → auto-merge ────────────────────────────────────
  console.log(`[pr-poll-worker] PR #${prNumber} all checks passed — auto-merging`);

  const shortJobId = String(jobId).slice(-8);
  try {
    await githubClient.mergePull(repoFullName, prNumber, {
      mergeMethod: "squash",
      commitTitle: `[AI Orchestrator] Job ${shortJobId} — autonomous integration`,
      commitMessage: [
        `Squash-merged by AI Development Orchestrator.`,
        ``,
        `Job: ${jobId}`,
        `All CI checks passed. Merged autonomously — no human review required.`,
      ].join("\n"),
    });
  } catch (mergeErr) {
    // 405 = not mergeable yet (GitHub says wait), 409 = conflicting
    if (mergeErr.status === 405 || mergeErr.status === 409) {
      console.warn(`[pr-poll-worker] merge not ready (${mergeErr.status}) — will retry: ${mergeErr.message}`);
      throw new Error(`PR #${prNumber} not yet mergeable (${mergeErr.status}) — will retry`);
    }
    throw new Error(`Auto-merge failed for PR #${prNumber}: ${mergeErr.message}`);
  }

  audit("system", "pr.auto_merged", {
    jobId: orcJob._id,
    details: { prNumber, repoFullName, headSha: pr.headSha },
  });

  await onMerged(orcJob, prNumber, repoFullName);
  return { merged: true, prNumber, autoMerged: true };
};

// ── Worker setup ──────────────────────────────────────────────────────────────

const worker = new Worker("pr-poll", processor, {
  connection: getRedis(),
  concurrency: 5,
});

worker.on("failed", async (bullJob, err) => {
  const { jobId, prNumber } = bullJob?.data ?? {};
  const isRetryExhausted = bullJob && bullJob.attemptsMade >= (bullJob.opts?.attempts ?? 20);

  if (isRetryExhausted && jobId) {
    console.error(`[pr-poll-worker] max attempts reached for job=${jobId} PR #${prNumber}`);
    try {
      const orcJob = await Job.findById(jobId);
      if (orcJob && !["merged", "failed", "cancelled"].includes(orcJob.status)) {
        if (orcJob.clonePath) await cleanupClone(orcJob.clonePath).catch(() => {});
        await Job.findByIdAndUpdate(jobId, {
          status: "failed",
          errorMessage: `PR #${prNumber} polling timed out after 20 attempts (100 min). Last error: ${err.message.slice(0, 300)}`,
        });
      }
    } catch (dbErr) {
      console.error("[pr-poll-worker] could not update timed-out job:", dbErr.message);
    }
  } else {
    console.log(`[pr-poll-worker] attempt ${bullJob?.attemptsMade ?? "?"} — PR #${prNumber} not ready, will retry`);
  }
});

worker.on("completed", (bullJob, result) => {
  if (result?.merged) {
    const how = result.autoMerged ? "auto-merged" : "externally merged";
    console.log(`[pr-poll-worker] PR #${result.prNumber} ${how} — job complete`);
  }
});

console.log("[pr-poll-worker] ready (concurrency: 5, auto-merge enabled)");
