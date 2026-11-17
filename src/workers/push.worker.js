/**
 * Push Worker — Autonomous Pipeline
 *
 * Queue: "push"
 * Job name: "push-branch"
 * Job data: { jobId: string, taskId: string | null }
 *
 * Triggered automatically by the quality gate worker on pass.
 * No human approval gate — pushes the committed task branch to GitHub
 * and opens a draft PR targeting the integration branch.
 *
 * After all tasks for a job reach "pushed", fires integration worker.
 *
 * Security:
 *  - Pushes task branch only — never main or integration branch
 *  - PR is marked draft initially; integration worker promotes it
 *  - Bot identity on all git operations (from gitOps)
 */
import { Worker } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { connectDb } from "../lib/db.js";
import { simpleGit } from "simple-git";
import Job from "../models/Job.js";
import Task from "../models/Task.js";
import { githubClient } from "../lib/githubClient.js";
import { pushBranch, BOT_NAME, BOT_EMAIL } from "../lib/gitOps.js";
import { pmsClient } from "../lib/pmsClient.js";
import { audit } from "../lib/audit.js";
import { getQueues } from "../lib/queues.js";
import { existsSync } from "fs";

await connectDb();

const PUSHED_TERMINAL = new Set(["pushed", "pr_open", "merged", "failed", "cancelled"]);

/** Check if all tasks for a job have reached a terminal state and at least one is pushed. */
async function checkIntegrationReady(jobId) {
  const all = await Task.find({ jobId }).lean();
  if (all.length === 0) return false;
  const blocking = all.filter((t) => !PUSHED_TERMINAL.has(t.status));
  if (blocking.length > 0) return false;
  return all.some((t) => t.status === "pushed" || t.status === "pr_open");
}

