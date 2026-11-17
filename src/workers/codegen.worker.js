/**
 * Code Generation Worker — Phase 4
 *
 * Job name: "generate-code"
 * Job data: { jobId: string, pmsTaskId: string }
 *
 * Flow:
 *  1.  Load the orchestrator Job + Task document
 *  2.  Acquire a per-repo Redis lock (serializes codegen within the same repo,
 *      allows parallel runs across different repos)
 *  3.  Load the PMS task (title, description, type, priority, points)
 *  4.  Set up a per-task isolated clone directory: <workspaceDir>/clones/<jobId>/<taskId>
 *  5.  Clone the repo fresh (guarantees latest main, avoids stale-clone conflicts)
 *  6.  Record the base branch HEAD SHA (cloneBaseSha)
 *  7.  Create feature branch: orch/<shortJobId>/<kebabTitle>
 *  8.  Build codebase context from tracked files
 *  9.  Call OpenAI generateCodeForTask
 * 10.  Write each AI-generated file via writeFileSafe (path-traversal protected)
 * 11.  Commit with bot identity (never impersonates a human)
 * 12.  Compute diff + parse stats
 * 13.  Check for base-branch conflicts (non-blocking warning)
 * 14.  Save branch name, diff, clone path and conflict info on the Task + Job
 * 15.  Enqueue quality gate; release repo lock
 *
 * Concurrency model:
 *  - Worker concurrency: 5  (up to 5 tasks running in parallel across repos)
 *  - Per-repo lock (Redis SET NX EX): only one task at a time per repo
 *    so two tasks touching the same repo serialize naturally while tasks
 *    on different repos run fully in parallel.
 *
 * Security constraints enforced:
 *  - BOT_NAME / BOT_EMAIL on every commit — no human impersonation
 *  - writeFileSafe blocks path traversal and .env writes
 *  - AI output is treated as data only — no shell execution
 *  - No arbitrary command injection from task description (CODEGEN_SYSTEM prompt blocks it)
 */
import { Worker } from "bullmq";
import { existsSync } from "fs";
import { getRedis } from "../lib/redis.js";
import { connectDb } from "../lib/db.js";
import { pmsClient } from "../lib/pmsClient.js";
import { generateCodeForTask } from "../lib/openaiClient.js";
import { writeFileSafe } from "../lib/fileSandbox.js";
import {
  cloneDirForTask,
  cloneRepo,
  createBranch,
  commitChanges,
  getDiff,
  getHeadSha,
  buildCodebaseContext,
  parseDiffStat,
  cleanupClone,
  BOT_NAME,
  BOT_EMAIL,
} from "../lib/gitOps.js";
import { detectConflicts } from "../lib/conflictDetect.js";
import { audit } from "../lib/audit.js";
import { getQueues } from "../lib/queues.js";
import { recordCost } from "../lib/costTracker.js";
import config from "../config/env.js";
import Job from "../models/Job.js";
import Task from "../models/Task.js";

await connectDb();

// ── Per-repo distributed lock (ioredis SET NX EX) ────────────────────────────
// Prevents two tasks on the same repo from cloning/branching simultaneously.
// Lock TTL is generous (15 min) — released explicitly in finally{} on every path.
const LOCK_TTL_S = 15 * 60;
const LOCK_RETRY_MS = 5_000;
const LOCK_MAX_WAIT_MS = 10 * 60_000; // give up after 10 min of waiting

async function acquireRepoLock(repoFullName, taskId) {
  const key = `codegen:lock:${repoFullName.replace(/\//g, ":")}`;
  const value = String(taskId);
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const ok = await getRedis().set(key, value, "NX", "EX", LOCK_TTL_S);
    if (ok === "OK") {
      console.log(`[codegen-worker] acquired repo lock for ${repoFullName} (task=${taskId})`);
      return key;
    }
    const holder = await getRedis().get(key);
    console.log(`[codegen-worker] repo ${repoFullName} locked by task=${holder}, waiting ${LOCK_RETRY_MS}ms…`);
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
  throw new Error(`Could not acquire repo lock for ${repoFullName} within ${LOCK_MAX_WAIT_MS / 1000}s`);
}

