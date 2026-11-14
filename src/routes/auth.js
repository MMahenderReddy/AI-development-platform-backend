import { Router } from "express";
import jwt from "jsonwebtoken";
import config from "../config/env.js";
import OrchestratorUser from "../models/OrchestratorUser.js";
import { requireAuth } from "../middleware/auth.js";
import { unauthorized, badRequest } from "../lib/errors.js";
import { audit } from "../lib/audit.js";

const router = Router();

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: "lax",
  secure: config.isProd,
  path: "/",
});

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) throw badRequest("Email and password required");

    const user = await OrchestratorUser.findOne({ email: String(email).toLowerCase() }).select("+passwordHash");
    if (!user || user.status !== "active") throw unauthorized("Invalid credentials");
    const ok = await user.verifyPassword(String(password));
    if (!ok) throw unauthorized("Invalid credentials");

    const token = jwt.sign({ sub: String(user._id) }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
    res.cookie("orch_token", token, { ...cookieOptions(), maxAge: 8 * 60 * 60 * 1000 });
    audit(user, "auth.login");
    res.json({ id: user._id, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", requireAuth, (req, res) => {
  audit(req.user, "auth.logout");
  res.clearCookie("orch_token", cookieOptions());
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  const u = req.user;
  res.json({ id: u._id, name: u.name, email: u.email, role: u.role, pmsUserId: u.pmsUserId });
});

export default router;
