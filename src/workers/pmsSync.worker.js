/**
 * PMS Sync Worker — Phase 3
 *
 * Job name: "create-tasks"
 * Job data: { jobId: string, pmsProjectId: string, tasks: [...] }
 *
 * Steps:
 *  1. Load the Job from MongoDB
 *  2. Verify the PMS service account session
 *  3. Load the PMS project (need the project object for insertTask)
 *  4. For each approved task: call POST /api/tasks (reporter = service account user)
 *  5. Store the returned PMS task IDs on the Job
 *  6. Advance job status → awaiting_assignment (Stage 5)
 *
 * Title constraints from verified PMS code (src/models/Task.js):
 *   title: max 140 chars, required
 *   description: string
 *   priority: urgent|high|medium|low
 *   type: task|bug|feature|improvement
 *   source: string (links back to orchestrator job for traceability)
 *   reporter: service account user _id (set by PMS from req.user._id)
 *   assignee: null (Team Lead assigns in PMS — Stage 5)
 *
 * WIP limit: does NOT apply at task creation (only on todo → in_progress transition).
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

const processor = async (bullJob) => {
  const { jobId, pmsProjectId, tasks } = bullJob.data;
  console.log(`[pms-sync-worker] creating ${tasks.length} tasks in PMS project ${pmsProjectId} for job=${jobId}`);

  const orcJob = await Job.findById(jobId);
  if (!orcJob) throw new Error(`Job ${jobId} not found`);

  // Ensure PMS session is live before starting
  await pmsClient.ensureSession();
  await bullJob.updateProgress(5);

  const createdTaskIds = [];
  const taskDocsToInsert = [];
  const errors = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    await bullJob.updateProgress(5 + Math.floor((i / tasks.length) * 80));

    try {
      const pmsTask = await pmsClient.createTask({
        projectId: pmsProjectId,
        title: task.title,
        description: task.description ?? "",
        priority: task.priority,
        type: task.type,
        points: task.points ?? undefined,
        source: `ai-orchestrator:job/${jobId}:req:${(task.requirementIds ?? []).join(",")}`,
      });

      const pmsTaskId = pmsTask._id ?? pmsTask.id;
      createdTaskIds.push(pmsTaskId);
      taskDocsToInsert.push({
        jobId: orcJob._id,
        pmsTaskId,
        title: task.title,
        description: task.description ?? "",
        type: task.type ?? "task",
        priority: task.priority ?? "medium",
        points: task.points ?? undefined,
        requirementIds: task.requirementIds ?? [],
        taskArea: task.taskArea ?? "fullstack",
        status: "pending",
        repoFullName: orcJob.repoFullName,
      });
      console.log(`[pms-sync-worker] created PMS task ${pmsTaskId}: "${task.title}"`);
    } catch (err) {
      console.error(`[pms-sync-worker] failed to create task "${task.title}":`, err.message);
      errors.push({ title: task.title, error: err.message });
    }
  }

  if (createdTaskIds.length === 0) {
    throw new Error(`All ${tasks.length} task creation(s) failed in PMS. Errors: ${errors.map((e) => e.error).join("; ")}`);
  }

  await bullJob.updateProgress(85);

  // Create Task documents in orchestrator DB
  if (taskDocsToInsert.length > 0) {
    await Task.insertMany(taskDocsToInsert);
    console.log(`[pms-sync-worker] created ${taskDocsToInsert.length} Task document(s) in orchestrator DB`);
  }

  await bullJob.updateProgress(90);

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

  await bullJob.updateProgress(95);

  // Auto-fire assignment engine (Phase 2)
  const queues = getQueues();
  await queues.taskAssign.add(
    "assign-tasks",
    { jobId: String(orcJob._id) },
    { jobId: `taskassign:${orcJob._id}` },
  );
  console.log(`[pms-sync-worker] enqueued task-assign for job=${jobId}`);

  await bullJob.updateProgress(100);
  console.log(`[pms-sync-worker] done job=${jobId}: ${createdTaskIds.length} tasks created, ${errors.length} failed`);
  return { created: createdTaskIds.length, failed: errors.length, pmsTaskIds: createdTaskIds };
};

const worker = new Worker("pms-sync", processor, {
  connection: getRedis(),
  concurrency: 3,
});

worker.on("failed", async (bullJob, err) => {
  console.error(`[pms-sync-worker] failed job=${bullJob?.data?.jobId}:`, err.message);
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
  console.log(`[pms-sync-worker] completed bull=${bullJob.id} — ${result?.created ?? 0} tasks created`);
});

console.log("[pms-sync-worker] ready");
