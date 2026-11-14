/**
 * Users / Team management
 *
 * GET  /api/users          — list all members (admin/manager)
 * POST /api/users/invite   — create a new member (admin only)
 * PATCH /api/users/:id/role   — change role (admin only)
 * PATCH /api/users/:id/status — enable/disable (admin only)
 */
import { Router } from "express";
import OrchestratorUser from "../models/OrchestratorUser.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";

const router = Router();

const ROLES = ["admin", "manager", "lead", "viewer"];
const CAPABILITIES = ["frontend", "backend", "fullstack", "lead"];

// ── List members ──────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole("admin", "manager"), async (req, res, next) => {
  try {
    const users = await OrchestratorUser.find({})
      .sort({ createdAt: -1 })
      .select("-passwordHash")
      .lean();
    res.json(users);
  } catch (err) {
    next(err);
  }
});

// ── Invite (create) a new member ──────────────────────────────────────────────
router.post("/invite", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { name, email, password, role, capability, pmsUserId, skills } = req.body ?? {};
    if (!name?.trim()) throw badRequest("Name is required");
    if (!email?.trim()) throw badRequest("Email is required");
    if (!password || password.length < 8) throw badRequest("Password must be at least 8 characters");
    if (role && !ROLES.includes(role)) throw badRequest(`Role must be one of: ${ROLES.join(", ")}`);
    if (capability && !CAPABILITIES.includes(capability)) throw badRequest(`Capability must be one of: ${CAPABILITIES.join(", ")}`);

    const existing = await OrchestratorUser.findOne({ email: String(email).toLowerCase() });
    if (existing) throw badRequest("A user with that email already exists");

    const skillsArr = Array.isArray(skills)
      ? skills.map((s) => String(s).trim()).filter(Boolean).slice(0, 30)
      : [];

    const passwordHash = await OrchestratorUser.hashPassword(String(password));
    const user = await OrchestratorUser.create({
      name: String(name).trim(),
      email: String(email).toLowerCase().trim(),
      passwordHash,
      role: role ?? "viewer",
      capability: capability ?? "fullstack",
      pmsUserId: pmsUserId ?? "",
      skills: skillsArr,
      status: "active",
    });

    audit(req.user, "users.invited", {
      details: { invitedEmail: user.email, role: user.role },
    });

    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      capability: user.capability,
      pmsUserId: user.pmsUserId,
      skills: user.skills,
      status: user.status,
      createdAt: user.createdAt,
    });
  } catch (err) {
    next(err);
  }
});

// ── Update role ───────────────────────────────────────────────────────────────
router.patch("/:id/role", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { role } = req.body ?? {};
    if (!ROLES.includes(role)) throw badRequest(`Role must be one of: ${ROLES.join(", ")}`);
    if (String(req.params.id) === String(req.user._id)) throw badRequest("Cannot change your own role");

    const user = await OrchestratorUser.findByIdAndUpdate(
      req.params.id,
      { role },
      { new: true, select: "-passwordHash" }
    );
    if (!user) throw notFound("User");

    audit(req.user, "users.role_changed", {
      details: { targetEmail: user.email, newRole: role },
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// ── Enable / disable ──────────────────────────────────────────────────────────
router.patch("/:id/status", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { status } = req.body ?? {};
    if (!["active", "disabled"].includes(status)) throw badRequest("status must be: active or disabled");
    if (String(req.params.id) === String(req.user._id)) throw badRequest("Cannot disable your own account");

    const user = await OrchestratorUser.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true, select: "-passwordHash" }
    );
    if (!user) throw notFound("User");

    audit(req.user, `users.${status}`, {
      details: { targetEmail: user.email },
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// ── Update skills ─────────────────────────────────────────────────────────────
router.patch("/:id/skills", requireAuth, async (req, res, next) => {
  try {
    // Members can update their own skills; admin/manager can update anyone's
    const isSelf = String(req.params.id) === String(req.user._id);
    if (!isSelf && !["admin", "manager"].includes(req.user.role)) {
      const { forbidden: forbid } = await import("../lib/errors.js");
      return next(forbid("Requires admin or manager role, or updating your own skills"));
    }

    const raw = req.body?.skills;
    if (!Array.isArray(raw)) throw badRequest("skills must be an array of strings");
    const skills = raw
      .map((s) => String(s).trim().slice(0, 50))
      .filter(Boolean)
      .slice(0, 30);

    const user = await OrchestratorUser.findByIdAndUpdate(
      req.params.id,
      { skills },
      { new: true, select: "-passwordHash" }
    );
    if (!user) throw notFound("User");

    audit(req.user, "users.skills_updated", {
      details: { targetEmail: user.email, skills },
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// ── Update capability ─────────────────────────────────────────────────────────
router.patch("/:id/capability", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const { capability } = req.body ?? {};
    if (!CAPABILITIES.includes(capability)) throw badRequest(`Capability must be one of: ${CAPABILITIES.join(", ")}`);

    const user = await OrchestratorUser.findByIdAndUpdate(
      req.params.id,
      { capability },
      { new: true, select: "-passwordHash" }
    );
    if (!user) throw notFound("User");

    audit(req.user, "users.capability_changed", {
      details: { targetEmail: user.email, capability },
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
});

export default router;
