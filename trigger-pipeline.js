/**
 * Direct pipeline trigger — bypasses the stale HTTP server.
 * Creates Document + Job in MongoDB and enqueues the analysis job.
 * Run: node trigger-pipeline.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import { Queue } from "bullmq";
import { readFileSync, copyFileSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import Job from "./src/models/Job.js";
import Document from "./src/models/Document.js";
import Project from "./src/models/Project.js";
import OrchestratorUser from "./src/models/OrchestratorUser.js";

await mongoose.connect(process.env.MONGODB_URI, { dbName: "orchestrator_db" });
console.log("[db] connected");

// ── Load project and user ────────────────────────────────────────────────────
const project = await Project.findOne({ projectId: "testing" });
if (!project) throw new Error("Project 'testing' not found — run create-project.js first");

const admin = await OrchestratorUser.findOne({ email: "mahender@tektreeinc.com" });
if (!admin) throw new Error("Admin user not found");

console.log("[project]", project.name, "→", project.repoConfig.defaultRepo);

// ── Guard: cancel any active jobs for this project ───────────────────────────
const ACTIVE = ["pending", "analyzing", "generating_tasks", "syncing_to_pms",
  "awaiting_assignment", "auto_assigning", "generating", "quality_gate", "pushed", "integrating", "pr_open"];
const activeJob = await Job.findOne({ projectId: project._id, status: { $in: ACTIVE } });
if (activeJob) {
  console.log("[guard] cancelling stale job", activeJob._id, "(status:", activeJob.status + ")");
  activeJob.status = "cancelled";
  activeJob.errorMessage = "Cancelled by trigger-pipeline.js to allow new run";
  await activeJob.save();
}

// ── Copy test document into uploads dir ─────────────────────────────────────
const uploadDir = resolve(`./uploads/${project.projectId}`);
mkdirSync(uploadDir, { recursive: true });
const srcFile = resolve("./test-requirements.txt");
const destFile = join(uploadDir, `${Date.now()}_test-requirements.txt`);
copyFileSync(srcFile, destFile);
console.log("[file] stored at", destFile);

// ── Create Job ───────────────────────────────────────────────────────────────
const job = await Job.create({
  projectId: project._id,
  pmsProjectId: project.pmsProjectId,
  repoFullName: project.repoConfig.defaultRepo,
  status: "analyzing",
  stage: 2,
  createdBy: admin._id,
  mode: "pms",
});
console.log("[job] created", job._id.toString());

// ── Create Document ──────────────────────────────────────────────────────────
const doc = await Document.create({
  jobId: job._id,
  projectId: project._id,
  projectSlug: project.projectId,
  originalName: "test-requirements.txt",
  mimeType: "text/plain",
  sizeBytes: readFileSync(srcFile).length,
  storagePath: destFile,
  uploadedBy: admin._id,
});
job.documentId = doc._id;
await job.save();
console.log("[document] created", doc._id.toString());

// ── Enqueue analysis ──────────────────────────────────────────────────────────
const queue = new Queue("analysis", {
  connection: { host: "127.0.0.1", port: 6379 },
});
await queue.add(
  "analyze",
  { jobId: String(job._id), documentId: String(doc._id) },
  { jobId: `analysis-${job._id}` },
);
await queue.close();
console.log("[queue] analysis job enqueued");

console.log("\n✅ Pipeline triggered!");
console.log("   Job ID :", job._id.toString());
console.log("   Watch your npm run dev:all terminal for:");
console.log("   [analysis] → [pms] → [assign] worker logs");

await mongoose.disconnect();
