/**
 * Repo Mappings — admin CRUD
 *
 * GET    /api/repo-mappings?pmsProjectId=xxx  — list mappings (admin/manager)
 * POST   /api/repo-mappings                   — create mapping (admin only)
 * GET    /api/repo-mappings/:id               — get one mapping (admin/manager)
 * PATCH  /api/repo-mappings/:id               — update mapping (admin only)
 * DELETE /api/repo-mappings/:id               — delete mapping (admin only)
 */
import { Router } from "express";
import RepoMapping from "../models/RepoMapping.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { notFound, badRequest } from "../lib/errors.js";
import { audit } from "../lib/audit.js";

const REPO_TYPES = ["frontend", "backend", "mobile", "default"];
const router = Router();

// ── List ──────────────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole("admin", "manager"), async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.pmsProjectId) filter.pmsProjectId = req.query.pmsProjectId;
    const mappings = await RepoMapping.find(filter)
      .sort({ pmsProjectId: 1, repoType: 1 })
      .populate("assignedMemberId", "name email")
      .lean();
    res.json(mappings);
  } catch (err) {
    next(err);
  }
});

// ── Create ────────────────────────────────────────────────────────────────────
router.post("/", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { pmsProjectId, repoType, repoFullName, baseBranch, branchPattern, assignedMemberId } = req.body ?? {};
    if (!pmsProjectId?.trim()) throw badRequest("pmsProjectId is required");
    if (!repoFullName?.trim()) throw badRequest("repoFullName is required (owner/repo)");
    if (repoType && !REPO_TYPES.includes(repoType)) throw badRequest(`repoType must be one of: ${REPO_TYPES.join(", ")}`);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repoFullName)) throw badRequest("repoFullName must be in owner/repo format");

    const mapping = await RepoMapping.create({
      pmsProjectId: pmsProjectId.trim(),
      repoType:     repoType ?? "default",
      repoFullName: repoFullName.trim(),
      baseBranch:   baseBranch?.trim() ?? "main",
      branchPattern: branchPattern?.trim() ?? "orch/{taskId}/{slug}",
      assignedMemberId: assignedMemberId ?? undefined,
      createdBy:    req.user._id,
    });

    audit(req.user, "repoMapping.created", {
      details: { pmsProjectId, repoType: mapping.repoType, repoFullName },
    });

    res.status(201).json(mapping);
  } catch (err) {
    if (err.code === 11000) return next(badRequest("A mapping for this project + repoType already exists"));
    next(err);
  }
});

// ── Get one ───────────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, requireRole("admin", "manager"), async (req, res, next) => {
  try {
    const mapping = await RepoMapping.findById(req.params.id)
      .populate("assignedMemberId", "name email")
      .lean();
    if (!mapping) throw notFound("RepoMapping");
    res.json(mapping);
  } catch (err) {
    next(err);
  }
});

// ── Update ────────────────────────────────────────────────────────────────────
router.patch("/:id", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { repoFullName, baseBranch, branchPattern, assignedMemberId } = req.body ?? {};
    const update = {};
    if (repoFullName !== undefined) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repoFullName)) throw badRequest("repoFullName must be in owner/repo format");
      update.repoFullName = repoFullName.trim();
    }
    if (baseBranch !== undefined) update.baseBranch = baseBranch.trim() || "main";
    if (branchPattern !== undefined) update.branchPattern = branchPattern.trim() || "orch/{taskId}/{slug}";
    if (assignedMemberId !== undefined) update.assignedMemberId = assignedMemberId || null;

    const mapping = await RepoMapping.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!mapping) throw notFound("RepoMapping");

    audit(req.user, "repoMapping.updated", { details: { mappingId: mapping._id, update } });
    res.json(mapping);
  } catch (err) {
    next(err);
  }
});

// ── Delete ────────────────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const mapping = await RepoMapping.findByIdAndDelete(req.params.id);
    if (!mapping) throw notFound("RepoMapping");

    audit(req.user, "repoMapping.deleted", {
      details: { pmsProjectId: mapping.pmsProjectId, repoType: mapping.repoType },
    });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
