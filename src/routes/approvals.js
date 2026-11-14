import { Router } from "express";
import Approval from "../models/Approval.js";
import Job from "../models/Job.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { notFound, badRequest, forbidden } from "../lib/errors.js";
import { audit } from "../lib/audit.js";

const router = Router();

const STAGE_NAMES = {
  2: "requirements_review",
  3: "task_review",
  5: "task_assignment",
  6: "diff_review",
  8: "push_approval",
  9: "pr_review",
  10: "merge_decision",
};

const HUMAN_STAGES = new Set([2, 3, 5, 6, 8, 9, 10]);

router.post("/:jobId/stage/:stage", requireAuth, async (req, res, next) => {
  try {
    const stage = Number(req.params.stage);
    if (!HUMAN_STAGES.has(stage)) throw badRequest(`Stage ${stage} is automated and does not require manual approval`);

    const job = await Job.findById(req.params.jobId);
    if (!job) throw notFound("Job");

    const { decision, notes, payload } = req.body ?? {};
    if (!["approved", "rejected", "edited"].includes(decision)) throw badRequest("decision must be: approved, rejected, or edited");

    // Stage-specific role checks
    if ([8, 10].includes(stage) && !["admin", "manager", "lead"].includes(req.user.role)) {
      throw forbidden("Only a Lead or above can approve push or merge actions");
    }

    const approval = await Approval.create({
      jobId: job._id,
      stage,
      stageName: STAGE_NAMES[stage] ?? `stage_${stage}`,
      decision,
      approvedBy: req.user._id,
      notes,
      payload,
    });

    audit(req.user, `approval.stage${stage}.${decision}`, {
      jobId: job._id,
      approvedBy: String(req.user._id),
    });

    // Advance job status based on decision
    if (decision === "approved") {
      const nextStatus = {
        2: "awaiting_task_approval",
        3: "syncing_to_pms",
        6: "quality_gate",
        8: "pushed",
      }[stage];
      if (nextStatus) {
        job.status = nextStatus;
        job.stage = stage + 1;
        await job.save();
      }
    } else if (decision === "rejected") {
      job.status = "cancelled";
      await job.save();
    }

    res.status(201).json(approval);
  } catch (err) {
    next(err);
  }
});

export default router;
