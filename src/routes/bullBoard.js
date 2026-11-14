/**
 * Bull Board — visual queue monitor.
 *
 * Mounted at /admin/queues (requires admin role + basic auth fallback).
 * Access is blocked in production unless BULL_BOARD_ENABLED=true.
 *
 * Security:
 *  - requireAuth + requireRole("admin") gate the entire sub-router
 *  - In production, additionally requires BULL_BOARD_ENABLED=true
 */
import { Router } from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { getQueues } from "../lib/queues.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import config from "../config/env.js";

const router = Router();

// Block in production unless explicitly enabled
router.use((req, res, next) => {
  if (config.isProd && process.env.BULL_BOARD_ENABLED !== "true") {
    return res.status(403).json({
      error: "FORBIDDEN",
      message: "Bull Board is disabled in production. Set BULL_BOARD_ENABLED=true to enable.",
    });
  }
  next();
});

// Require admin auth
router.use(requireAuth, requireRole("admin"));

// Lazily build the board after the app has started (queues are ready)
let serverAdapter = null;

router.use("/", (req, res, next) => {
  if (!serverAdapter) {
    const queues = getQueues();
    serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath("/admin/queues");

    createBullBoard({
      queues: [
        new BullMQAdapter(queues.analysis),
        new BullMQAdapter(queues.codegen),
        new BullMQAdapter(queues.pmsSync),
        new BullMQAdapter(queues.prPoll),
      ],
      serverAdapter,
    });
  }

  serverAdapter.getRouter()(req, res, next);
});

export default router;
