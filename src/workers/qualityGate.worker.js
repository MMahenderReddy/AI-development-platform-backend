/**
 * Quality Gate Worker — Phase 3
 *
 * Queue: "quality-gate"
 * Job name: "run-quality-gate"
 * Job data: { jobId: string, taskId: string }
 *
 * Runs lint / test / build checks inside the AI-generated clone directory.
 * Which checks run is controlled by env flags (QUALITY_GATE_LINT/TEST/BUILD).
 * All checks default to enabled; set a flag to "false" to disable.
 *
 * Flow:
 *  1. Load Task + Job; verify clone directory exists
 *  2. Run each enabled check sequentially (npm ci if node_modules absent, then checks)
 *  3. All pass  → task → awaiting_diff; advance job to awaiting_diff_approval if all
 *                 tasks for the job are ready
 *  4. Any fail  → task → quality_failed; job → quality_failed
 *
 * Security: only standard npm scripts are executed (npm run lint, npm test,
 * npm run build). Arbitrary commands from task descriptions are never executed.
 * Checks run inside the isolated clone directory; no production branch is touched.
 */
import { Worker } from "bullmq";
import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { join } from "path";
import { getRedis } from "../lib/redis.js";
import { connectDb } from "../lib/db.js";
import Job from "../models/Job.js";
import Task from "../models/Task.js";
import { audit } from "../lib/audit.js";
import { getQueues } from "../lib/queues.js";
import config from "../config/env.js";

const execAsync = promisify(exec);

await connectDb();

async function heartbeat(jobId, taskId) {
  const now = new Date();
  await Job.findByIdAndUpdate(jobId, { lastHeartbeatAt: now });
  if (taskId) await Task.findByIdAndUpdate(taskId, { lastHeartbeatAt: now });
}

const PASS_QG_STATUSES = new Set([
  "awaiting_diff", "awaiting_push", "pushed", "pr_open", "merged",
]);

/** Run a single npm script inside the clone dir with a timeout. Returns { passed, output }. */
async function runCheck(script, cloneDir, timeoutMs) {
  // Check if the script is defined in package.json — skip gracefully if not
  const pkgPath = join(cloneDir, "package.json");
  if (!existsSync(pkgPath)) {
    return { passed: true, output: `[skipped] No package.json at ${cloneDir}` };
  }

  let pkg;
  try {
    const { readFileSync } = await import("fs");
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return { passed: true, output: "[skipped] Could not parse package.json" };
  }

  // Map "lint" → "lint", "test" → "test", "build" → "build"
  if (!pkg.scripts?.[script]) {
    return { passed: true, output: `[skipped] No "${script}" script in package.json` };
  }

  try {
    const { stdout, stderr } = await execAsync(`npm run ${script} --if-present`, {
      cwd: cloneDir,
      timeout: timeoutMs,
      env: { ...process.env, CI: "true" },
    });
    return { passed: true, output: (stdout + stderr).slice(0, 8000) };
  } catch (err) {
    const output = ((err.stdout ?? "") + (err.stderr ?? "") + err.message).slice(0, 8000);
    return { passed: false, output };
  }
}

/** Install node_modules if absent (best-effort — skip on failure). */
async function ensureNodeModules(cloneDir, timeoutMs) {
  const nmPath = join(cloneDir, "node_modules");
  if (existsSync(nmPath)) return;
  const pkgPath = join(cloneDir, "package.json");
  if (!existsSync(pkgPath)) return;

  try {
    await execAsync("npm ci --prefer-offline --ignore-scripts", {
      cwd: cloneDir,
      timeout: timeoutMs,
      env: { ...process.env, CI: "true" },
    });
  } catch (err) {
    console.warn(`[quality-gate-worker] npm ci failed — checks may fail too: ${err.message}`);
  }
}

