/**
 * Deploy Worker — Autonomous Pipeline
 *
 * Queue: "deploy"
 * Job name: "run-deploy"
 * Job data: { jobId: string, projectId?: string }
 *
 * Triggered after the integration branch is merged to main (by pr-poll worker).
 * Calls the configured deployment webhook and polls the health check URL.
 * Updates project status and all PMS tasks to "done" on success.
 *
 * Security:
 *  - Only calls the URL configured by the Admin in Project.deployConfig
 *  - Never executes arbitrary commands from task descriptions
 */
import { Worker } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { connectDb } from "../lib/db.js";
import Job from "../models/Job.js";
import Task from "../models/Task.js";
import Project from "../models/Project.js";
import { pmsClient } from "../lib/pmsClient.js";
import { audit } from "../lib/audit.js";

await connectDb();

const HEALTH_POLL_INTERVAL_MS = 10_000;
const HEALTH_POLL_MAX_ATTEMPTS = 30; // 5 minutes total

async function triggerDeployment(webhookUrl) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "AI-Orchestrator/1.0" },
    body: JSON.stringify({ event: "deploy", triggeredBy: "AI Orchestrator" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Webhook responded ${res.status}: ${body.slice(0, 200)}`);
  }
  return true;
}

async function pollHealthCheck(healthUrl, maxAttempts) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
    try {
      const res = await fetch(healthUrl, { method: "GET" });
      if (res.ok) return true;
    } catch {}
    console.log(`[deploy-worker] health check attempt ${i + 1}/${maxAttempts} — not ready`);
  }
  return false;
}

const processor = async (bullJob) => {
  const { jobId, projectId } = bullJob.data;
  console.log(`[deploy-worker] start jobId=${jobId}`);

  const orcJob = await Job.findById(jobId);
  if (!orcJob) throw new Error(`Job ${jobId} not found`);

  // Load project for deploy configuration
  const project = projectId
    ? await Project.findById(projectId)
    : await Project.findOne({ pmsProjectId: orcJob.pmsProjectId });

  await Job.findByIdAndUpdate(jobId, { status: "deploying", stage: 10 });
  await bullJob.updateProgress(10);

  if (!project?.deployConfig?.enabled || project.deployConfig.provider === "none") {
    console.log(`[deploy-worker] deploy not configured for job=${jobId} — marking done`);
    await Job.findByIdAndUpdate(jobId, { status: "deployed", stage: 10 });
    await markTasksDone(orcJob);
    return { skipped: true };
  }

  // Trigger deployment webhook
  if (project.deployConfig.webhookUrl) {
    try {
      await triggerDeployment(project.deployConfig.webhookUrl);
      console.log(`[deploy-worker] triggered deployment webhook`);
    } catch (err) {
      throw new Error(`Deployment trigger failed: ${err.message}`);
    }
  }

  await bullJob.updateProgress(30);

  // Poll health check if configured
  if (project.deployConfig.healthCheckUrl) {
    const healthy = await pollHealthCheck(project.deployConfig.healthCheckUrl, HEALTH_POLL_MAX_ATTEMPTS);
    if (!healthy) {
      throw new Error(`Deployment health check failed after ${HEALTH_POLL_MAX_ATTEMPTS} attempts`);
    }
    console.log(`[deploy-worker] deployment health check passed`);
  }

  await bullJob.updateProgress(80);

  // Mark job and project done
  await Job.findByIdAndUpdate(jobId, { status: "deployed", stage: 10 });

  if (project) {
    await Project.findByIdAndUpdate(project._id, { status: "done", completionPct: 100 });
  }

  await markTasksDone(orcJob);

  audit("system", "deploy.completed", {
    jobId: orcJob._id,
    details: { projectId: project?._id },
  });

  await bullJob.updateProgress(100);
  console.log(`[deploy-worker] deployment complete for job=${jobId}`);
  return { deployed: true };
};

async function markTasksDone(orcJob) {
  const tasks = await Task.find({ jobId: orcJob._id, status: { $in: ["pushed", "pr_open", "merged"] } });
  if (tasks.length === 0) return;

  await Task.updateMany(
    { jobId: orcJob._id, status: { $in: ["pushed", "pr_open"] } },
    { status: "merged" },
  );

  // Update PMS tasks to done
  try {
    await pmsClient.ensureSession();
    for (const task of tasks) {
      if (task.pmsTaskId) {
        await pmsClient.moveTask(task.pmsTaskId, "done").catch(() => {});
      }
    }
  } catch (err) {
    console.warn(`[deploy-worker] PMS task update failed: ${err.message}`);
  }
}

const worker = new Worker("deploy", processor, {
  connection: getRedis(),
  concurrency: 1,
});

worker.on("failed", async (bullJob, err) => {
  const { jobId } = bullJob?.data ?? {};
  console.error(`[deploy-worker] failed jobId=${jobId}:`, err.message);
  if (jobId) {
    try {
      await Job.findByIdAndUpdate(jobId, {
        status: "failed",
        errorMessage: `Deployment failed: ${err.message}`,
      });
    } catch {}
  }
});

worker.on("completed", (bullJob, result) => {
  console.log(`[deploy-worker] completed bull=${bullJob.id} — deployed=${result?.deployed ?? false}`);
});

console.log("[deploy-worker] ready (concurrency: 1)");
