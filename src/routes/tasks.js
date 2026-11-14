/**
 * Tasks API
 *
 * GET  /api/tasks?jobId=xxx       — list tasks for a job
 * GET  /api/tasks/:id             — get one task
 * PATCH /api/tasks/:id/reassign   — reassign to another member (admin/manager/lead)
 * POST  /api/tasks/:id/quality/override — bypass quality gate (admin/manager, reason required)
 */
import { Router } from "express";
import Task from "../models/Task.js";
import OrchestratorUser from "../models/OrchestratorUser.js";
import Approval from "../models/Approval.js";
import Job from "../models/Job.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { notFound, badRequest } from "../lib/errors.js";
import { audit } from "../lib/audit.js";

const PASS_QG_STATUSES = new Set([
  "awaiting_diff", "awaiting_push", "pushed", "pr_open", "merged",
]);

async function advanceJobIfReady(jobId) {
  const all = await Task.find({ jobId }).lean();
  if (all.length === 0) return false;
  const blocking = all.filter(
    (t) => !PASS_QG_STATUSES.has(t.status) && t.status !== "failed" && t.status !== "cancelled",
  );
  if (blocking.length > 0) return false;
  const ready = all.filter((t) => t.status === "awaiting_diff");
  if (ready.length === 0) return false;
  await Job.findByIdAndUpdate(jobId, { status: "awaiting_diff_approval", stage: 7, $unset: { errorMessage: 1 } });
  return true;
}

const router = Router();

// ── List tasks for a job ──────────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const { jobId } = req.query;
    const filter = jobId ? { jobId } : {};
    const tasks = await Task.find(filter)
      .sort({ createdAt: 1 })
      .populate("assignedTo", "name email role")
      .lean();
    res.json(tasks);
  } catch (err) {
    next(err);
  }
});

// ── Get one task ──────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const task = await Task.findById(req.params.id)
      .populate("assignedTo", "name email role")
      .lean();
    if (!task) throw notFound("Task");
    res.json(task);
  } catch (err) {
    next(err);
  }
});

// ── Reassign task to another member ──────────────────────────────────────────
router.patch("/:id/reassign", requireAuth, requireRole("admin", "manager", "lead"), async (req, res, next) => {
  try {
    const { assignedTo } = req.body ?? {};
    if (!assignedTo) throw badRequest("assignedTo (userId) is required");

    const task = await Task.findById(req.params.id);
    if (!task) throw notFound("Task");

    // Can only reassign tasks that have not yet started codegen
    if (!["pending", "assigned", "queued"].includes(task.status)) {
      throw badRequest(`Cannot reassign task in status: ${task.status}`);
    }

    const member = await OrchestratorUser.findById(assignedTo).select("-passwordHash");
    if (!member) throw notFound("User");
    if (member.status !== "active") throw badRequest("Cannot assign to a disabled user");

    const previousAssignee = task.assignedTo;

    task.assignedTo = member._id;
    task.status = "assigned";
    await task.save();

    audit(req.user, "task.reassigned", {
      details: {
        taskId: task._id,
        taskTitle: task.title,
        from: previousAssignee,
        to: member._id,
      },
    });

    res.json(task);
  } catch (err) {
    next(err);
  }
});

// ── Override quality gate (bypass block with reason) ─────────────────────────
router.post("/:id/quality/override", requireAuth, requireRole("admin", "manager"), async (req, res, next) => {
  try {
    const reason = String(req.body?.reason ?? "").trim().slice(0, 500);
    if (!reason) throw badRequest("A reason is required to override the quality gate");

    const task = await Task.findById(req.params.id);
    if (!task) throw notFound("Task");
    if (task.status !== "quality_failed") {
      throw badRequest(`Quality gate override only applies to quality_failed tasks (current: ${task.status})`);
    }

    task.qualityOverride = { by: req.user._id, reason, at: new Date() };
    task.status = "awaiting_diff";
    await task.save();

    await Approval.create({
      jobId: task.jobId,
      stage: 7,
      stageName: "quality_gate_override",
      decision: "override",
      approvedBy: req.user._id,
      notes: reason,
      payload: { taskId: task._id, taskTitle: task.title },
    });

    audit(req.user, "task.quality_gate_overridden", {
      details: { taskId: task._id, taskTitle: task.title, reason },
    });

    // Advance job to awaiting_diff_approval if all tasks have cleared QG
    await advanceJobIfReady(task.jobId);

    res.json(task);
  } catch (err) {
    next(err);
  }
});

export default router;