async function releaseRepoLock(lockKey, taskId) {
  try {
    const holder = await getRedis().get(lockKey);
    if (holder === String(taskId)) {
      await getRedis().del(lockKey);
      console.log(`[codegen-worker] released repo lock ${lockKey}`);
    }
  } catch (e) {
    console.warn(`[codegen-worker] could not release lock ${lockKey}:`, e.message);
  }
}

async function heartbeat(jobId, taskId) {
  const now = new Date();
  await Job.findByIdAndUpdate(jobId, { lastHeartbeatAt: now });
  if (taskId) await Task.findByIdAndUpdate(taskId, { lastHeartbeatAt: now });
}

/** Sanitize a string to a safe branch-name segment (lowercase, hyphens only) */
function toBranchSlug(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
}

const processor = async (bullJob) => {
  const { jobId, pmsTaskId } = bullJob.data;
  console.log(`[codegen-worker] start job=${jobId} pmsTaskId=${pmsTaskId}`);

  // ── Step 1: Load orchestrator job + Task document ────────────────────────
  const orcJob = await Job.findById(jobId);
  if (!orcJob) throw new Error(`Job ${jobId} not found`);

  // Find the Task document (best-effort — may not exist on legacy jobs)
  const taskDoc = pmsTaskId
    ? await Task.findOne({ jobId, pmsTaskId })
    : null;

  // Use per-task repoFullName if set (multi-repo routing), fall back to job's
  const repoFullName = taskDoc?.repoFullName || orcJob.repoFullName;
  if (!repoFullName) throw new Error("No repoFullName on task or job");

  if (taskDoc) {
    taskDoc.status = "generating";
    taskDoc.lastHeartbeatAt = new Date();
    await taskDoc.save();
  }

  // ── Step 2: Acquire per-repo lock ─────────────────────────────────────────
  // Serializes within the same repo; tasks on different repos run in parallel.
  const lockId = taskDoc?._id ?? `${jobId}-${pmsTaskId}`;
  const lockKey = await acquireRepoLock(repoFullName, lockId);

  try {

  // ── Step 3: Load PMS task ─────────────────────────────────────────────────
  await pmsClient.ensureSession();
  let pmsTask;
  try {
    pmsTask = await pmsClient.getTask(pmsTaskId);
  } catch (err) {
    throw new Error(`Could not load PMS task ${pmsTaskId}: ${err.message}`);
  }

  const task = {
    title: pmsTask.title ?? "Untitled task",
    description: pmsTask.description ?? "",
    type: pmsTask.type ?? "task",
    priority: pmsTask.priority ?? "medium",
    points: pmsTask.points ?? null,
  };

  await bullJob.updateProgress(5);
  console.log(`[codegen-worker] implementing: "${task.title}"`);

  // ── Step 4: Set up per-task isolated clone directory ─────────────────────
  // Each task gets its own dir (clones/<jobId>/<taskId>) so tasks of the same
  // job never wipe each other's working tree.
  const cloneDir = cloneDirForTask(jobId, String(taskDoc?._id ?? pmsTaskId));

  // If a stale clone exists (e.g. from a failed prior attempt), remove it
  if (existsSync(cloneDir)) {
    console.log(`[codegen-worker] removing stale clone at ${cloneDir}`);
    await cleanupClone(cloneDir);
  }

  // ── Step 5: Clone repo ────────────────────────────────────────────────────
  console.log(`[codegen-worker] cloning ${repoFullName} → ${cloneDir}`);
  let git;
  try {
    git = await cloneRepo(repoFullName, cloneDir);
  } catch (err) {
    throw new Error(`Clone failed for ${repoFullName}: ${err.message}`);
  }

  await bullJob.updateProgress(20);
  await heartbeat(jobId, taskDoc?._id);

  // ── Step 6: Record base SHA ───────────────────────────────────────────────
  // Determine the base branch (default branch of the PMS project)
  let baseBranch = "main";
  try {
    const symref = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    baseBranch = symref.trim().replace("refs/remotes/origin/", "") || "main";
  } catch {}

  const cloneBaseSha = await getHeadSha(git);
  orcJob.cloneBaseSha = cloneBaseSha;

  // ── Step 7: Create feature branch ────────────────────────────────────────
  const shortJobId = String(jobId).slice(-8);
  const branchName = `orch/${shortJobId}/${toBranchSlug(task.title)}`;
  try {
    await createBranch(git, branchName, baseBranch);
  } catch (err) {
    throw new Error(`Failed to create branch "${branchName}": ${err.message}`);
  }

  orcJob.branchName = branchName;
  orcJob.aiModel = process.env.OPENAI_MODEL ?? "gpt-4o";

  await bullJob.updateProgress(30);

  // ── Step 8: Build codebase context ───────────────────────────────────────
  console.log(`[codegen-worker] building codebase context…`);
  let codebaseContext;
  try {
    codebaseContext = await buildCodebaseContext(git, cloneDir, task);
  } catch (err) {
    console.warn("[codegen-worker] context build warning:", err.message);
    codebaseContext = "(Could not read codebase context)";
  }

  await bullJob.updateProgress(40);

  // ── Step 9: Generate code via OpenAI ─────────────────────────────────────
  console.log(`[codegen-worker] calling OpenAI to generate code…`);
  let generated;
  try {
    generated = await generateCodeForTask(task, codebaseContext);
  } catch (err) {
    throw new Error(`OpenAI code generation failed: ${err.message}`);
  }

  if (!generated.files || generated.files.length === 0) {
    throw new Error("AI returned no files — cannot proceed. Check OPENAI_MODEL and task description.");
  }

  console.log(`[codegen-worker] AI generated ${generated.files.length} file(s)`);
  await bullJob.updateProgress(60);
  await heartbeat(jobId, taskDoc?._id);

  // Record AI token cost
  if (generated.usage) {
    await recordCost({
      jobId: String(orcJob._id),
      taskId: taskDoc?._id ? String(taskDoc._id) : undefined,
      operation: "generate_code",
      model: config.openai.model,
      promptTokens:     generated.usage.prompt_tokens     ?? 0,
      completionTokens: generated.usage.completion_tokens ?? 0,
    }).catch((e) => console.warn("[codegen-worker] cost record failed:", e.message));
  }

  // ── Step 10: Write files (path-traversal protected) ──────────────────────
  const writtenPaths = [];
  const writeErrors = [];

  for (const { path: filePath, content } of generated.files) {
    if (!filePath || typeof content !== "string") {
      writeErrors.push(`Skipped invalid file entry: ${filePath}`);
      continue;
    }
    try {
      await writeFileSafe(cloneDir, filePath, content);
      writtenPaths.push(filePath);
      console.log(`[codegen-worker] wrote ${filePath}`);
    } catch (err) {
      writeErrors.push(`${filePath}: ${err.message}`);
      console.error(`[codegen-worker] blocked write to "${filePath}": ${err.message}`);
    }
  }

  if (writtenPaths.length === 0) {
    throw new Error(
      `All ${generated.files.length} AI file write(s) were blocked. Errors: ${writeErrors.join("; ")}`
    );
  }

  if (writeErrors.length > 0) {
    console.warn(`[codegen-worker] ${writeErrors.length} write(s) blocked:`, writeErrors);
  }

  await bullJob.updateProgress(70);

  // ── Step 11: Commit with bot identity ────────────────────────────────────
  const commitMsg = [
    generated.commitMessage || `feat: ${task.title.slice(0, 72)}`,
    "",
    `AI-generated code for PMS task: ${task.title}`,
    `Job ID: ${jobId}`,
    `PMS Task ID: ${pmsTaskId}`,
    "",
    // Explicit bot attribution — never impersonates a human
    `AI Developer: ${BOT_NAME} <${BOT_EMAIL}>`,
    `Generated-by: AI Orchestrator`,
  ].join("\n");

  await commitChanges(git, commitMsg);

  await bullJob.updateProgress(80);
  await heartbeat(jobId, taskDoc?._id);

  // ── Step 12: Compute diff ────────────────────────────────────────────────
  let rawDiff = "";
  try {
    rawDiff = await getDiff(git, baseBranch);
  } catch (err) {
    console.warn("[codegen-worker] diff warning:", err.message);
  }

  const diffStats = rawDiff ? parseDiffStat(rawDiff) : {
    summary: `${writtenPaths.length} file(s) written`,
    filesChanged: writtenPaths.length,
    additions: 0,
    deletions: 0,
    files: writtenPaths.map((p) => ({ path: p, additions: 0, deletions: 0, patch: "" })),
  };

  await bullJob.updateProgress(90);

  // ── Step 13: Conflict detection (non-blocking) ───────────────────────────
  let conflictInfo = null;
  try {
    conflictInfo = await detectConflicts(git, baseBranch, cloneBaseSha);
    if (conflictInfo.diverged) {
      console.warn("[codegen-worker] base branch diverged:", conflictInfo.message);
    }
  } catch (err) {
    console.warn("[codegen-worker] conflict detection failed:", err.message);
  }

  // ── Step 14: Persist diff results ────────────────────────────────────────
  const finalDiffSummary = {
    ...diffStats,
    conflict: conflictInfo,
    writtenFiles: writtenPaths,
    blockedFiles: writeErrors,
  };

  orcJob.diffSummary = finalDiffSummary;
  orcJob.clonePath = cloneDir;
  // Job advances to quality_gate (Stage 3 is handled by qualityGate.worker)
  orcJob.status = "quality_gate";

  if (writeErrors.length > 0) {
    orcJob.errorMessage = `${writeErrors.length} file(s) blocked by security policy: ${writeErrors.slice(0, 3).join("; ")}`;
  }

  await orcJob.save();

  // Update Task document with branch + diff info and queue for quality gate
  if (taskDoc) {
    taskDoc.status = "quality_gate";
    taskDoc.branchName = branchName;
    taskDoc.clonePath = cloneDir;
    taskDoc.diffSummary = finalDiffSummary;
    taskDoc.repoFullName = repoFullName;
    taskDoc.lastHeartbeatAt = new Date();
    await taskDoc.save();
  }

  audit("system", "codegen.completed", {
    jobId: orcJob._id,
    details: {
      branchName,
      filesWritten: writtenPaths.length,
      filesBlocked: writeErrors.length,
      diffStats: { filesChanged: diffStats.filesChanged, additions: diffStats.additions, deletions: diffStats.deletions },
      conflictDiverged: conflictInfo?.diverged ?? false,
    },
  });

  // ── Step 15: Enqueue quality gate; lock released in finally{} ───────────
  if (taskDoc) {
    const queues = getQueues();
    await queues.qualityGate.add(
      "run-quality-gate",
      { jobId: String(orcJob._id), taskId: String(taskDoc._id) },
      { jobId: `qgate-${orcJob._id}-${taskDoc._id}` },
    );
    console.log(`[codegen-worker] enqueued quality-gate for task=${taskDoc._id}`);
  } else {
    // Legacy job with no Task document — skip quality gate, enqueue push directly
    const queues = getQueues();
    await queues.push.add(
      "push-branch",
      { jobId: String(orcJob._id), taskId: null },
      { jobId: `push-${orcJob._id}-legacy` },
    );
  }

  await bullJob.updateProgress(100);
  console.log(`[codegen-worker] done job=${jobId} branch=${branchName} files=${writtenPaths.length}`);

  return {
    branchName,
    filesWritten: writtenPaths.length,
    filesBlocked: writeErrors.length,
    diffStats,
  };

  } finally {
    await releaseRepoLock(lockKey, lockId);
  }
};

