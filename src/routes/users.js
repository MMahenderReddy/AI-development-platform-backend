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
    const { name, email, password, role, pmsUserId } = req.body ?? {};
    if (!name?.trim()) throw badRequest("Name is required");
    if (!email?.trim()) throw badRequest("Email is required");
    if (!password || password.length < 8) throw badRequest("Password must be at least 8 characters");
    if (role && !ROLES.includes(role)) throw badRequest(`Role must be one of: ${ROLES.join(", ")}`);

    const existing = await OrchestratorUser.findOne({ email: String(email).toLowerCase() });
    if (existing) throw badRequest("A user with that email already exists");

    const passwordHash = await OrchestratorUser.hashPassword(String(password));
    const user = await OrchestratorUser.create({
      name: String(name).trim(),
      email: String(email).toLowerCase().trim(),
      passwordHash,
      role: role ?? "viewer",
      pmsUserId: pmsUserId ?? "",
      status: "active",
    });

    audit(req.user, "users.invited", {
      details: { invitedEmail: user.email, role: user.role },
    });

    res.status(201).json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      pmsUserId: user.pmsUserId,
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

export default router;
