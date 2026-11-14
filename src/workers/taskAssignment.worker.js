/**
 * Task Assignment Worker — Phase 2
 *
 * Queue: "task-assign"
 * Job name: "assign-tasks"
 * Job data: { jobId: string }
 *
 * Triggered automatically by pmsSync.worker after all PMS tasks are created.
 * Also triggered manually from routes/jobs.js start-codegen as a fallback.
 *
 * Flow:
 *  1. Mark job → auto_assigning (stage 5 stays)
 *  2. Call scheduleTasks() — skill-based assignment + stagger dispatch to codegen queue
 *  3. Mark job → generating (stage 6) if tasks were dispatched
 *  4. Fall back to awaiting_assignment (manual path) if no active members or no tasks
 *
 * Security note: tasks are NEVER dispatched to production branches directly.
 * All codegen jobs create a new branch per the locked-in architecture.
 * Auto-merging is never triggered by this worker.
 */
import { Worker } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { connectDb } from "../lib/db.js";
import Job from "../models/Job.js";
import { scheduleTasks } from "../lib/scheduler.js";
import { audit } from "../lib/audit.js";

await connectDb();

const processor = async (bullJob) => {
  const { jobId } = bullJob.data;
  console.log(`[task-assign-worker] starting assignment for job=${jobId}`);

  const orcJob = await Job.findById(jobId);
  if (!orcJob) {
    console.warn(`[task-assign-worker] job ${jobId} not found — stopping`);
    return { stopped: "job_not_found" };
  }

  if (!["awaiting_assignment", "auto_assigning"].includes(orcJob.status)) {
    console.warn(
      `[task-assign-worker] job ${jobId} in unexpected status "${orcJob.status}" — skipping`,
    );
    return { stopped: orcJob.status };
  }

  // Mark in-progress so the UI shows the auto-assigning state
  await Job.findByIdAndUpdate(jobId, { status: "auto_assigning" });
  await bullJob.updateProgress(10);

  const result = await scheduleTasks(jobId);
  await bullJob.updateProgress(90);

  if (result.dispatched > 0) {
    await Job.findByIdAndUpdate(jobId, { status: "generating", stage: 6 });
    console.log(
      `[task-assign-worker] job=${jobId}: ${result.dispatched} task(s) queued — job → generating`,
    );
  } else {
    // No active members configured — fall back gracefully to manual path
    await Job.findByIdAndUpdate(jobId, {
      status: "awaiting_assignment",
      errorMessage:
        "Auto-assignment found no active team members. " +
        'Add members in the Team page, then use "Start Code Generation" manually.',
    });
    console.warn(
      `[task-assign-worker] job=${jobId}: no tasks dispatched — reverted to awaiting_assignment`,
    );
  }

  audit("system", "tasks.assigned", {
    jobId: orcJob._id,
    details: { assigned: result.assigned, dispatched: result.dispatched },
  });

  await bullJob.updateProgress(100);
  return result;
};

const worker = new Worker("task-assign", processor, {
  connection: getRedis(),
  concurrency: 3,
});

worker.on("failed", async (bullJob, err) => {
  const { jobId } = bullJob?.data ?? {};
  console.error(`[task-assign-worker] failed job=${jobId}:`, err.message);
  if (jobId) {
    try {
      await Job.findByIdAndUpdate(jobId, {
        status: "awaiting_assignment",
        errorMessage: `Auto-assignment failed: ${err.message}. Use "Start Code Generation" to assign manually.`,
      });
    } catch (dbErr) {
      console.error("[task-assign-worker] could not update job status:", dbErr.message);
    }
  }
});

worker.on("completed", (bullJob, result) => {
  console.log(
    `[task-assign-worker] completed bull=${bullJob.id} — assigned=${result?.assigned ?? 0} dispatched=${result?.dispatched ?? 0}`,
  );
});

console.log("[task-assign-worker] ready (concurrency: 3)");
