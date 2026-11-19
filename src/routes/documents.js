/**
 * Documents API
 *
 * POST   /documents/upload/:projectId  — upload a doc, auto-create a job, start analysis
 * GET    /documents/project/:projectId — list all docs for a project
 * GET    /documents/:id                — get one document with requirements
 * GET    /documents/:id/file           — download the original file (auth-gated)
 * PATCH  /documents/:id/requirements/:reqId — edit a requirement
 * POST   /documents/:id/requirements/approve — bulk approve requirements
 *
 * Files are stored locally under:
 *   ./uploads/<project-slug>/<timestamp>_<safe-filename>
 *
 * No S3 or external storage — all files stay on this server.
 */
import { Router } from "express";
import multer from "multer";
import path from "path";
import { createReadStream } from "fs";
import { mkdirSync } from "fs";
import mongoose from "mongoose";
import Document from "../models/Document.js";
import Job from "../models/Job.js";
import Project from "../models/Project.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { notFound, badRequest } from "../lib/errors.js";
import { getQueues } from "../lib/queues.js";
import { audit } from "../lib/audit.js";
import config from "../config/env.js";

const BASE_UPLOAD_DIR = path.resolve(config.sandbox.workspaceDir ? "./uploads" : "./uploads");

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

// ── Middleware: resolve project from :projectId (ObjectId or slug) ────────────
async function resolveProject(req, res, next) {
  try {
    const idOrSlug = req.params.projectId;
    const isObjectId = mongoose.Types.ObjectId.isValid(idOrSlug);
    const project = await Project.findOne(
      isObjectId
        ? { $or: [{ _id: idOrSlug }, { projectId: idOrSlug }] }
        : { projectId: idOrSlug }
    );
    if (!project) return next(notFound("Project"));

    req.project = project;
    // Folder name: use the project slug (guaranteed unique by Project model)
    req.uploadDir = path.resolve(BASE_UPLOAD_DIR, project.projectId);
    mkdirSync(req.uploadDir, { recursive: true });
    next();
  } catch (err) {
    next(err);
  }
}

// ── Multer: destination is set dynamically by resolveProject middleware ────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req.uploadDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

const router = Router();

// ── Upload a document → auto-create job → start analysis ─────────────────────
router.post(
  "/upload/:projectId",
  requireAuth,
  requireRole("admin", "manager", "lead"),
  resolveProject,
  upload.single("document"),
  async (req, res, next) => {
    try {
      const project = req.project;

      // Reject if the project already has an active job
      const ACTIVE = [
        "pending", "analyzing", "generating_tasks", "syncing_to_pms",
        "awaiting_assignment", "auto_assigning", "generating",
        "quality_gate", "pushed", "integrating", "pr_open",
      ];
      const activeJob = await Job.findOne({ projectId: project._id, status: { $in: ACTIVE } });
      if (activeJob) {
        return next(badRequest(`Project "${project.name}" already has an active job (${activeJob.status}). Wait for it to complete or cancel it first.`));
      }

      // Determine repo from project config
      const repoFullName =
        project.repoConfig?.defaultRepo ||
        project.repoConfig?.backendRepo ||
        project.repoConfig?.frontendRepo ||
        "";

      // Create the job
      const job = await Job.create({
        projectId: project._id,
        pmsProjectId: project.pmsProjectId ?? project.projectId,
        pmsWorkspace: project.pmsWorkspace ?? "core",
        repoFullName,
        status: "analyzing",
        stage: 2,
        createdBy: req.user._id,
      });

      // Create the document record
      const doc = await Document.create({
        jobId: job._id,
        projectId: project._id,
        projectSlug: project.projectId,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        storagePath: req.file.path,
        uploadedBy: req.user._id,
      });

      job.documentId = doc._id;
      await job.save();

      // Enqueue analysis
      const queues = getQueues();
      await queues.analysis.add(
        "analyze",
        { jobId: String(job._id), documentId: String(doc._id) },
        { jobId: `analysis-${job._id}` },
      );

      audit(req.user, "document.uploaded", {
        jobId: job._id,
        details: {
          projectId: project._id,
          projectSlug: project.projectId,
          fileName: req.file.originalname,
          sizeBytes: req.file.size,
          storedAt: req.file.path,
        },
      });

      res.status(201).json({ document: doc, job });
    } catch (err) {
      next(err);
    }
  }
);

