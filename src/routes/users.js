/**
 * Users — proxy to PMS (OrchestratorUser collection removed).
 *
 * GET /api/users          — list consultant users from PMS
 */
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { pmsClient } from "../lib/pmsClient.js";

const router = Router();

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const users = await pmsClient.listUsers();
    res.json(Array.isArray(users) ? users : []);
  } catch (err) {
    next(err);
  }
});

export default router;
