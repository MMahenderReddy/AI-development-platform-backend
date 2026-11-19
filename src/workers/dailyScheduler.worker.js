/**
 * Daily Scheduler Worker
 *
 * Queue: "daily-scheduler"
 * Job name: "run-daily" (triggered by BullMQ repeatable job, every day at 08:00)
 *
 * On each run:
 *  1. Find all tasks with status="assigned" and scheduledDate <= today
 *  2. Skip any task whose dependsOn tasks are not yet merged/pushed
 *  3. Dispatch eligible tasks to the codegen queue
 *  4. Find overdue tasks (dueDate < today, still generating/queued) and log warnings
 *  5. For delayed tasks, shift their dueDate forward and update dependent tasks
 */
import { Worker, Queue } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { connectDb } from "../lib/db.js";
import Task from "../models/Task.js";
import Job from "../models/Job.js";
import { getQueues } from "../lib/queues.js";
import { audit } from "../lib/audit.js";

await connectDb();

const sep = "=".repeat(50);

// Terminal statuses that mean a task's work is on GitHub
const DONE_STATUSES = new Set(["pushed", "pr_open", "merged"]);
// Statuses that mean a task is still running (not failed/cancelled)
const ACTIVE_STATUSES = new Set(["queued", "generating", "quality_gate", "quality_failed", "awaiting_push"]);

/**
 * Check whether all tasks in `dependsOn[]` are in a done state.
 */
async function dependenciesMet(task) {
  if (!task.dependsOn || task.dependsOn.length === 0) return true;
  const deps = await Task.find({ _id: { $in: task.dependsOn } }).lean();
  return deps.every((d) => DONE_STATUSES.has(d.status));
}

/**
 * Shift a task's dueDate forward by `days` working days.
 * Also recursively shifts downstream dependents.
 */
async function shiftDueDate(taskId, days, visited = new Set()) {
  if (visited.has(String(taskId))) return;
  visited.add(String(taskId));

  const task = await Task.findById(taskId).lean();
  if (!task || !task.dueDate) return;

  const newDue = new Date(task.dueDate);
  let added = 0;
  while (added < days) {
    newDue.setDate(newDue.getDate() + 1);
    if (newDue.getDay() !== 0 && newDue.getDay() !== 6) added++;
  }

  await Task.findByIdAndUpdate(taskId, { dueDate: newDue });
  console.log(`[daily-scheduler]   ↻ Shifted dueDate for "${task.title.slice(0, 50)}" → ${newDue.toISOString().slice(0, 10)}`);

  // Cascade to downstream tasks
  const downstream = await Task.find({ dependsOn: taskId, status: { $in: ["pending", "assigned"] } }).lean();
  for (const d of downstream) {
    await shiftDueDate(d._id, days, visited);
  }
}

const processor = async (bullJob) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);

  console.log(`\n${sep}`);
  console.log(`[daily-scheduler] ===== DAILY SCHEDULER RUN =====`);
  console.log(`[daily-scheduler] Date: ${todayStr}`);
  console.log(`[daily-scheduler] Time: ${new Date().toISOString()}`);
  console.log(`${sep}`);

  const queues = getQueues();
  let dispatched = 0;
  let blocked = 0;
  let overdueCount = 0;

  // ── 1. Dispatch today's scheduled tasks ────────────────────────────────────
  const todaysTasks = await Task.find({
    status: "assigned",
    scheduledDate: { $lte: new Date(today.getTime() + 86_400_000 - 1) }, // <= end of today
  }).lean();

  console.log(`\n[daily-scheduler] Tasks scheduled for today or overdue: ${todaysTasks.length}`);

  const staggerMs = 30_000;

  for (const task of todaysTasks) {
    const met = await dependenciesMet(task);
    if (!met) {
      console.log(`[daily-scheduler]   ⏳ BLOCKED [${task.pmsTaskId}] "${task.title.slice(0, 60)}" — waiting for dependencies`);
      blocked++;
      continue;
    }

    // Dispatch to codegen
    await Task.findByIdAndUpdate(task._id, { status: "queued" });

    const delay = dispatched * staggerMs;
    await queues.codegen.add(
      "generate-code",
      { jobId: String(task.jobId), pmsTaskId: task.pmsTaskId },
      { jobId: `codegen-${task.jobId}-${task.pmsTaskId}-${todayStr}`, delay },
    );

    console.log(`[daily-scheduler]   🚀 Dispatched [${task.pmsTaskId}] "${task.title.slice(0, 60)}" (delay ${delay}ms)`);
    dispatched++;
  }

  // ── 2. Detect overdue tasks and shift dependent due dates ─────────────────
  const overdueTasks = await Task.find({
    status: { $in: [...ACTIVE_STATUSES] },
    dueDate: { $lt: today },
  }).lean();

  if (overdueTasks.length > 0) {
    console.log(`\n[daily-scheduler] ⚠ Overdue tasks: ${overdueTasks.length}`);
    for (const task of overdueTasks) {
      const daysLate = Math.ceil((today - new Date(task.dueDate)) / 86_400_000);
      console.log(`[daily-scheduler]   ⚠ [${task.pmsTaskId}] "${task.title.slice(0, 60)}" — ${daysLate} day(s) late`);

      // Shift downstream dependents by 1 working day per late day (capped at 3)
      const shift = Math.min(daysLate, 3);
      const downstream = await Task.find({ dependsOn: task._id, status: { $in: ["pending", "assigned"] } }).lean();
      for (const d of downstream) {
        await shiftDueDate(d._id, shift);
      }
      overdueCount++;
    }
  }

  // ── 3. Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${sep}`);
  console.log(`[daily-scheduler] SUMMARY for ${todayStr}`);
  console.log(`  Dispatched to codegen: ${dispatched}`);
  console.log(`  Blocked by deps:       ${blocked}`);
  console.log(`  Overdue tasks found:   ${overdueCount}`);
  console.log(`${sep}\n`);

  audit("system", "daily.scheduler.run", {
    details: { date: todayStr, dispatched, blocked, overdueCount },
  });

  await bullJob.updateProgress(100);
  return { dispatched, blocked, overdueCount };
};

const worker = new Worker("daily-scheduler", processor, {
  connection: getRedis(),
  concurrency: 1,
});

worker.on("failed", (bullJob, err) => {
  console.error(`[daily-scheduler] FAILED: ${err.message}`);
});

worker.on("completed", (bullJob, result) => {
  console.log(`[daily-scheduler] ✓ Completed — dispatched=${result?.dispatched ?? 0} blocked=${result?.blocked ?? 0}`);
});

// ── Schedule repeatable daily run at 08:00 server time ─────────────────────
const schedulerQueue = new Queue("daily-scheduler", { connection: getRedis() });

// Remove any old repeat jobs first (idempotent restart)
const repeatableJobs = await schedulerQueue.getRepeatableJobs();
for (const j of repeatableJobs) {
  if (j.name === "run-daily") await schedulerQueue.removeRepeatableByKey(j.key);
}

// Register the repeating cron job (Mon–Fri 08:00)
await schedulerQueue.add(
  "run-daily",
  {},
  { repeat: { pattern: "0 8 * * 1-5" } },
);

// Also run immediately on startup so today's tasks are dispatched without waiting for 08:00
await schedulerQueue.add(
  "run-daily",
  {},
  { jobId: `daily-startup-${Date.now()}`, delay: 5_000 }, // 5s delay so worker is fully ready
);

console.log("[daily-scheduler] ready — auto-runs at startup + Mon–Fri 08:00");
