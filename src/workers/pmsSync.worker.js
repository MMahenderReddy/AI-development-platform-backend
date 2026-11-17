/**
 * PMS Sync Worker — Phase 3
 *
 * Job name: "create-tasks"
 * Job data: { jobId: string, pmsProjectId: string, tasks: [...] }
 *
 * Steps:
 *  1. Load the Job from MongoDB
 *  2. Verify the PMS service account session
 *  3. For each approved task:
 *       a. Check whether a PMS task with the same source key already exists
 *          (idempotency — safe to retry on transient failures)
 *       b. If not found, call POST /api/tasks/ai-create; if found, reuse its ID
 *  4. Upsert orchestrator Task documents (findOneAndUpdate + upsert)
 *     so retries never create duplicate rows in the orchestrator DB either
 *  5. Store the returned PMS task IDs on the Job
 *  6. Advance job status → awaiting_assignment (Stage 5)
 */
import { Worker } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { connectDb } from "../lib/db.js";
import { pmsClient } from "../lib/pmsClient.js";
import { audit } from "../lib/audit.js";
import Job from "../models/Job.js";
import Task from "../models/Task.js";
import { getQueues } from "../lib/queues.js";

await connectDb();

const sep = "=".repeat(50);

const processor = async (bullJob) => {
  const { jobId, pmsProjectId, tasks } = bullJob.data;

  console.log(`\n${sep}`);
  console.log(`[pms-sync-worker] ===== PMS TASK CREATION STARTED =====`);
  console.log(`[pms-sync-worker] Job ID:      ${jobId}`);
  console.log(`[pms-sync-worker] PMS Project: ${pmsProjectId}`);
  console.log(`[pms-sync-worker] Tasks to create: ${tasks.length}`);
  console.log(`[pms-sync-worker] Time:         ${new Date().toISOString()}`);
  console.log(`${sep}`);

  console.log(`\n[pms-sync-worker] TASKS TO CREATE:`);
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    console.log(`[pms-sync-worker]   ${i + 1}. "${t.title}"`);
    console.log(`[pms-sync-worker]      type=${t.type} priority=${t.priority} area=${t.taskArea} points=${t.points ?? "?"} estHours=${t.estimatedHours ?? "?"}h`);
    console.log(`[pms-sync-worker]      reqs=[${(t.requirementIds ?? []).join(", ")}]`);
    if (t.description) {
      console.log(`[pms-sync-worker]      desc: ${t.description.slice(0, 100)}${t.description.length > 100 ? "…" : ""}`);
    }
  }

  const orcJob = await Job.findById(jobId);
  if (!orcJob) throw new Error(`Job ${jobId} not found`);

  // Ensure PMS session is live before starting
  console.log(`\n[pms-sync-worker] Verifying PMS session...`);
  await pmsClient.ensureSession();
  console.log(`[pms-sync-worker] ✓ PMS session active`);
  await bullJob.updateProgress(5);

  const createdTaskIds = [];
  const errors = [];
  const taskResults = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    await bullJob.updateProgress(5 + Math.floor((i / tasks.length) * 80));

    const sourceKey = `ai-orchestrator:job/${jobId}:req:${(task.requirementIds ?? []).join(",")}:${i}`;
    console.log(`\n[pms-sync-worker] [${i + 1}/${tasks.length}] "${task.title}"`);
    console.log(`[pms-sync-worker]   source key: ${sourceKey}`);

    let pmsTaskId;
    try {
      // Check whether this task was already created on a previous attempt
      let existingPmsTask = null;
      try {
        existingPmsTask = await pmsClient.getTaskBySource(sourceKey);
      } catch {
        // getTaskBySource is best-effort
      }

      if (existingPmsTask) {
        pmsTaskId = existingPmsTask._id ?? existingPmsTask.id;
        console.log(`[pms-sync-worker]   ↩ Reusing existing PMS task: ${pmsTaskId}`);
      } else {
        const dueDate = task.estimatedHours
          ? new Date(Date.now() + task.estimatedHours * 3_600_000).toISOString()
          : undefined;

        console.log(`[pms-sync-worker]   Creating in PMS...`);
        if (dueDate) console.log(`[pms-sync-worker]   dueDate: ${dueDate}`);

        const pmsTask = await pmsClient.createTask({
          projectId: pmsProjectId,
          title: task.title,
          description: task.description ?? "",
          priority: task.priority,
          type: task.type,
          points: task.points ?? undefined,
          source: sourceKey,
          ...(dueDate ? { dueDate } : {}),
        });
        pmsTaskId = pmsTask._id ?? pmsTask.id;
        console.log(`[pms-sync-worker]   ✓ PMS task created: ${pmsTaskId}`);
      }

      createdTaskIds.push(pmsTaskId);

      // Upsert orchestrator Task document
      const taskDoc = {
        jobId: orcJob._id,
        title: task.title,
        description: task.description ?? "",
        type: task.type ?? "task",
        priority: task.priority ?? "medium",
        points: task.points ?? undefined,
        estimatedHours: task.estimatedHours ?? undefined,
        requirementIds: task.requirementIds ?? [],
        taskArea: task.taskArea ?? "fullstack",
        repoFullName: orcJob.repoFullName,
      };
      await Task.findOneAndUpdate(
        { jobId: orcJob._id, pmsTaskId },
        { $setOnInsert: { ...taskDoc, pmsTaskId, status: "pending" } },
        { upsert: true, new: true },
      );

      taskResults.push({
        index: i + 1,
        title: task.title,
        priority: task.priority,
        type: task.type,
        area: task.taskArea,
        estimatedHours: task.estimatedHours,
        pmsTaskId,
        status: "SUCCESS",
      });
    } catch (err) {
      console.error(`[pms-sync-worker]   ✗ FAILED: ${err.message}`);
      errors.push({ title: task.title, error: err.message });
      taskResults.push({
        index: i + 1,
        title: task.title,
        priority: task.priority,
        type: task.type,
        area: task.taskArea,
        estimatedHours: task.estimatedHours,
        pmsTaskId: null,
        status: "FAILED",
        error: err.message,
      });
    }
  }

  if (createdTaskIds.length === 0) {
    throw new Error(`All ${tasks.length} task creation(s) failed in PMS. Errors: ${errors.map((e) => e.error).join("; ")}`);
  }

  await bullJob.updateProgress(85);

  // Persist PMS task IDs on the job
  orcJob.pmsTaskIds = createdTaskIds;
  orcJob.status = "awaiting_assignment";
  orcJob.stage = 5;

  if (errors.length > 0) {
    orcJob.errorMessage = `${errors.length} task(s) failed to create: ${errors.map((e) => `"${e.title}"`).join(", ")}`;
  }

  await orcJob.save();

  audit("system", "pms.tasks.created", {
    jobId: orcJob._id,
    details: {
      created: createdTaskIds.length,
      failed: errors.length,
      pmsTaskIds: createdTaskIds,
    },
  });

  await bullJob.updateProgress(90);

  // Auto-fire assignment engine
  const queues = getQueues();
  await queues.taskAssign.add(
    "assign-tasks",
    { jobId: String(orcJob._id) },
    { jobId: `taskassign-${orcJob._id}` },
  );

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${sep}`);
  console.log(`[pms-sync-worker] ===== PMS TASK CREATION SUMMARY =====`);
  console.log(`${sep}`);
  console.log(`\n  TASK CREATION RESULTS:`);

  for (const r of taskResults) {
    const icon = r.status === "SUCCESS" ? "✓" : "✗";
    console.log(`\n  ${icon} [${r.index}/${tasks.length}] ${r.pmsTaskId ?? "N/A"} — "${r.title}"`);
    console.log(`      priority=${r.priority} type=${r.type} area=${r.area} hours=${r.estimatedHours ?? "?"}h`);
    console.log(`      Status: ${r.status}${r.error ? ` — ${r.error}` : ""}`);
  }

  console.log(`\n  TOTALS`);
  console.log(`  Total tasks requested: ${tasks.length}`);
  console.log(`  Successfully created:  ${createdTaskIds.length}`);
  console.log(`  Failed:                ${errors.length}`);
  console.log(`  PMS Task IDs:          ${createdTaskIds.join(", ")}`);
  console.log(`\n  Job status → awaiting_assignment (stage 5)`);
  console.log(`  ✓ Enqueued task-assign worker for job=${jobId}`);
  console.log(`${sep}\n`);

  await bullJob.updateProgress(100);
  return { created: createdTaskIds.length, failed: errors.length, pmsTaskIds: createdTaskIds };
};

const worker = new Worker("pms-sync", processor, {
  connection: getRedis(),
  concurrency: 3,
});

worker.on("failed", async (bullJob, err) => {
  console.error(`[pms-sync-worker] ✗ FAILED job=${bullJob?.data?.jobId}: ${err.message}`);
  if (bullJob?.data?.jobId) {
    try {
      await Job.findByIdAndUpdate(bullJob.data.jobId, {
        status: "failed",
        errorMessage: `PMS sync failed: ${err.message}`,
      });
    } catch (dbErr) {
      console.error("[pms-sync-worker] could not update job status:", dbErr.message);
    }
  }
});

worker.on("completed", (bullJob, result) => {
  console.log(`[pms-sync-worker] ✓ Completed bull=${bullJob.id} — ${result?.created ?? 0} tasks created`);
});

console.log("[pms-sync-worker] ready");