const worker = new Worker("codegen", processor, {
  connection: getRedis(),
  concurrency: 5, // up to 5 tasks in parallel; per-repo Redis lock serializes within each repo
});

worker.on("failed", async (bullJob, err) => {
  const { jobId, pmsTaskId } = bullJob?.data ?? {};
  console.error(`[codegen-worker] failed job=${jobId}:`, err.message);
  if (jobId) {
    try {
      // Find and clean up the per-task clone dir (best-effort)
      const taskDoc = pmsTaskId ? await Task.findOne({ jobId, pmsTaskId }) : null;
      if (taskDoc?.clonePath) {
        await cleanupClone(taskDoc.clonePath).catch(() => {});
      }

      await Job.findByIdAndUpdate(jobId, {
        status: "failed",
        errorMessage: `Code generation failed: ${err.message}`,
      });

      if (pmsTaskId) {
        await Task.findOneAndUpdate(
          { jobId, pmsTaskId },
          { status: "failed", errorMessage: `Code generation failed: ${err.message}` },
        );
      }
    } catch (dbErr) {
      console.error("[codegen-worker] could not update status:", dbErr.message);
    }
  }
});

worker.on("completed", (bullJob, result) => {
  console.log(
    `[codegen-worker] completed bull=${bullJob.id} — ${result?.filesWritten ?? 0} files written`
  );
});

console.log("[codegen-worker] ready (concurrency: 1)");
