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
 */
import { Worker } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { connectDb } from "../lib/db.js";
import Job from "../models/Job.js";
import Task from "../models/Task.js";
import OrchestratorUser from "../models/OrchestratorUser.js";
import RepoMapping from "../models/RepoMapping.js";
import { scheduleTasks } from "../lib/scheduler.js";
import { audit } from "../lib/audit.js";

await connectDb();

const sep = "=".repeat(50);

const processor = async (bullJob) => {
  const { jobId } = bullJob.data;

  console.log(`\n${sep}`);
  console.log(`[task-assign-worker] ===== TASK ASSIGNMENT WORKER STARTED =====`);
  console.log(`[task-assign-worker] Job ID: ${jobId}`);
  console.log(`[task-assign-worker] Time:   ${new Date().toISOString()}`);
  console.log(`${sep}`);

  const orcJob = await Job.findById(jobId);
  if (!orcJob) {
    console.warn(`[task-assign-worker] Job ${jobId} not found — stopping`);
    return { stopped: "job_not_found" };
  }

  console.log(`[task-assign-worker] Job status: ${orcJob.status} | PMS project: ${orcJob.pmsProjectId}`);
  console.log(`[task-assign-worker] PMS task IDs: ${(orcJob.pmsTaskIds ?? []).join(", ") || "(none yet)"}`);

  if (!["awaiting_assignment", "auto_assigning"].includes(orcJob.status)) {
    console.warn(`[task-assign-worker] Unexpected job status "${orcJob.status}" — skipping`);
    return { stopped: orcJob.status };
  }

  // Mark in-progress
  await Job.findByIdAndUpdate(jobId, { status: "auto_assigning" });
  await bullJob.updateProgress(10);

  // ── Step 1: Show pending tasks ────────────────────────────────────────────
  const pendingTasks = await Task.find({ jobId: orcJob._id, status: "pending" });
  console.log(`\n[task-assign-worker] STEP 1 — Pending tasks in orchestrator DB: ${pendingTasks.length}`);
  for (const t of pendingTasks) {
    console.log(`[task-assign-worker]   • [${t.pmsTaskId}] "${t.title}" | ${t.priority} | ${t.taskArea} | ${t.type}`);
  }

  // ── Step 2: Show active team members ──────────────────────────────────────
  const activeMembers = await OrchestratorUser.find({ status: "active" }).lean();
  console.log(`\n[task-assign-worker] STEP 2 — Active orchestrator team members: ${activeMembers.length}`);
  if (activeMembers.length === 0) {
    console.warn(`[task-assign-worker] ⚠ No active team members! Add members via the Team page.`);
  }
  for (const m of activeMembers) {
    console.log(`[task-assign-worker]   • ${m.name} <${m.email}>`);
    console.log(`[task-assign-worker]     role=${m.role} capability=${m.capability ?? "fullstack"} skills=[${(m.skills ?? []).join(", ")}]`);
    console.log(`[task-assign-worker]     currentActiveTaskCount=${m.activeTaskCount ?? 0}`);
  }

  // ── Step 3: Resolve per-task repo mappings ────────────────────────────────
  if (orcJob.pmsProjectId) {
    console.log(`\n[task-assign-worker] STEP 3 — Resolving repo mappings for PMS project ${orcJob.pmsProjectId}`);
    const repoMappings = await RepoMapping.find({ pmsProjectId: orcJob.pmsProjectId }).lean();
    console.log(`[task-assign-worker]   Found ${repoMappings.length} repo mapping(s)`);

    const mappingByType = Object.fromEntries(repoMappings.map((m) => [m.repoType, m]));
    for (const task of pendingTasks) {
      const area = task.taskArea ?? "fullstack";
      const mapping = mappingByType[area] ?? mappingByType["default"];
      if (mapping) {
        await Task.findByIdAndUpdate(task._id, {
          repoFullName: mapping.repoFullName,
          baseBranch: mapping.baseBranch ?? "main",
        });
        console.log(`[task-assign-worker]   [${task.pmsTaskId}] repo → ${mapping.repoFullName} (${mapping.repoType})`);
      } else {
        console.log(`[task-assign-worker]   [${task.pmsTaskId}] no repo mapping for area=${area}, using default: ${orcJob.repoFullName}`);
      }
    }
  }

  await bullJob.updateProgress(30);

  // ── Step 4: Run assignment engine ─────────────────────────────────────────
  console.log(`\n[task-assign-worker] STEP 4 — Running skill-based assignment engine...`);
  const result = await scheduleTasks(jobId);
  await bullJob.updateProgress(90);

  // ── Step 5: Final status ──────────────────────────────────────────────────
  if (result.dispatched > 0) {
    await Job.findByIdAndUpdate(jobId, { status: "generating", stage: 6 });
    console.log(`[task-assign-worker] ✓ Job → generating (stage 6): ${result.dispatched} task(s) queued for codegen`);
  } else {
    await Job.findByIdAndUpdate(jobId, {
      status: "awaiting_assignment",
      errorMessage:
        "Auto-assignment found no active team members. " +
        'Add members in the Team page, then use "Start Code Generation" manually.',
    });
    console.warn(`[task-assign-worker] ⚠ No tasks dispatched — job → awaiting_assignment`);
    console.warn(`[task-assign-worker]   Cause: either no active orchestrator users or no pending tasks`);
  }

  audit("system", "tasks.assigned", {
    jobId: orcJob._id,
    details: { assigned: result.assigned, dispatched: result.dispatched },
  });

  // ── Final workflow summary ────────────────────────────────────────────────
  const allTasks = await Task.find({ jobId: orcJob._id }).lean();
  const assigned = allTasks.filter((t) => t.assignedTo);
  const unassigned = allTasks.filter((t) => !t.assignedTo);
  const withDue = allTasks.filter((t) => t.estimatedHours);

  // Build assignee map for display
  const memberIds = [...new Set(assigned.map((t) => String(t.assignedTo)))];
  const memberDocs = await OrchestratorUser.find({ _id: { $in: memberIds } }, { name: 1, email: 1 }).lean();
  const memberById = Object.fromEntries(memberDocs.map((m) => [String(m._id), m]));

  const byMember = {};
  for (const t of assigned) {
    const m = memberById[String(t.assignedTo)];
    const key = m ? `${m.name} <${m.email}>` : `Unknown (${t.assignedTo})`;
    if (!byMember[key]) byMember[key] = [];
    byMember[key].push(t);
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`[task-assign-worker] ===== PMS WORKFLOW SUMMARY =====`);
  console.log(`${"=".repeat(50)}`);

  console.log(`\n  TASK ASSIGNMENT`);
  for (const [memberLabel, memberTasks] of Object.entries(byMember)) {
    console.log(`\n  ${memberLabel}`);
    console.log(`    Assigned Tasks: ${memberTasks.length}`);
    for (const t of memberTasks) {
      const dueStr = t.estimatedHours
        ? new Date(Date.now() + t.estimatedHours * 3_600_000).toISOString().slice(0, 10)
        : "not set";
      console.log(`    • [${t.pmsTaskId}] ${t.title}`);
      console.log(`      priority=${t.priority} type=${t.type} area=${t.taskArea} hours=${t.estimatedHours ?? "?"}h`);
      console.log(`      Due Date: ${dueStr}  |  Assignment: SUCCESS`);
    }
  }

  if (unassigned.length > 0) {
    console.log(`\n  UNASSIGNED TASKS (${unassigned.length}):`);
    for (const t of unassigned) {
      console.log(`  ⚠ [${t.pmsTaskId}] "${t.title}" — no eligible team member found`);
    }
  }

  console.log(`\n  FINAL STATUS`);
  console.log(`  Total Tasks:              ${allTasks.length}`);
  console.log(`  Assigned Tasks:           ${assigned.length}`);
  console.log(`  Unassigned Tasks:         ${unassigned.length}`);
  console.log(`  Tasks With Hours Estimate: ${withDue.length}`);
  console.log(`  Tasks Without Est.:        ${allTasks.length - withDue.length}`);
  console.log(`  Dispatched to Codegen:    ${result.dispatched}`);
  console.log(`${"=".repeat(50)}\n`);

  await bullJob.updateProgress(100);
  return result;
};

const worker = new Worker("task-assign", processor, {
  connection: getRedis(),
  concurrency: 3,
});

worker.on("failed", async (bullJob, err) => {
  const { jobId } = bullJob?.data ?? {};
  console.error(`[task-assign-worker] ✗ FAILED job=${jobId}: ${err.message}`);
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
  console.log(`[task-assign-worker] ✓ Completed bull=${bullJob.id} — assigned=${result?.assigned ?? 0} dispatched=${result?.dispatched ?? 0}`);
});

console.log("[task-assign-worker] ready (concurrency: 3)");
