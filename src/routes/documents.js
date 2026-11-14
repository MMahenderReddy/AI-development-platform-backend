import { Router } from "express";
import multer from "multer";
import path from "path";
import { mkdirSync } from "fs";
import Document from "../models/Document.js";
import Job from "../models/Job.js";
import Approval from "../models/Approval.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { notFound, badRequest } from "../lib/errors.js";
import { getQueues } from "../lib/queues.js";
import { audit } from "../lib/audit.js";

const UPLOAD_DIR = path.resolve("./uploads");
mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

const router = Router();

// ── Upload a document and kick off analysis ───────────────────────────────────

router.post("/upload/:jobId", requireAuth, requireRole("admin", "manager", "lead"), upload.single("document"), async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.jobId);
    if (!job) throw notFound("Job");
    if (job.status !== "pending") throw badRequest("Job already has a document attached");

    const doc = await Document.create({
      jobId: job._id,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      storagePath: req.file.path,
      uploadedBy: req.user._id,
    });

    job.documentId = doc._id;
    job.status = "analyzing";
    job.stage = 2;
    await job.save();

    // Enqueue the analysis job — the worker will parse and extract requirements
    const queues = getQueues();
    await queues.analysis.add(
      "analyze",
      { jobId: String(job._id), documentId: String(doc._id) },
      { jobId: `analysis:${job._id}` },
    );

    audit(req.user, "document.uploaded", {
      jobId: job._id,
      details: { fileName: req.file.originalname, sizeBytes: req.file.size },
    });

    res.status(201).json({ document: doc, job });
  } catch (err) {
    next(err);
  }
});

// ── Get document with requirements ───────────────────────────────────────────

router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const doc = await Document.findById(req.params.id).lean();
    if (!doc) throw notFound("Document");
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// ── Update individual requirement (edit text before approval) ─────────────────

router.patch("/:id/requirements/:reqId", requireAuth, requireRole("admin", "manager", "lead"), async (req, res, next) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) throw notFound("Document");

    const req_ = doc.requirements.find((r) => r.id === req.params.reqId);
    if (!req_) throw notFound("Requirement");

    const { editedText, priority, category } = req.body ?? {};
    if (editedText !== undefined) req_.editedText = String(editedText).slice(0, 500).trim();
    if (priority) req_.priority = priority;
    if (category) req_.category = category;

    await doc.save();
    res.json(req_);
  } catch (err) {
    next(err);
  }
});

// ── Approve / reject requirements in bulk ────────────────────────────────────

router.post("/:id/requirements/approve", requireAuth, requireRole("admin", "manager", "lead"), async (req, res, next) => {
  try {
    const { approvedIds, rejectedIds } = req.body ?? {};
    if (!Array.isArray(approvedIds)) throw badRequest("approvedIds must be an array");

    const doc = await Document.findById(req.params.id);
    if (!doc) throw notFound("Document");

    const job = await Job.findById(doc.jobId);
    if (!job) throw notFound("Job");
    if (job.status !== "awaiting_requirements_approval") {
      throw badRequest(`Cannot approve requirements in status: ${job.status}`);
    }

    const approved = new Set(approvedIds);
    const rejected = new Set(Array.isArray(rejectedIds) ? rejectedIds : []);

    for (const r of doc.requirements) {
      r.approved = approved.has(r.id);
      r.rejected = rejected.has(r.id);
      if (r.approved) {
        r.approvedBy = req.user._id;
        r.approvedAt = new Date();
      }
    }

    const approvedCount = doc.requirements.filter((r) => r.approved).length;
    if (approvedCount === 0) throw badRequest("At least one requirement must be approved");

    await doc.save();

    // Record the approval
    await Approval.create({
      jobId: job._id,
      stage: 2,
      stageName: "requirements_review",
      decision: "approved",
      approvedBy: req.user._id,
      payload: { approvedIds, rejectedIds },
    });

    // Advance job — AI task generation is about to run (auto Stage 4)
    job.status = "generating_tasks";
    job.stage = 3;
    await job.save();

    // Enqueue task generation
    const queues = getQueues();
    await queues.analysis.add(
      "generate-tasks",
      { jobId: String(job._id), documentId: String(doc._id) },
      { jobId: `gentasks:${job._id}` },
    );

    audit(req.user, "requirements.approved", {
      jobId: job._id,
      details: { approvedCount, rejectedCount: rejectedIds?.length ?? 0 },
    });

    res.json({ approvedCount, job });
  } catch (err) {
    next(err);
  }
});

export default router;
