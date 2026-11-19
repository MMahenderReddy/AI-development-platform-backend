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
 *
 * PMS sync:
 *  After assigning each task in the orchestrator DB, we also call
 *  PATCH /api/tasks/:pmsTaskId to set the assignee in PMS, so the
 *  task appears assigned in the PMS UI. This requires the orchestrator
 *  user's email to match a PMS user who is a project member.
 */
import OrchestratorUser from "../models/OrchestratorUser.js";
import Task from "../models/Task.js";
import Job from "../models/Job.js";
import { getQueues } from "./queues.js";
import { pmsClientFor } from "./pmsClient.js";
import config from "../config/env.js";
import { audit } from "./audit.js";

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };

// Max tasks dispatched to codegen per member per day
const MAX_TASKS_PER_MEMBER_PER_DAY = Number(process.env.MAX_TASKS_PER_MEMBER_PER_DAY ?? 2);

/** Return midnight (00:00:00) of a date offset by `daysAhead` working days from today. */
function workingDayOffset(daysAhead) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  let added = 0;
  while (added < daysAhead) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++; // skip Sat/Sun
  }
  return d;
}

/** True if two Date values fall on the same calendar day. */
function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

const sep = "=".repeat(50);

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
 * Guess the capability of a PMS user from their title or name.
 * Falls back to "fullstack".
 */
function guessPmsCapability(user) {
  const text = `${user.title ?? ""} ${user.name ?? ""}`.toLowerCase();
  if (text.includes("backend") || text.includes("back-end")) return "backend";
  if (text.includes("frontend") || text.includes("front-end") || text.includes("ui ") || text.includes("ui developer")) return "frontend";
  if (text.includes("full") || text.includes("fullstack")) return "fullstack";
  if (text.includes("lead") || text.includes("architect")) return "lead";
  return "fullstack";
}

/**
 * Fetch the PMS project members who can receive task assignments.
 * Returns an array of PMS user objects enriched with a guessed capability field.
 * Returns empty array on error so callers fall back gracefully.
 */
async function fetchPmsProjectMembers(pmsProjectId, workspace = "core") {
  if (!pmsProjectId) return [];
  try {
    const members = await pmsClientFor(workspace).getProjectMembers(pmsProjectId);
    const enriched = (Array.isArray(members) ? members : []).map((u) => ({
      ...u,
      // PMS REST API uses `id`, not `_id` — normalise so downstream code works
      _id: String(u.id ?? u._id),
      _capability: guessPmsCapability(u),
    }));
    console.log(`[scheduler] PMS project members: ${enriched.length}`);
    for (const m of enriched) {
      console.log(`[scheduler]   • ${m.name} <${m.email ?? "no email"}> title="${m.title ?? ""}" → guessed capability: ${m._capability}`);
    }
    return enriched;
  } catch (err) {
    console.warn(`[scheduler] could not fetch PMS project members (PMS assignee sync disabled): ${err.message}`);
    return [];
  }
}

/**
 * Pick the best PMS project member for a task using capability + load balancing.
 * pmsMembers must be pre-enriched with _capability.
 * pmsCounts is a mutable map of pmsUserId → task count for this batch.
 */
function pickPmsMember(task, pmsMembers, pmsCounts) {
  if (pmsMembers.length === 0) return null;
  const taskArea = task.taskArea ?? "fullstack";
  const capPool = pmsMembers.filter(
    (m) => (AREA_CAPABILITY_MAP[taskArea] ?? ["fullstack"]).includes(m._capability),
  );
  const pool = capPool.length > 0 ? capPool : pmsMembers;
  return pool.reduce((best, m) =>
    (pmsCounts[String(m._id)] ?? 0) < (pmsCounts[String(best._id)] ?? 0) ? m : best,
  );
}

/**
 * Assign all pending tasks for a job and stagger-dispatch them to the codegen queue.
 * Returns { assigned, dispatched }.
 */
