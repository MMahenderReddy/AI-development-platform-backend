/**
 * Projects REST API
 * GET    /projects          — list all projects
 * POST   /projects          — create a project
 * GET    /projects/:id      — get one project
 * PATCH  /projects/:id      — update project fields
 * DELETE /projects/:id      — delete project (admin only)
 */
import { Router } from "express";
import Project from "../models/Project.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

// List
router.get("/", async (req, res) => {
  try {
    const projects = await Project.find().sort({ createdAt: -1 }).lean();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create
router.post("/", requireRole("admin", "manager"), async (req, res) => {
  try {
    const { name, projectId, pmsProjectId, pmsWorkspace, repoConfig, deployConfig } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const slug = projectId ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const existing = await Project.findOne({ projectId: slug });
    if (existing) return res.status(409).json({ error: `Project with id "${slug}" already exists` });

    const project = await Project.create({
      name,
      projectId: slug,
      pmsProjectId,
      pmsWorkspace: pmsWorkspace === "consultants" ? "consultants" : "core",
      repoConfig,
      deployConfig,
      createdBy: req.user._id,
    });
    res.status(201).json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get one
router.get("/:id", async (req, res) => {
  try {
    const project = await Project.findById(req.params.id).lean();
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update
router.patch("/:id", requireRole("admin", "manager"), async (req, res) => {
  try {
    const allowed = ["name", "status", "pmsProjectId", "pmsWorkspace", "repoConfig", "deployConfig", "completionPct", "teamMemberIds"];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    const project = await Project.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete
router.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    const project = await Project.findByIdAndDelete(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
