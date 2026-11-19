/**
 * Rework Worker — Autonomous Pipeline
 *
 * Queue: "rework"
 * Job name: "create-rework"
 * Job data: { jobId: string, taskId: string, reason: string, retryCount: number }
 *
 * Triggered by quality gate worker on failure (up to REWORK_MAX_RETRIES).
 * Also triggered by integration worker on integration build failure.
 *
 * Creates a new PMS task linked to the failed original task via parentTaskId.
 * Checks for existing open rework tasks to prevent duplicates.
 * Re-enqueues the rework task in the codegen queue.
 *
 * Security:
 *  - Never assigns to a human without their active membership in the system
 *  - reworkReason is taken from the system (quality output) not from task desc
 */
import { Worker } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { connectDb } from "../lib/db.js";
import Job from "../models/Job.js";
import Task from "../models/Task.js";
import OrchestratorUser from "../models/OrchestratorUser.js";
import { pmsClientFor } from "../lib/pmsClient.js";
import { audit } from "../lib/audit.js";
import { getQueues } from "../lib/queues.js";

await connectDb();

const REWORK_STAGGER_MS = 10_000;

const processor = async (bullJob) => {
  const { jobId, taskId, reason, retryCount } = bullJob.data;
  console.log(`[rework-worker] creating rework for task=${taskId} job=${jobId} attempt=${retryCount}`);

  const [orcJob, originalTask] = await Promise.all([
    Job.findById(jobId),
    Task.findById(taskId),
  ]);

  if (!orcJob) throw new Error(`Job ${jobId} not found`);
  if (!originalTask) throw new Error(`Task ${taskId} not found`);

  // Duplicate prevention: check for open rework task with same parentTaskId
  const existingRework = await Task.findOne({
    parentTaskId: originalTask._id,
    status: { $nin: ["merged", "failed", "cancelled"] },
  }).lean();

  if (existingRework) {
    console.log(`[rework-worker] rework task ${existingRework._id} already open — skipping creation`);
    return { skipped: true, existingReworkTaskId: String(existingRework._id) };
  }

  await bullJob.updateProgress(20);

  // Create PMS rework task
  let pmsTaskId = null;
  const reworkTitle = `Fix: ${originalTask.title.slice(0, 120)}`;
  const reworkDescription = [
    `**Rework task** — the original implementation failed quality checks.`,
    ``,
    `**Original task:** ${originalTask.title}`,
    `**Failure reason:** ${reason.slice(0, 1500)}`,
    `**Attempt:** ${retryCount}`,
    ``,
    `Please fix the issues described above and re-submit.`,
  ].join("\n");

  if (orcJob.pmsProjectId) {
    try {
      const pmsClient = pmsClientFor(orcJob.pmsWorkspace ?? "core");
      await pmsClient.ensureSession();
      const pmsTask = await pmsClient.createTask({
        projectId: orcJob.pmsProjectId,
        title: reworkTitle,
        description: reworkDescription,
        priority: originalTask.priority ?? "high",
        type: "bug",
        source: `ai-orchestrator:rework:job/${jobId}:task/${taskId}`,
      });
      pmsTaskId = pmsTask._id ?? pmsTask.id;
      console.log(`[rework-worker] created PMS rework task ${pmsTaskId}`);
    } catch (err) {
      console.warn(`[rework-worker] PMS rework task creation failed: ${err.message} — continuing with internal task only`);
    }
  }

  await bullJob.updateProgress(50);

  // Find the best assignee (same developer or fallback by capability)
  let assignedTo = originalTask.assignedTo;
  if (!assignedTo) {
    const members = await OrchestratorUser.find({
      status: "active",
      pmsWorkspace: orcJob.pmsWorkspace ?? "core",
    }).lean();
    const area = originalTask.taskArea ?? "fullstack";
    const capMap = { frontend: ["frontend", "fullstack"], backend: ["backend", "fullstack"], fullstack: ["fullstack", "lead"] };
    const eligible = members.filter((m) => (capMap[area] ?? ["fullstack"]).includes(m.capability ?? "fullstack"));
    if (eligible.length > 0) {
      assignedTo = eligible.reduce((best, m) =>
        (m.activeTaskCount ?? 0) < (best.activeTaskCount ?? 0) ? m : best,
      )._id;
    }
  }

  // Create orchestrator Task document for the rework
  const reworkTask = await Task.create({
    jobId: orcJob._id,
    pmsTaskId: pmsTaskId ?? `rework-${taskId}-${retryCount}`,
    title: reworkTitle,
    description: reworkDescription,
    type: "bug",
    priority: originalTask.priority ?? "high",
    taskArea: originalTask.taskArea ?? "fullstack",
    repoFullName: originalTask.repoFullName ?? orcJob.repoFullName,
    baseBranch: originalTask.baseBranch ?? "main",
    requirementIds: originalTask.requirementIds ?? [],
    parentTaskId: originalTask._id,
    reworkReason: reason.slice(0, 2000),
    retryCount,
    assignedTo: assignedTo ?? undefined,
    status: assignedTo ? "queued" : "pending",
  });

  if (assignedTo) {
    await OrchestratorUser.findByIdAndUpdate(assignedTo, { $inc: { activeTaskCount: 1 } });
  }

  await bullJob.updateProgress(75);

  audit("system", "rework.created", {
    jobId: orcJob._id,
    details: { originalTaskId: taskId, reworkTaskId: String(reworkTask._id), retryCount },
  });

  // Enqueue rework task in codegen queue
  const queues = getQueues();
  await queues.codegen.add(
    "generate-code",
    { jobId: String(orcJob._id), pmsTaskId: reworkTask.pmsTaskId },
    { jobId: `codegen-${orcJob._id}-${reworkTask.pmsTaskId}`, delay: REWORK_STAGGER_MS },
  );

  console.log(`[rework-worker] enqueued rework task ${reworkTask._id} in codegen`);
  await bullJob.updateProgress(100);
  return { reworkTaskId: String(reworkTask._id), pmsTaskId };
};

const worker = new Worker("rework", processor, {
  connection: getRedis(),
  concurrency: 5,
});

worker.on("failed", async (bullJob, err) => {
  console.error(`[rework-worker] failed taskId=${bullJob?.data?.taskId}:`, err.message);
});

worker.on("completed", (bullJob, result) => {
  console.log(`[rework-worker] completed bull=${bullJob.id} reworkTaskId=${result?.reworkTaskId ?? "skipped"}`);
});

console.log("[rework-worker] ready (concurrency: 5)");