const processor = async (bullJob) => {
  const { jobId, taskId } = bullJob.data;
  console.log(`[push-worker] start jobId=${jobId} taskId=${taskId}`);

  const orcJob = await Job.findById(jobId);
  if (!orcJob) throw new Error(`Job ${jobId} not found`);

  const task = taskId ? await Task.findById(taskId) : null;

  if (!githubClient.isConfigured()) {
    console.warn("[push-worker] GitHub App not configured — skipping push");
    if (task) {
      await Task.findByIdAndUpdate(taskId, { status: "pushed", errorMessage: "GitHub push skipped: App not configured" });
    }
    return { skipped: true };
  }

  // Determine branch and clone path
  const branchName = task?.branchName ?? orcJob.branchName;
  const clonePath = task?.clonePath ?? orcJob.clonePath;
  const repoFullName = task?.repoFullName ?? orcJob.repoFullName;

  if (!branchName) throw new Error("No branchName — cannot push");
  if (!repoFullName) throw new Error("No repoFullName — cannot push");

  if (!clonePath || !existsSync(clonePath)) {
    throw new Error(`Clone directory not found at ${clonePath}. Restart job from Stage 6.`);
  }

  await bullJob.updateProgress(10);

  // Push branch to GitHub
  const git = simpleGit(clonePath);
  await git.addConfig("user.name", BOT_NAME, false, "local");
  await git.addConfig("user.email", BOT_EMAIL, false, "local");

  try {
    await pushBranch(git, branchName, repoFullName);
  } catch (err) {
    throw new Error(`Push failed for branch ${branchName}: ${err.message}`);
  }

  await bullJob.updateProgress(50);
  console.log(`[push-worker] pushed branch ${branchName} to ${repoFullName}`);

  // Create draft PR targeting integration branch (or main as fallback)
  const baseBranch = task?.baseBranch ?? "main";
  const integrationBranch = "integration";
  const prBase = baseBranch === "main" ? integrationBranch : baseBranch;

  let prNumber = null;
  let prUrl = null;

  const prTitle = task
    ? `[AI] ${task.title.slice(0, 100)}`
    : `[AI] Orchestrator job ${String(jobId).slice(-8)}`;

  const prBody = [
    `AI-generated code from the AI Development Orchestrator.`,
    ``,
    `**Job:** \`${jobId}\``,
    task ? `**Task:** ${task.title}` : "",
    task?.taskArea ? `**Area:** ${task.taskArea}` : "",
    ``,
    `> This PR was opened automatically. The integration agent will review and merge.`,
  ].filter(Boolean).join("\n");

  // Try preferred base (integration), fall back to main if it doesn't exist
  const baseCandidates = prBase !== baseBranch ? [prBase, baseBranch] : [baseBranch];

  for (const candidate of baseCandidates) {
    try {
      const pr = await githubClient.createPull(repoFullName, {
        branch: branchName,
        base: candidate,
        title: prTitle,
        body: prBody,
      });
      prNumber = pr.number;
      prUrl = pr.htmlUrl;
      console.log(`[push-worker] created PR #${prNumber} → ${candidate}: ${prUrl}`);
      break;
    } catch (err) {
      if (err.status === 422) {
        // Could be: (a) base branch doesn't exist → try next candidate
        //           (b) PR already open for this branch → look it up
        const existing = await githubClient.findPullByBranch(repoFullName, branchName).catch(() => null);
        if (existing) {
          prNumber = existing.number;
          prUrl = existing.htmlUrl;
          console.log(`[push-worker] PR already open for branch ${branchName} — reused #${prNumber}: ${prUrl}`);
          break;
        }
        // base branch probably doesn't exist — try next candidate
        console.warn(`[push-worker] PR base "${candidate}" rejected (422) — trying next candidate`);
      } else {
        console.warn(`[push-worker] PR creation failed: ${err.message} — branch was pushed`);
        break;
      }
    }
  }

  if (!prNumber) {
    console.warn(`[push-worker] could not create PR for branch ${branchName} — branch is on GitHub, open PR manually`);
  }

  await bullJob.updateProgress(70);

  // Update task / job status
  if (task) {
    await Task.findByIdAndUpdate(taskId, {
      status: "pushed",
      prNumber: prNumber ?? undefined,
      prUrl: prUrl ?? undefined,
      lastHeartbeatAt: new Date(),
    });
  }

  // Update PMS task status to in_review
  if (task?.pmsTaskId) {
    try {
      await pmsClient.ensureSession();
      await pmsClient.moveTask(task.pmsTaskId, "in_review").catch(() => {});
    } catch (err) {
      console.warn(`[push-worker] could not update PMS task ${task.pmsTaskId}: ${err.message}`);
    }
  }

  await bullJob.updateProgress(85);

  // Update job-level pushed info
  await Job.findByIdAndUpdate(jobId, {
    status: "pushed",
    stage: 8,
    branchName: orcJob.branchName ?? branchName,
    prNumber: orcJob.prNumber ?? prNumber ?? undefined,
    prUrl: orcJob.prUrl ?? prUrl ?? undefined,
    $unset: { errorMessage: 1 },
  });

  audit("system", "push.completed", {
    jobId: orcJob._id,
    details: { branchName, repoFullName, prNumber },
  });

  // Check if all tasks are pushed → fire integration worker
  const ready = await checkIntegrationReady(jobId);
  if (ready) {
    const queues = getQueues();
    await queues.integration.add(
      "run-integration",
      { jobId: String(orcJob._id) },
      { jobId: `integration-${orcJob._id}` },
    );
    console.log(`[push-worker] all tasks pushed for job=${jobId} — enqueued integration`);
  }

  await bullJob.updateProgress(100);
  return { branchName, prNumber, pushed: true };
};

const worker = new Worker("push", processor, {
  connection: getRedis(),
  concurrency: 3,
});

worker.on("failed", async (bullJob, err) => {
  const { jobId, taskId } = bullJob?.data ?? {};
  console.error(`[push-worker] failed jobId=${jobId}:`, err.message);
  if (taskId) {
    try {
      await Task.findByIdAndUpdate(taskId, {
        status: "quality_failed",
        errorMessage: `Push failed: ${err.message}`,
      });
    } catch {}
  }
  if (jobId) {
    try {
      await Job.findByIdAndUpdate(jobId, {
        status: "failed",
        errorMessage: `Push failed: ${err.message}`,
      });
    } catch {}
  }
});

worker.on("completed", (bullJob, result) => {
  console.log(`[push-worker] completed bull=${bullJob.id} — pushed=${result?.pushed ?? false}`);
});

console.log("[push-worker] ready (concurrency: 3)");