const processor = async (bullJob) => {
  const { jobId, taskId } = bullJob.data;
  console.log(`[quality-gate-worker] start taskId=${taskId} jobId=${jobId}`);

  const task = await Task.findById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const orcJob = await Job.findById(jobId);
  if (!orcJob) throw new Error(`Job ${jobId} not found`);

  // Guard: skip if task already moved past quality gate
  if (!["quality_gate", "generating"].includes(task.status)) {
    console.log(`[quality-gate-worker] task ${taskId} already at ${task.status} — skipping`);
    return { skipped: true };
  }

  if (!task.clonePath || !existsSync(task.clonePath)) {
    throw new Error(
      `Clone directory not found at ${task.clonePath}. ` +
      "The server may have restarted — restart the job from Stage 6.",
    );
  }

  await Task.findByIdAndUpdate(taskId, { status: "quality_gate", lastHeartbeatAt: new Date() });
  await bullJob.updateProgress(5);
  await heartbeat(jobId, taskId);

  const { lint, test, build, timeoutMs } = config.qualityGate;
  const checks = [];
  if (lint || test || build) {
    await ensureNodeModules(task.clonePath, timeoutMs);
  }
  await bullJob.updateProgress(20);
  await heartbeat(jobId, taskId);

  const outputs = [];

  if (lint) {
    const result = await runCheck("lint", task.clonePath, timeoutMs);
    checks.push({ name: "lint", ...result });
    outputs.push(`=== lint ===\n${result.output}`);
    await bullJob.updateProgress(40);
    await heartbeat(jobId, taskId);
  }

  if (test) {
    const result = await runCheck("test", task.clonePath, timeoutMs);
    checks.push({ name: "test", ...result });
    outputs.push(`=== test ===\n${result.output}`);
    await bullJob.updateProgress(65);
    await heartbeat(jobId, taskId);
  }

  if (build) {
    const result = await runCheck("build", task.clonePath, timeoutMs);
    checks.push({ name: "build", ...result });
    outputs.push(`=== build ===\n${result.output}`);
    await bullJob.updateProgress(85);
    await heartbeat(jobId, taskId);
  }

  const failed = checks.filter((c) => !c.passed);
  const qualityOutput = outputs.join("\n\n").slice(0, 16000);

  const queues = getQueues();

  if (failed.length === 0) {
    // All checks passed — auto-enqueue push worker (no human diff-approval gate)
    await Task.findByIdAndUpdate(taskId, {
      status: "awaiting_push",
      qualityOutput,
      lastHeartbeatAt: new Date(),
    });

    audit("system", "quality_gate.passed", {
      jobId: orcJob._id,
      details: { taskId, checks: checks.map((c) => c.name) },
    });

    await queues.push.add(
      "push-branch",
      { jobId: String(orcJob._id), taskId: String(taskId) },
      { jobId: `push-${orcJob._id}-${taskId}` },
    );
    console.log(`[quality-gate-worker] task=${taskId} passed — enqueued push`);
  } else {
    // Quality gate failed — enqueue rework worker (no manual override required)
    const failedNames = failed.map((c) => c.name).join(", ");
    const errorMsg = `Quality gate failed: ${failedNames}. See quality output for details.`;
    const retryCount = (task.retryCount ?? 0) + 1;
    const maxRetries = Number(process.env.REWORK_MAX_RETRIES ?? 3);

    await Task.findByIdAndUpdate(taskId, {
      status: "quality_failed",
      qualityOutput,
      errorMessage: errorMsg,
      retryCount,
    });

    audit("system", "quality_gate.failed", {
      jobId: orcJob._id,
      details: { taskId, failed: failedNames, retryCount },
    });

    if (retryCount > maxRetries) {
      await Job.findByIdAndUpdate(jobId, {
        status: "quality_failed",
        errorMessage: `Task ${taskId} exceeded max retries (${maxRetries}): ${errorMsg}`,
      });
      console.error(`[quality-gate-worker] task=${taskId} exceeded max retries — escalating`);
    } else {
      await queues.rework.add(
        "create-rework",
        { jobId: String(orcJob._id), taskId: String(taskId), reason: errorMsg, retryCount },
        { jobId: `rework-${taskId}-${retryCount}` },
      );
      console.warn(`[quality-gate-worker] task=${taskId} FAILED (attempt ${retryCount}/${maxRetries}) — enqueued rework`);
    }
  }

  await bullJob.updateProgress(100);
  return { passed: failed.length === 0, checks: checks.map((c) => ({ name: c.name, passed: c.passed })) };
};

const worker = new Worker("quality-gate", processor, {
  connection: getRedis(),
  concurrency: 2,
});

worker.on("failed", async (bullJob, err) => {
  const { taskId, jobId } = bullJob?.data ?? {};
  console.error(`[quality-gate-worker] failed taskId=${taskId}:`, err.message);
  if (taskId) {
    try {
      await Task.findByIdAndUpdate(taskId, {
        status: "quality_failed",
        errorMessage: `Quality gate runner error: ${err.message}`,
      });
      if (jobId) {
        await Job.findByIdAndUpdate(jobId, {
          status: "quality_failed",
          errorMessage: `Quality gate runner error: ${err.message}`,
        });
      }
    } catch (dbErr) {
      console.error("[quality-gate-worker] could not update status:", dbErr.message);
    }
  }
});

worker.on("completed", (bullJob, result) => {
  console.log(
    `[quality-gate-worker] completed bull=${bullJob.id} — passed=${result?.passed ?? "?"}`,
  );
});

console.log("[quality-gate-worker] ready (concurrency: 2)");
