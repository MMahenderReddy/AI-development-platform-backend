/**
 * Startup recovery — detects and resolves stale jobs left by a previous server crash.
 *
 * Run once at server startup, before accepting requests.
 *
 * Recovery rules:
 *  - auto_assigning  → awaiting_assignment  (safe re-enqueue on next request)
 *  - generating      → failed               (if lastHeartbeatAt older than RECOVERY_TIMEOUT_MS)
 *  - quality_gate    → failed               (same timeout)
 *  - quality_failed  — left as-is           (requires human override — no timeout applies)
 *
 * Jobs with no lastHeartbeatAt (created before Phase 5) are treated as stale
 * only if they were created more than RECOVERY_TIMEOUT_MS ago.
 *
 * RECOVERY_TIMEOUT_MS defaults to 10 minutes.
 */
import Job from "../models/Job.js";
import Task from "../models/Task.js";

const RECOVERY_TIMEOUT_MS = Number(process.env.RECOVERY_TIMEOUT_MS ?? "600000");

export async function runStartupRecovery() {
  const staleCutoff = new Date(Date.now() - RECOVERY_TIMEOUT_MS);
  let total = 0;

  // ── 1. auto_assigning → awaiting_assignment ───────────────────────────────
  const { modifiedCount: assigningFixed } = await Job.updateMany(
    { status: "auto_assigning" },
    {
      status: "awaiting_assignment",
      errorMessage:
        "Auto-assignment interrupted (server restart). " +
        'Use "Start Code Generation" to assign manually, or wait for the assignment worker to retry.',
    },
  );
  total += assigningFixed;

  // ── 2. generating → failed (stale heartbeat or never heartbeated) ─────────
  const { modifiedCount: genFixed } = await Job.updateMany(
    {
      status: "generating",
      $or: [
        { lastHeartbeatAt: { $lt: staleCutoff } },
        { lastHeartbeatAt: { $exists: false } },
        { lastHeartbeatAt: null },
      ],
    },
    {
      status: "failed",
      errorMessage:
        "Code generation timed out (no worker heartbeat). Start a new job or restart from Stage 6.",
    },
  );
  // Also mark tasks stuck in generating
  if (genFixed > 0) {
    await Task.updateMany(
      {
        status: "generating",
        $or: [
          { lastHeartbeatAt: { $lt: staleCutoff } },
          { lastHeartbeatAt: { $exists: false } },
        ],
      },
      { status: "failed", errorMessage: "Code generation timed out." },
    );
  }
  total += genFixed;

  // ── 3. quality_gate → failed (stale heartbeat) ────────────────────────────
  const { modifiedCount: qgFixed } = await Job.updateMany(
    {
      status: "quality_gate",
      $or: [
        { lastHeartbeatAt: { $lt: staleCutoff } },
        { lastHeartbeatAt: { $exists: false } },
        { lastHeartbeatAt: null },
      ],
    },
    {
      status: "failed",
      errorMessage:
        "Quality gate timed out (no worker heartbeat). Start a new job or restart from Stage 6.",
    },
  );
  if (qgFixed > 0) {
    await Task.updateMany(
      { status: "quality_gate", $or: [{ lastHeartbeatAt: { $lt: staleCutoff } }, { lastHeartbeatAt: { $exists: false } }] },
      { status: "failed", errorMessage: "Quality gate timed out." },
    );
  }
  total += qgFixed;

  if (total > 0) {
    console.log(
      `[recovery] resolved ${total} stale job(s): ` +
      `${assigningFixed} auto_assigning→awaiting_assignment, ` +
      `${genFixed} generating→failed, ` +
      `${qgFixed} quality_gate→failed`,
    );
  } else {
    console.log("[recovery] no stale jobs found");
  }

  return { assigningFixed, genFixed, qgFixed, total };
}
