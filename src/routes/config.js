import { Router } from "express";
import config from "../config/env.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

router.get("/health", (req, res) => {
  res.json({ ok: true, env: config.nodeEnv });
});

router.get("/ai-models", requireAuth, requireRole("admin", "manager", "lead"), (req, res) => {
  res.json({
    model: config.openai.model,
    embeddingModel: config.openai.embeddingModel,
    configured: config.openai.isConfigured(),
    githubConfigured: config.github.isConfigured(),
    pmsConfigured: !!(config.pms.serviceEmail && config.pms.servicePassword),
  });
});

export default router;
