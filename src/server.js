import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import { mkdirSync } from "fs";
import { connectDb } from "./lib/db.js";
import { getRedis } from "./lib/redis.js";
import { pmsClient } from "./lib/pmsClient.js";
import config from "./config/env.js";
import authRouter from "./routes/auth.js";
import configRouter from "./routes/config.js";
import jobsRouter from "./routes/jobs.js";
import documentsRouter from "./routes/documents.js";
import approvalsRouter from "./routes/approvals.js";
import pmsRouter from "./routes/pms.js";
import bullBoardRouter from "./routes/bullBoard.js";
import usersRouter from "./routes/users.js";
import tasksRouter from "./routes/tasks.js";
import repoMappingsRouter from "./routes/repoMappings.js";
import projectsRouter from "./routes/projects.js";
import integrationRunsRouter from "./routes/integrationRuns.js";
import githubRouter from "./routes/github.js";
import { apiLimiter, authLimiter, uploadLimiter } from "./middleware/rateLimit.js";
import { ApiError } from "./lib/errors.js";
import { runStartupRecovery } from "./lib/recoveryJob.js";

// Ensure uploads root exists on startup
mkdirSync(path.resolve("./uploads"), { recursive: true });

const app = express();

app.use(helmet());
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));

// ── Health check (no auth, no rate-limit) ─────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: Math.floor(process.uptime()), env: config.nodeEnv });
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use("/api/auth", authLimiter);
app.use("/api/documents/upload", uploadLimiter); // tighter limit for file uploads only
app.use("/api", apiLimiter);

// ── API routes ────────────────────────────────────────────────────────────────
app.use("/api/auth", authRouter);
app.use("/api/config", configRouter);
app.use("/api/jobs", jobsRouter); // jobCreateLimiter now applied in-route on POST only
app.use("/api/documents", documentsRouter);
app.use("/api/approvals", approvalsRouter);
app.use("/api/pms", pmsRouter);
app.use("/api/users", usersRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/repo-mappings", repoMappingsRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/integration-runs", integrationRunsRouter);
app.use("/api/github", githubRouter);

// ── Admin: Bull Board queue monitor ──────────────────────────────────────────
app.use("/admin/queues", bullBoardRouter);

app.use((err, req, res, _next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "FILE_TOO_LARGE", message: "File exceeds 20 MB limit" });
  }
  console.error("[server] unhandled error:", err);
  res.status(500).json({ error: "INTERNAL_ERROR", message: "An unexpected error occurred" });
});

const start = async () => {
  await connectDb();
  getRedis(); // initialize connection

  try {
    await runStartupRecovery();
  } catch (err) {
    console.warn("[server] startup recovery failed (non-fatal):", err.message);
  }

  if (config.pms.serviceEmail && config.pms.servicePassword) {
    try {
      await pmsClient.ensureSession();
      console.log("[pms] service account session ready");
    } catch (err) {
      console.warn("[pms] could not establish service account session:", err.message);
      console.warn("[pms] PMS-dependent features will be unavailable until credentials are configured");
    }
  } else {
    console.warn("[pms] PMS_SERVICE_EMAIL / PMS_SERVICE_PASSWORD not set — PMS integration disabled");
  }

  app.listen(config.port, () => {
    console.log(`[server] AI Development Orchestrator listening on http://localhost:${config.port}`);
    console.log(`[server] env: ${config.nodeEnv} | AI model: ${config.openai.model}`);
    console.log(`[server] uploads stored locally at: ${path.resolve("./uploads")}`);
  });
};

start().catch((err) => {
  console.error("[server] startup failed:", err);
  process.exit(1);
});