// ── List all documents for a project ─────────────────────────────────────────
router.get("/project/:projectId", requireAuth, async (req, res, next) => {
  try {
    const idOrSlug = req.params.projectId;
    const isObjectId = mongoose.Types.ObjectId.isValid(idOrSlug);
    const project = await Project.findOne(
      isObjectId
        ? { $or: [{ _id: idOrSlug }, { projectId: idOrSlug }] }
        : { projectId: idOrSlug }
    ).lean();
    if (!project) return next(notFound("Project"));

    const docs = await Document.find({ projectId: project._id })
      .sort({ createdAt: -1 })
      .select("-extractedText -requirements")
      .lean();

    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// ── Get document with requirements ───────────────────────────────────────────
router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const doc = await Document.findById(req.params.id).lean();
    if (!doc) return next(notFound("Document"));
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// ── Download the original file (auth-gated, streamed) ────────────────────────
router.get("/:id/file", requireAuth, async (req, res, next) => {
  try {
    const doc = await Document.findById(req.params.id).lean();
    if (!doc) return next(notFound("Document"));
    if (!doc.storagePath) return next(notFound("File not stored on this server"));

    const absPath = path.resolve(doc.storagePath);
    // Safety check: file must be inside the uploads directory
    if (!absPath.startsWith(path.resolve(BASE_UPLOAD_DIR))) {
      return res.status(403).json({ error: "FORBIDDEN", message: "Path traversal denied" });
    }

    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(doc.originalName)}"`);
    if (doc.mimeType) res.setHeader("Content-Type", doc.mimeType);

    const stream = createReadStream(absPath);
    stream.on("error", () => res.status(404).json({ error: "NOT_FOUND", message: "File not found on disk" }));
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

// ── Update individual requirement ─────────────────────────────────────────────
router.patch("/:id/requirements/:reqId", requireAuth, requireRole("admin", "manager", "lead"), async (req, res, next) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return next(notFound("Document"));

    const req_ = doc.requirements.find((r) => r.id === req.params.reqId);
    if (!req_) return next(notFound("Requirement"));

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

// ── Bulk approve requirements ─────────────────────────────────────────────────
router.post("/:id/requirements/approve", requireAuth, requireRole("admin", "manager", "lead"), async (req, res, next) => {
  try {
    const { approvedIds, rejectedIds } = req.body ?? {};
    if (!Array.isArray(approvedIds)) return next(badRequest("approvedIds must be an array"));

    const doc = await Document.findById(req.params.id);
    if (!doc) return next(notFound("Document"));

    const job = await Job.findById(doc.jobId);
    if (!job) return next(notFound("Job"));

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
    if (approvedCount === 0) return next(badRequest("At least one requirement must be approved"));

    await doc.save();

    job.status = "generating_tasks";
    job.stage = 3;
    await job.save();

    const queues = getQueues();
    await queues.analysis.add(
      "generate-tasks",
      { jobId: String(job._id), documentId: String(doc._id) },
      { jobId: `gentasks-${job._id}` },
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

// ── Re-analyze an updated document (delta job) ───────────────────────────────
//
// POST /documents/reanalyze/:projectId
//
// Compares a newly uploaded document against the previous job's requirements.
// Creates a delta Job that:
//   - cancels PMS tasks whose requirements were removed (if not yet in progress)
//   - flags PMS tasks whose requirements changed but are already in progress
//   - updates PMS tasks whose requirements changed and haven't started yet
//   - creates new PMS tasks for newly added requirements
//
// Blocked if any job for the project is currently active.
router.post(
  "/reanalyze/:projectId",
  requireAuth,
  requireRole("admin", "manager", "lead"),
  resolveProject,
  upload.single("document"),
  async (req, res, next) => {
    try {
      const project = req.project;

      // Guard: no active jobs
      const ACTIVE = [
        "pending", "analyzing", "generating_tasks", "syncing_to_pms",
        "awaiting_assignment", "auto_assigning", "generating",
        "quality_gate", "quality_failed", "pushed", "integrating", "pr_open",
        "changes_requested",
      ];
      const activeJob = await Job.findOne({ projectId: project._id, status: { $in: ACTIVE } });
      if (activeJob) {
        return next(
          badRequest(
            `An active job (${activeJob.status}) is in progress for this project. ` +
            "Wait for it to complete before uploading a revised document.",
          ),
        );
      }

      // Find the latest successfully-completed job for this project.
      // Exclude "failed" so a previous failed delta run doesn't block future uploads.
      const TERMINAL = ["merged", "deployed", "delta_complete"];
      const prevJob = await Job.findOne(
        { projectId: project._id, status: { $in: TERMINAL } },
      ).sort({ createdAt: -1 });

      if (!prevJob) {
        return next(
          badRequest(
            "No completed job found for this project. " +
            "Use the initial document upload to start the first analysis.",
          ),
        );
      }

      // Load the previous document and validate it has approved requirements
      const prevDoc = await Document.findOne({ jobId: prevJob._id }).sort({ createdAt: -1 }).lean();
      if (!prevDoc) {
        return next(badRequest("Previous job has no associated document."));
      }
      const prevApproved = (prevDoc.requirements ?? []).filter((r) => r.approved);
      if (prevApproved.length === 0) {
        return next(
          badRequest(
            "Previous document has no approved requirements to compare against. " +
            "Use the initial upload instead.",
          ),
        );
      }

      // Determine repo from project config (fall back to parent job's repo)
      const repoFullName =
        project.repoConfig?.defaultRepo ||
        project.repoConfig?.backendRepo ||
        project.repoConfig?.frontendRepo ||
        prevJob.repoFullName ||
        "";

      // Create the delta job
      const deltaJob = await Job.create({
        projectId: project._id,
        pmsProjectId: project.pmsProjectId ?? project.projectId,
        pmsWorkspace: project.pmsWorkspace ?? "core",
        repoFullName,
        jobType: "delta",
        parentJobId: prevJob._id,
        status: "analyzing",
        stage: 2,
        createdBy: req.user._id,
      });

      // Create the new document record (linked to previous document for version history)
      const newDoc = await Document.create({
        jobId: deltaJob._id,
        projectId: project._id,
        projectSlug: project.projectId,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        storagePath: req.file.path,
        uploadedBy: req.user._id,
        previousDocumentId: prevDoc._id,
        documentVersion: (prevDoc.documentVersion ?? 1) + 1,
      });

      deltaJob.documentId = newDoc._id;
      await deltaJob.save();

      // Enqueue reanalysis worker
      const queues = getQueues();
      await queues.reanalysis.add(
        "reanalyze",
        {
          deltaJobId:  String(deltaJob._id),
          documentId:  String(newDoc._id),
          parentJobId: String(prevJob._id),
        },
        { jobId: `reanalysis-${deltaJob._id}` },
      );

      audit(req.user, "document.reanalysis_started", {
        jobId: deltaJob._id,
        details: {
          projectId:          project._id,
          fileName:           req.file.originalname,
          sizeBytes:          req.file.size,
          previousJobId:      prevJob._id,
          previousDocumentId: prevDoc._id,
          documentVersion:    newDoc.documentVersion,
        },
      });

      res.status(201).json({ document: newDoc, job: deltaJob });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
