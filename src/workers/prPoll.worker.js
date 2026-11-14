/**
 * PR Poll Worker — Phase 5
 *
 * Job name: "poll-pr"
 * Job data: { jobId: string, prNumber: number, repoFullName: string }
 *
 * Polls GitHub every 5 minutes (via BullMQ retry backoff) to check whether
 * the Team Lead has merged or closed the pull request.
 *
 *  - merged  → PMS tasks moved to done, clone cleaned up, job → merged
 *  - closed  → job → failed with reason
 *  - open    → throw (BullMQ retries with 5-min delay, up to 20 attempts)
 *
 * Security note: no code execution here — this worker only reads GitHub API
 * state and updates MongoDB + PMS. The actual merge happens in GitHub,
 * performed by a human reviewer, never automatically by this worker.
 */
import { Worker } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { connectDb } from "../lib/db.js";
import { githubClient } from "../lib/githubClient.js";
import { pmsClient } from "../lib/pmsClient.js";
import { cleanupClone } from "../lib/gitOps.js";
import { audit } from "../lib/audit.js";
import Job from "../models/Job.js";
import Task from "../models/Task.js";

await connectDb();

const processor = async (bullJob) => {
  const { jobId, prNumber, repoFullName } = bullJob.data;
  console.log(`[pr-poll-worker] checking PR #${prNumber} for job=${jobId} attempt=${bullJob.attemptsMade + 1}`);

  const orcJob = await Job.findById(jobId);
  if (!orcJob) {
    console.warn(`[pr-poll-worker] job ${jobId} not found — stopping poll`);
    return { stopped: "job_not_found" };
  }

  // If job was cancelled or already resolved, stop polling
  if (["merged", "failed", "cancelled"].includes(orcJob.status)) {
    console.log(`[pr-poll-worker] job ${jobId} already in terminal status ${orcJob.status} — stopping`);
    return { stopped: orcJob.status };
  }

  // Check GitHub PR status
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
    // Transient GitHub error — retry
    throw new Error(`GitHub getPull failed: ${err.message}`);
  }

  // Check for changes-requested reviews before processing merged/closed state
  if (pr.state !== "merged" && pr.state !== "closed") {
    try {
      const reviews = await githubClient.getPullReviews(repoFullName, prNumber);
      // Find the latest non-dismissed review state per reviewer
      const latestByUser = new Map();
      for (const r of reviews) {
        if (r.state !== "DISMISSED") latestByUser.set(r.user, r.state);
      }
      const hasChangesRequested = [...latestByUser.values()].some((s) => s === "CHANGES_REQUESTED");
      if (hasChangesRequested) {
        await Task.updateMany(
          { jobId: orcJob._id, status: "pr_open" },
          { status: "changes_requested" },
        );
        await Job.findByIdAndUpdate(orcJob._id, { status: "pr_open" }); // job stays pr_open; task shows changes_requested
        console.log(`[pr-poll-worker] PR #${prNumber} has changes_requested — tasks updated`);
      } else {
        // Clear changes_requested if reviewer approved since last check
        await Task.updateMany(
          { jobId: orcJob._id, status: "changes_requested" },
          { status: "pr_open" },
        );
      }
    } catch (reviewErr) {
      console.warn(`[pr-poll-worker] could not fetch reviews for PR #${prNumber}:`, reviewErr.message);
    }
  }

  if (pr.state === "merged") {
    console.log(`[pr-poll-worker] PR #${prNumber} merged — completing job ${jobId}`);

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
      await cleanupClone(orcJob.clonePath);
      console.log(`[pr-poll-worker] cleaned up clone ${orcJob.clonePath}`);
    }

    orcJob.status = "merged";
    orcJob.stage = 10;
    await orcJob.save();

    // Mark all pr_open tasks for this job as merged
    await Task.updateMany(
      { jobId: orcJob._id, status: "pr_open" },
      { status: "merged" },
    );

    audit("system", "pr.merged", {
      jobId: orcJob._id,
      details: { prNumber, repoFullName },
    });

    return { merged: true, prNumber };
  }

  if (pr.state === "closed") {
    console.log(`[pr-poll-worker] PR #${prNumber} closed without merge — failing job ${jobId}`);

    if (orcJob.clonePath) await cleanupClone(orcJob.clonePath);

    await Job.findByIdAndUpdate(jobId, {
      status: "failed",
      errorMessage: `PR #${prNumber} was closed without merging. Start a new job to retry.`,
    });

    await Task.updateMany(
      { jobId: orcJob._id, status: "pr_open" },
      { status: "failed", errorMessage: `PR #${prNumber} closed without merging` },
    );

    audit("system", "pr.closed_without_merge", {
      jobId: orcJob._id,
      details: { prNumber, repoFullName },
    });

    return { closed: true, prNumber };
  }

  // PR is still open — throw so BullMQ retries after 5-minute delay
  throw new Error(`PR #${prNumber} is still open (state: ${pr.state}) — will check again in 5 minutes`);
};

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
      if (orcJob && orcJob.status === "pr_open") {
        if (orcJob.clonePath) await cleanupClone(orcJob.clonePath);
        await Job.findByIdAndUpdate(jobId, {
          status: "failed",
          errorMessage: `PR #${prNumber} was not merged within the polling window (20 checks × 5 min). Check GitHub manually.`,
        });
      }
    } catch (dbErr) {
      console.error("[pr-poll-worker] could not update timed-out job:", dbErr.message);
    }
  } else {
    // Expected retry — PR is still open
    console.log(`[pr-poll-worker] attempt ${bullJob?.attemptsMade ?? "?"} — PR #${prNumber} still open, will retry`);
  }
});

worker.on("completed", (bullJob, result) => {
  if (result?.merged) {
    console.log(`[pr-poll-worker] PR #${result.prNumber} merged — job complete`);
  }
});

console.log("[pr-poll-worker] ready (concurrency: 5, 5-min fixed backoff)");
