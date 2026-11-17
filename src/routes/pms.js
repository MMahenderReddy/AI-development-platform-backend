/**
 * PMS proxy routes — expose PMS project and member data to the orchestrator frontend.
 * All calls are server-to-server via pmsClient (service account session).
 * The frontend never calls the PMS directly.
 */
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { pmsClient } from "../lib/pmsClient.js";

const router = Router();

/** List PMS projects visible to the service account. Only returns projects with a repo set. */
router.get("/projects", requireAuth, async (req, res, next) => {
  try {
    const projects = await pmsClient.listProjects();
    // Filter to projects that have a GitHub repo configured
    const withRepo = (Array.isArray(projects) ? projects : projects.projects ?? [])
      .filter((p) => p.repo && !p.archived)
      .map((p) => ({
        id: p.id ?? p._id,
        name: p.name,
        key: p.key,
        repo: p.repo,
        defaultBranch: p.defaultBranch,
        members: p.members ?? [],
      }));
    res.json(withRepo);
  } catch (err) {
    next(err);
  }
});

/** Get a single PMS project with its member list. */
router.get("/projects/:id", requireAuth, async (req, res, next) => {
  try {
    const project = await pmsClient.getProject(req.params.id);
    res.json({
      id: project._id,
      name: project.name,
      key: project.key,
      repo: project.repo,
      defaultBranch: project.defaultBranch,
      members: project.members ?? [],
    });
  } catch (err) {
    next(err);
  }
});

export default router;
