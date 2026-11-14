/**
 * Integration Runs REST API (read-only)
 * GET /integration-runs?jobIds=a,b,c   — list runs for given jobs
 * GET /integration-runs/:id            — get one run with build log
 */
import { Router } from "express";
import IntegrationRun from "../models/IntegrationRun.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    const { jobIds } = req.query;
    const filter = jobIds
      ? { jobIds: { $in: jobIds.split(",").map((id) => id.trim()) } }
      : {};
    const runs = await IntegrationRun.find(filter).sort({ createdAt: -1 }).lean();
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const run = await IntegrationRun.findById(req.params.id).lean();
    if (!run) return res.status(404).json({ error: "Integration run not found" });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
