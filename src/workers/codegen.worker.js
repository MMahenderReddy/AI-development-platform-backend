/**
 * Code Generation Worker — Phase 4
 *
 * Job name: "generate-code"
 * Job data: { jobId: string, pmsTaskId: string }
 *
 * Flow:
 *  1.  Load the orchestrator Job
 *  2.  Load the PMS task (title, description, type, priority, points)
 *  3.  Set up a persistent clone directory: <workspaceDir>/clones/<jobId>
 *  4.  Clone the repo (or wipe and re-clone if stale)
 *  5.  Record the base branch HEAD SHA (cloneBaseSha)
 *  6.  Create feature branch: orch/<shortJobId>/<kebabTitle>
 *  7.  Build codebase context from tracked files
 *  8.  Call OpenAI generateCodeForTask
 *  9.  Write each AI-generated file via writeFileSafe (path-traversal protected)
 * 10.  Commit with bot identity (never impersonates a human)
 * 11.  Compute diff + parse stats
 * 12.  Check for base-branch conflicts (non-blocking warning)
 * 13.  Save branch name, diff, clone path and conflict info on the Job
 * 14.  Advance job → awaiting_diff_approval (Stage 7)
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
  cloneDirForJob,
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
  if (!orcJob.repoFullName) throw new Error("Job has no repoFullName");

  // Find the Task document (best-effort — may not exist on legacy jobs)
  const taskDoc = pmsTaskId
    ? await Task.findOne({ jobId, pmsTaskId })
    : null;

  if (taskDoc) {
    taskDoc.status = "generating";
    taskDoc.lastHeartbeatAt = new Date();
    await taskDoc.save();
  }

  // ── Step 2: Load PMS task ─────────────────────────────────────────────────
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

  // ── Step 3: Set up clone directory ────────────────────────────────────────
  const cloneDir = cloneDirForJob(jobId);

  // If a stale clone exists, remove it and start fresh
  if (existsSync(cloneDir)) {
    console.log(`[codegen-worker] removing stale clone at ${cloneDir}`);
    await cleanupClone(cloneDir);
  }

  // ── Step 4: Clone repo ────────────────────────────────────────────────────
  console.log(`[codegen-worker] cloning ${orcJob.repoFullName} → ${cloneDir}`);
  let git;
  try {
    git = await cloneRepo(orcJob.repoFullName, cloneDir);
  } catch (err) {
    throw new Error(`Clone failed for ${orcJob.repoFullName}: ${err.message}`);
  }

  await bullJob.updateProgress(20);
  await heartbeat(jobId, taskDoc?._id);

  // ── Step 5: Record base SHA ───────────────────────────────────────────────
  // Determine the base branch (default branch of the PMS project)
  let baseBranch = "main";
  try {
    const symref = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    baseBranch = symref.trim().replace("refs/remotes/origin/", "") || "main";
  } catch {}

  const cloneBaseSha = await getHeadSha(git);
  orcJob.cloneBaseSha = cloneBaseSha;

  // ── Step 6: Create feature branch ────────────────────────────────────────
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

  // ── Step 7: Build codebase context ───────────────────────────────────────
  console.log(`[codegen-worker] building codebase context…`);
  let codebaseContext;
  try {
    codebaseContext = await buildCodebaseContext(git, cloneDir, task);
  } catch (err) {
    console.warn("[codegen-worker] context build warning:", err.message);
    codebaseContext = "(Could not read codebase context)";
  }

  await bullJob.updateProgress(40);

  // ── Step 8: Generate code via OpenAI ─────────────────────────────────────
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

  // ── Step 9: Write files (path-traversal protected) ───────────────────────
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

  // ── Step 10: Commit with bot identity ─────────────────────────────────────
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

  // ── Step 11: Compute diff ─────────────────────────────────────────────────
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

  // ── Step 12: Conflict detection (non-blocking) ────────────────────────────
  let conflictInfo = null;
  try {
    conflictInfo = await detectConflicts(git, baseBranch, cloneBaseSha);
    if (conflictInfo.diverged) {
      console.warn("[codegen-worker] base branch diverged:", conflictInfo.message);
    }
  } catch (err) {
    console.warn("[codegen-worker] conflict detection failed:", err.message);
  }

  // ── Step 13: Persist diff results ────────────────────────────────────────
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
    taskDoc.repoFullName = orcJob.repoFullName;
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

  // ── Step 14: Enqueue quality gate ────────────────────────────────────────
  if (taskDoc) {
    const queues = getQueues();
    await queues.qualityGate.add(
      "run-quality-gate",
      { jobId: String(orcJob._id), taskId: String(taskDoc._id) },
      { jobId: `qgate:${orcJob._id}:${taskDoc._id}` },
    );
    console.log(`[codegen-worker] enqueued quality-gate for task=${taskDoc._id}`);
  } else {
    // Legacy job with no Task document — skip quality gate, advance directly
    orcJob.status = "awaiting_diff_approval";
    orcJob.stage = 7;
    await orcJob.save();
  }

  await bullJob.updateProgress(100);
  console.log(`[codegen-worker] done job=${jobId} branch=${branchName} files=${writtenPaths.length}`);

  return {
    branchName,
    filesWritten: writtenPaths.length,
    filesBlocked: writeErrors.length,
    diffStats,
  };
};

const worker = new Worker("codegen", processor, {
  connection: getRedis(),
  concurrency: 1, // serialized per repo — only one code-gen at a time
});

worker.on("failed", async (bullJob, err) => {
  const { jobId, pmsTaskId } = bullJob?.data ?? {};
  console.error(`[codegen-worker] failed job=${jobId}:`, err.message);
  if (jobId) {
    try {
      const cloneDir = cloneDirForJob(jobId);
      await cleanupClone(cloneDir);

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