export async function scheduleTasks(jobId) {
  console.log(`\n${sep}`);
  console.log(`[scheduler] ===== TASK ASSIGNMENT ENGINE STARTED =====`);
  console.log(`[scheduler] Job ID: ${jobId}`);
  console.log(`[scheduler] Time:   ${new Date().toISOString()}`);
  console.log(`${sep}`);

  const orcJob = await Job.findById(jobId);
  if (!orcJob) throw new Error(`Job ${jobId} not found`);
  const pmsClient = pmsClientFor(orcJob.pmsWorkspace ?? "core");

  // ── Step 1: Load pending tasks ──────────────────────────────────────────
  const tasks = await Task.find({ jobId: orcJob._id, status: "pending" });
  console.log(`\n[scheduler] STEP 1 — Pending tasks: ${tasks.length}`);
  if (tasks.length === 0) {
    console.log(`[scheduler] No pending tasks found for job=${jobId}`);
    console.log(`${sep}\n`);
    return { assigned: 0, dispatched: 0 };
  }
  for (const t of tasks) {
    console.log(`[scheduler]   • [${t.pmsTaskId}] "${t.title}" | priority=${t.priority} area=${t.taskArea} type=${t.type}`);
  }

  // ── Step 2: Load active orchestrator team members for this workspace ────
  const members = await OrchestratorUser.find({
    status: "active",
    pmsWorkspace: orcJob.pmsWorkspace ?? "core",
  }).lean();
  console.log(`\n[scheduler] STEP 2 — Active orchestrator team members: ${members.length}`);
  if (members.length === 0) {
    console.warn(`[scheduler] ⚠ No active members — cannot auto-assign. Falling back to awaiting_assignment.`);
    console.log(`${sep}\n`);
    return { assigned: 0, dispatched: 0 };
  }
  for (const m of members) {
    console.log(`[scheduler]   • ${m.name} <${m.email}> | role=${m.role} capability=${m.capability ?? "fullstack"} skills=[${(m.skills ?? []).join(", ")}] activeTaskCount=${m.activeTaskCount ?? 0}`);
  }

  // ── Step 3: Topological sort + pick assignments ──────────────────────────
  const ordered = topologicalSort(tasks);
  const staggerMs = config.stagger?.taskMs ?? 30_000;
  console.log(`\n[scheduler] STEP 3 — Skill-based assignment (stagger=${staggerMs}ms)`);

  const assignments = [];
  const memberCounts = Object.fromEntries(members.map((m) => [String(m._id), m.activeTaskCount ?? 0]));

  for (const task of ordered) {
    // Build a view of members with current (shadow) counts for this batch
    const currentMembers = members.map((m) => ({
      ...m,
      activeTaskCount: memberCounts[String(m._id)] ?? 0,
    }));
    const member = pickMember(task, currentMembers);
    if (!member) {
      console.warn(`[scheduler]   ⚠ [${task.pmsTaskId}] "${task.title}" — no eligible member found`);
      continue;
    }
    assignments.push({ task, member });
    memberCounts[String(member._id)] = (memberCounts[String(member._id)] ?? 0) + 1;

    const reason = (() => {
      const area = task.taskArea ?? "fullstack";
      const capPool = (AREA_CAPABILITY_MAP[area] ?? ["fullstack"]).includes(member.capability ?? "fullstack");
      const skillMatch = (member.skills ?? []).some(
        (s) => s.toLowerCase() === task.type?.toLowerCase() || task.title.toLowerCase().includes(s.toLowerCase()),
      );
      if (skillMatch) return `skill match (${area} area)`;
      if (capPool) return `capability match (${member.capability ?? "fullstack"} ⊇ ${area})`;
      return "fallback (broadest pool)";
    })();

    console.log(`[scheduler]   ✓ [${task.pmsTaskId}] "${task.title}"`);
    console.log(`[scheduler]       → Assigned to: ${member.name} (${member.email}) | Reason: ${reason}`);
  }

  if (assignments.length === 0) {
    console.warn(`[scheduler] No assignments could be made — no eligible members for any task`);
    console.log(`${sep}\n`);
    return { assigned: 0, dispatched: 0 };
  }

  // ── Step 4: Fetch PMS project members for PMS assignee sync ─────────────
  console.log(`\n[scheduler] STEP 4 — Fetching PMS project members for assignee sync`);
  const pmsMembers = await fetchPmsProjectMembers(orcJob.pmsProjectId, orcJob.pmsWorkspace ?? "core");
  const pmsCounts = Object.fromEntries(pmsMembers.map((m) => [String(m._id), 0]));

  if (pmsMembers.length === 0) {
    console.warn(`[scheduler]   ⚠ No PMS project members found — PMS assignee sync will be skipped`);
    console.warn(`[scheduler]     Fix: add team members to the TEST project in PMS, then re-run`);
  }

  // ── Step 5: Compute scheduledDate / dueDate for each assignment ──────────
  console.log(`\n[scheduler] STEP 5 — Computing daily schedule (max ${MAX_TASKS_PER_MEMBER_PER_DAY} tasks/member/day)`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Track how many tasks each member has been given per working day
  // memberDayLoad: memberId → Map<dateString, count>
  const memberDayLoad = {};
  for (const m of members) {
    memberDayLoad[String(m._id)] = new Map();
  }

  // Track the latest finish date for each task (for dependency scheduling)
  // taskFinishDay: task._id.toString() → Date (day the task is expected to finish)
  const taskFinishDay = new Map();

  for (const { task, member } of assignments) {
    const memberId = String(member._id);
    const dayLoad = memberDayLoad[memberId];
    const hours = task.estimatedHours ?? 4;

    // Earliest start = max(today, latest dependency finish day)
    let earliest = new Date(today);
    for (const depId of task.dependsOn ?? []) {
      const depFinish = taskFinishDay.get(String(depId));
      if (depFinish && depFinish > earliest) earliest = new Date(depFinish);
    }

    // Find the first working day from `earliest` where member has capacity
    let scheduledDay = new Date(earliest);
    while (true) {
      const dow = scheduledDay.getDay();
      if (dow !== 0 && dow !== 6) { // skip weekends
        const key = scheduledDay.toISOString().slice(0, 10);
        const count = dayLoad.get(key) ?? 0;
        if (count < MAX_TASKS_PER_MEMBER_PER_DAY) {
          dayLoad.set(key, count + 1);
          break;
        }
      }
      scheduledDay = new Date(scheduledDay);
      scheduledDay.setDate(scheduledDay.getDate() + 1);
    }

    // Due date = scheduledDate + ceil(estimatedHours / 8) working days
    const workDaysNeeded = Math.max(1, Math.ceil(hours / 8));
    const dueDate = new Date(scheduledDay);
    let added = 0;
    while (added < workDaysNeeded) {
      dueDate.setDate(dueDate.getDate() + 1);
      if (dueDate.getDay() !== 0 && dueDate.getDay() !== 6) added++;
    }

    taskFinishDay.set(String(task._id), new Date(dueDate));
    task._scheduledDate = scheduledDay;
    task._dueDate = dueDate;

    const isToday = isSameDay(scheduledDay, today);
    console.log(`[scheduler]   [${task.pmsTaskId}] "${task.title.slice(0, 50)}"`);
    console.log(`[scheduler]       → ${member.name} | scheduledDate=${scheduledDay.toISOString().slice(0,10)} | dueDate=${dueDate.toISOString().slice(0,10)} | dispatch=${isToday ? "TODAY" : "FUTURE"}`);
  }

  // ── Step 6: Persist orchestrator assignments + dispatch today's tasks ──────
  console.log(`\n[scheduler] STEP 6 — Persisting assignments & dispatching today's tasks`);
  const queues = getQueues();
  const assignmentResults = [];
  let dispatchedToday = 0;
  let scheduledFuture = 0;

  // Process sequentially to maintain pmsCounts load-balancing across tasks
  for (let i = 0; i < assignments.length; i++) {
    const { task, member } = assignments[i];
    const memberId = String(member._id);
    const isToday = isSameDay(task._scheduledDate, today);
    const delay = isToday ? i * staggerMs : 0; // stagger only today's dispatches

    // Persist in orchestrator DB
    await Task.findByIdAndUpdate(task._id, {
      status: isToday ? "queued" : "assigned",
      assignedTo: memberId,
      scheduledDate: task._scheduledDate,
      dueDate: task._dueDate,
    });

    if (isToday) {
      await OrchestratorUser.findByIdAndUpdate(memberId, {
        $inc: { activeTaskCount: 1 },
      });
    }

    // Sync assignee to PMS using the actual PMS project members
    let pmsAssignResult = "SKIPPED";
    if (pmsMembers.length > 0) {
      const pmsMember = pickPmsMember(task, pmsMembers, pmsCounts);
      if (pmsMember) {
        try {
          const pmsUpdate = {
            assignee: String(pmsMember._id),
            ...(task._dueDate ? { dueDate: task._dueDate.toISOString() } : {}),
          };
          await pmsClient.updateTask(task.pmsTaskId, pmsUpdate);
          pmsCounts[String(pmsMember._id)] = (pmsCounts[String(pmsMember._id)] ?? 0) + 1;
          pmsAssignResult = `SUCCESS → ${pmsMember.name} (${pmsMember._id}) capability=${pmsMember._capability}`;
          console.log(`[scheduler]   [${task.pmsTaskId}] PMS assignee set → ${pmsMember.name} ✓`);
        } catch (err) {
          pmsAssignResult = `FAILED: ${err.message}`;
          console.warn(`[scheduler]   [${task.pmsTaskId}] PMS assignee update failed: ${err.message}`);
        }
      }
    }

    if (isToday) {
      // Dispatch to codegen now
      await queues.codegen.add(
        "generate-code",
        { jobId: String(orcJob._id), pmsTaskId: task.pmsTaskId },
        { jobId: `codegen-${orcJob._id}-${task.pmsTaskId}`, delay },
      );
      dispatchedToday++;
    } else {
      scheduledFuture++;
    }

    assignmentResults.push({
      pmsTaskId: task.pmsTaskId,
      title: task.title,
      priority: task.priority,
      assigneeName: member.name,
      assigneeEmail: member.email,
      scheduledDate: task._scheduledDate.toISOString().slice(0, 10),
      dueDate: task._dueDate.toISOString().slice(0, 10),
      dispatchedToday: isToday,
      pmsAssignResult,
      queueDelay: isToday ? `${delay}ms` : "not dispatched today",
    });
  }

  audit("system", "tasks.scheduled", {
    jobId: orcJob._id,
    details: { assigned: assignments.length, staggerMs },
  });

  // ── Final Summary ─────────────────────────────────────────────────────────
  console.log(`\n${sep}`);
  console.log(`[scheduler] ===== TASK ASSIGNMENT SUMMARY =====`);
  console.log(`${sep}`);

  // Per-member breakdown
  const byMember = {};
  for (const r of assignmentResults) {
    if (!byMember[r.assigneeName]) byMember[r.assigneeName] = [];
    byMember[r.assigneeName].push(r);
  }

  for (const [name, taskList] of Object.entries(byMember)) {
    console.log(`\n  ${name} — ${taskList.length} task(s):`);
    for (const r of taskList) {
      const pmsOk = r.pmsAssignResult.startsWith("SUCCESS");
      const dispatchIcon = r.dispatchedToday ? "🚀 TODAY" : `📅 ${r.scheduledDate}`;
      console.log(`    [${r.pmsTaskId}] ${r.title}`);
      console.log(`      Priority:     ${r.priority}`);
      console.log(`      Scheduled:    ${dispatchIcon} → due ${r.dueDate}`);
      console.log(`      Queue delay:  ${r.queueDelay}`);
      console.log(`      PMS sync:     ${pmsOk ? "✓" : "⚠"} ${r.pmsAssignResult}`);
    }
  }

  const pmsSuccessCount = assignmentResults.filter((r) => r.pmsAssignResult.startsWith("SUCCESS")).length;
  const pmsFailCount = assignmentResults.filter((r) => r.pmsAssignResult.startsWith("FAILED")).length;
  const pmsSkipCount = assignmentResults.filter((r) => r.pmsAssignResult.startsWith("SKIPPED")).length;

  console.log(`\n  TOTALS`);
  console.log(`  Total tasks assigned (orchestrator DB): ${assignments.length}`);
  console.log(`  Dispatched to codegen today:            ${dispatchedToday}`);
  console.log(`  Scheduled for future days:              ${scheduledFuture}`);
  console.log(`  PMS assignee sync — SUCCESS: ${pmsSuccessCount}  FAILED: ${pmsFailCount}  SKIPPED: ${pmsSkipCount}`);

  if (pmsSkipCount > 0) {
    console.log(`\n  ℹ  PMS sync was skipped for ${pmsSkipCount} task(s) because the orchestrator user's email`);
    console.log(`     was not found in the PMS user list for this workspace.`);
    console.log(`     To fix: add each orchestrator user to the PMS (same email) and add them to the project.`);
  }

  console.log(`${sep}\n`);

  return { assigned: assignments.length, dispatched: dispatchedToday, scheduledFuture };
}
