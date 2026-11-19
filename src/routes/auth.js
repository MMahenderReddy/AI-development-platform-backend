import { Router } from "express";

const router = Router();

// S2S service info — no user auth
router.get("/me", (req, res) => {
  res.json({ service: "orchestrator", auth: "s2s" });
});

export default router;
