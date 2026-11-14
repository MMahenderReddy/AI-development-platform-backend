/**
 * Task scheduler — assignment engine + staggered codegen dispatch.
 *
 * Assignment strategy:
 *  1. Topological sort respects dependsOn[] so dependencies are queued first.
 *  2. Within each dependency tier, urgent > high > medium > low.
 *  3. Skill matching: tasks whose type or title matches a member's skills tag
 *     are preferred for that member; falls back to any active member.
 *  4. Load balancing: within the eligible pool, the member with the lowest
 *     activeTaskCount wins (ties go to first in sorted order).
 *
 * Dispatch strategy:
 *  Each task is enqueued into the codegen queue with an incrementing BullMQ
 *  delay so they enter the queue staggered by TASK_STAGGER_MS (default 30s).
 *  Codegen queue concurrency is 1, so they also serialize there, but the
 *  delay gives the reassignment window its meaning: a task is reassignable
 *  while its BullMQ job is still delayed (status = "queued").
 */
import OrchestratorUser from "../models/OrchestratorUser.js";
import Task from "../models/Task.js";
import Job from "../models/Job.js";
import { getQueues } from "./queues.js";
import config from "../config/env.js";
import { audit } from "./audit.js";

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };

function topologicalSort(tasks) {
  const byId = new Map(tasks.map((t) => [String(t._id), t]));
  const visited = new Set();
  const result = [];

  function visit(task) {
    const id = String(task._id);
    if (visited.has(id)) return;
    visited.add(id);
    for (const depId of task.dependsOn ?? []) {
      const dep = byId.get(String(depId));
      if (dep) visit(dep);
    }
    result.push(task);
  }

  const prioritySorted = [...tasks].sort(
    (a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2),
  );
  for (const task of prioritySorted) visit(task);
  return result;
}

const AREA_CAPABILITY_MAP = {
  frontend:  ["frontend", "fullstack"],
  backend:   ["backend", "fullstack"],
  fullstack: ["fullstack", "lead"],
};

function pickMember(task, members) {
  if (members.length === 0) return null;

  const titleLower = task.title.toLowerCase();
  const typeLower = (task.type ?? "").toLowerCase();
  const taskArea = task.taskArea ?? "fullstack";

  // 1. Prefer members whose capability matches the task area
  const capabilityPool = members.filter(
    (m) => (AREA_CAPABILITY_MAP[taskArea] ?? ["fullstack"]).includes(m.capability ?? "fullstack"),
  );

  // 2. Within capability pool, further narrow by skill keyword
  const capSkilled = capabilityPool.filter(
    (m) =>
      m.skills?.some(
        (s) =>
          s.toLowerCase() === typeLower ||
          titleLower.includes(s.toLowerCase()),
      ),
  );

  // 3. Fall back through progressively broader pools
  const pool =
    capSkilled.length > 0
      ? capSkilled
      : capabilityPool.length > 0
      ? capabilityPool
      : members;

  return pool.reduce((best, m) =>
    (m.activeTaskCount ?? 0) < (best.activeTaskCount ?? 0) ? m : best,
  );
}

/**
 * Assign all pending tasks for a job and stagger-dispatch them to the codegen queue.
 * Returns { assigned, dispatched }.
 */
export async function scheduleTasks(jobId) {
  const orcJob = await Job.findById(jobId);
  if (!orcJob) throw new Error(`Job ${jobId} not found`);

  const tasks = await Task.find({ jobId: orcJob._id, status: "pending" });
  if (tasks.length === 0) {
    console.log(`[scheduler] no pending tasks for job=${jobId}`);
    return { assigned: 0, dispatched: 0 };
  }

  const members = await OrchestratorUser.find({ status: "active" }).lean();
  const ordered = topologicalSort(tasks);
  const staggerMs = config.stagger?.taskMs ?? 30_000;

  const assignments = [];
  for (const task of ordered) {
    const member = pickMember(task, members);
    if (!member) continue;
    assignments.push({ task, memberId: String(member._id) });
    // shadow activeTaskCount for subsequent assignments in this batch
    member.activeTaskCount = (member.activeTaskCount ?? 0) + 1;
  }

  if (assignments.length === 0) {
    return { assigned: 0, dispatched: 0 };
  }

  // Persist assignments and queue with staggered delays
  const queues = getQueues();

  await Promise.all(
    assignments.map(async ({ task, memberId }, i) => {
      const delay = i * staggerMs;
      await Task.findByIdAndUpdate(task._id, {
        status: "queued",
        assignedTo: memberId,
      });
      await OrchestratorUser.findByIdAndUpdate(memberId, {
        $inc: { activeTaskCount: 1 },
      });
      await queues.codegen.add(
        "generate-code",
        { jobId: String(orcJob._id), pmsTaskId: task.pmsTaskId },
        { jobId: `codegen:${orcJob._id}:${task.pmsTaskId}`, delay },
      );
    }),
  );

  audit("system", "tasks.scheduled", {
    jobId: orcJob._id,
    details: { assigned: assignments.length, staggerMs },
  });

  console.log(
    `[scheduler] job=${jobId}: ${assignments.length} task(s) dispatched to codegen (stagger=${staggerMs}ms)`,
  );
  return { assigned: assignments.length, dispatched: assignments.length };
}
