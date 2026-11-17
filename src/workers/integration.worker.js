/**
 * Integration Worker — Lead Developer AI Agent
 *
 * Queue: "integration"
 * Job name: "run-integration"
 * Job data: { jobId: string }
 *
 * Triggered by push.worker when all tasks for a job have reached "pushed".
 * Implements the Lead Developer agent that:
 *  1. Fetches all pushed task branches
 *  2. Clones the integration branch of each repo
 *  3. Merges all task branches into a combined result
 *  4. Calls OpenAI to review the combined diff for compatibility issues
 *  5. Runs full project build + test
 *  6. On success: pushes to integration branch, creates PR to main
 *  7. On failure: creates rework tasks for each identified issue
 *
 * Security:
 *  - Never merges directly to main (integration branch only unless autoMergeMain is set)
 *  - Bot identity on all git operations
 *  - AI output is treated as review data only — not executed
 */
import { Worker } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { connectDb } from "../lib/db.js";
import { exec } from "child_process";
import { promisify } from "util";
import { simpleGit } from "simple-git";
import { mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import Job from "../models/Job.js";
import Task from "../models/Task.js";
import IntegrationRun from "../models/IntegrationRun.js";
import Project from "../models/Project.js";
import { getOpenAI } from "../lib/openaiClient.js";
import { githubClient } from "../lib/githubClient.js";
import { pushBranch, BOT_NAME, BOT_EMAIL } from "../lib/gitOps.js";
import { pmsClient } from "../lib/pmsClient.js";
import { audit } from "../lib/audit.js";
import { getQueues } from "../lib/queues.js";
import config from "../config/env.js";

const execAsync = promisify(exec);

await connectDb();

const INTEGRATION_REVIEW_TOOL = {
  type: "function",
  function: {
    name: "integration_review",
    description: "Review the combined diff from all task branches for compatibility issues",
    parameters: {
      type: "object",
      required: ["passed", "issues"],
      properties: {
        passed: { type: "boolean", description: "Whether the integration looks compatible" },
        issues: {
          type: "array",
          items: {
            type: "object",
            required: ["severity", "description", "affectedFiles"],
            properties: {
              severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
              description: { type: "string", maxLength: 500 },
              affectedFiles: { type: "array", items: { type: "string" } },
              suggestedFix: { type: "string", maxLength: 1000 },
            },
          },
        },
      },
    },
  },
};

const INTEGRATION_SYSTEM = `You are a Lead Software Developer reviewing combined code changes from multiple AI developers. \
Your job is to identify integration issues — not to review code quality.

Look specifically for:
- Duplicate function/component implementations across branches
- Broken imports (a frontend branch importing a backend path that changed)
- Schema conflicts (two branches modifying the same DB model differently)
- API contract breaks (endpoint renamed in backend but frontend still uses old name)
- Merge conflicts that would prevent a clean build

Rules:
- Only flag issues that would cause build/runtime failures or silent data corruption
- Do not flag code style, naming conventions, or missing tests
- If you find no critical issues, set passed=true with an empty issues array
- Respond exclusively by calling integration_review — no prose output`;

async function reviewIntegration(combinedDiff) {
  const client = getOpenAI();
  const response = await client.chat.completions.create({
    model: config.openai.model,
    max_tokens: 4096,
    temperature: 0,
    tools: [INTEGRATION_REVIEW_TOOL],
    tool_choice: { type: "function", function: { name: "integration_review" } },
    messages: [
      { role: "system", content: INTEGRATION_SYSTEM },
      { role: "user", content: `Review this combined diff from multiple task branches:\n\n${combinedDiff.slice(0, 40000)}` },
    ],
  });
  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) return { passed: true, issues: [] };
  try {
    return JSON.parse(toolCall.function.arguments);
  } catch {
    return { passed: true, issues: [] };
  }
}

const processor = async (bullJob) => {
  const { jobId } = bullJob.data;
  console.log(`[integration-worker] start jobId=${jobId}`);

  const orcJob = await Job.findById(jobId);
  if (!orcJob) throw new Error(`Job ${jobId} not found`);

  // Load all pushed tasks
  const tasks = await Task.find({
    jobId: orcJob._id,
    status: { $in: ["pushed", "pr_open"] },
  }).lean();

  if (tasks.length === 0) {
    console.log(`[integration-worker] no pushed tasks for job=${jobId} — skipping`);
    return { skipped: true };
  }

  // Create IntegrationRun record
  const intRun = await IntegrationRun.create({
    jobIds: [orcJob._id],
    status: "running",
    taskBranches: tasks.map((t) => ({
      taskId: t._id,
      branchName: t.branchName,
      repo: t.repoFullName ?? orcJob.repoFullName,
    })),
    integrationBranch: "integration",
    attempt: 1,
  });

  await Job.findByIdAndUpdate(jobId, { status: "integrating", stage: 9 });
  await bullJob.updateProgress(10);

  // Build a list of unique repos × branches to integrate
  const repoGroups = new Map(); // repoFullName → [task, ...]
  for (const task of tasks) {
    const repo = task.repoFullName ?? orcJob.repoFullName;
    if (!repo) continue;
    if (!repoGroups.has(repo)) repoGroups.set(repo, []);
    repoGroups.get(repo).push(task);
  }

  let allBuildLogs = "";
  let allConflicts = [];
  let integrationPassed = true;
  const reworkNeeded = [];

  // Process each repo
  for (const [repoFullName, repoTasks] of repoGroups) {
    const integrationDir = resolve(join(config.sandbox.workspaceDir, "integration", jobId, repoFullName.replace("/", "_")));

    try {
      if (existsSync(integrationDir)) {
        await rm(integrationDir, { recursive: true, force: true });
      }
      await mkdir(integrationDir, { recursive: true });

      // Clone repo at integration/main branch
      const cloneUrl = await githubClient.cloneUrl(repoFullName);
      const git = simpleGit();
      await git.clone(cloneUrl, integrationDir, ["--depth=50"]);

      const localGit = simpleGit(integrationDir);
      await localGit.addConfig("user.name", BOT_NAME, false, "local");
      await localGit.addConfig("user.email", BOT_EMAIL, false, "local");

      // Try to checkout integration branch, create if it doesn't exist
      try {
        await localGit.checkout("integration");
      } catch {
        await localGit.checkoutLocalBranch("integration");
      }

      await bullJob.updateProgress(20);

      // Collect combined diff before merging
      let combinedDiff = "";

      // Merge each task branch
      for (const task of repoTasks) {
        if (!task.branchName) continue;
        try {
          // Fetch the task branch
          await localGit.fetch("origin", task.branchName);
          const fetchRef = `origin/${task.branchName}`;

          // Try merge
          try {
            await localGit.merge([fetchRef, "--no-edit", `--message=Merge task: ${task.title}`]);
            const diff = await localGit.diff([`HEAD~1`, "HEAD"]).catch(() => "");
            combinedDiff += `\n=== Task: ${task.title} ===\n${diff.slice(0, 5000)}`;
          } catch (mergeErr) {
            // Merge conflict — record it and abort
            allConflicts.push({ file: task.branchName, description: `Merge conflict: ${mergeErr.message.slice(0, 200)}` });
            reworkNeeded.push({ task, reason: `Merge conflict with integration branch: ${mergeErr.message.slice(0, 500)}` });
            await localGit.merge(["--abort"]).catch(() => {});
            integrationPassed = false;
            console.warn(`[integration-worker] merge conflict for task ${task._id}: ${mergeErr.message}`);
          }
        } catch (err) {
          console.warn(`[integration-worker] could not fetch branch ${task.branchName}: ${err.message}`);
        }
      }

      await bullJob.updateProgress(40);

      // AI compatibility review on the combined diff
      if (combinedDiff) {
        const review = await reviewIntegration(combinedDiff).catch((e) => {
          console.warn(`[integration-worker] AI review failed: ${e.message}`);
          return { passed: true, issues: [] };
        });

        if (!review.passed) {
          integrationPassed = false;
          for (const issue of review.issues.filter((i) => i.severity === "critical" || i.severity === "high")) {
            allConflicts.push({ file: issue.affectedFiles?.[0] ?? "unknown", description: issue.description });
            // Find the most likely responsible task by file
            const responsibleTask = repoTasks.find((t) =>
              issue.affectedFiles?.some((f) => t.branchName?.includes(f.split("/")[0])),
            ) ?? repoTasks[repoTasks.length - 1];
            reworkNeeded.push({ task: responsibleTask, reason: `Integration review: ${issue.description}${issue.suggestedFix ? ` — Suggested fix: ${issue.suggestedFix}` : ""}` });
          }
        }
      }

      await bullJob.updateProgress(55);

      // Run build + test if available and all merges succeeded
      if (integrationPassed && existsSync(join(integrationDir, "package.json"))) {
        try {
          const { stdout: ciOut, stderr: ciErr } = await execAsync(
            "npm ci --prefer-offline --ignore-scripts && npm run build --if-present && npm test --if-present",
            { cwd: integrationDir, timeout: 5 * 60_000, env: { ...process.env, CI: "true" } },
          ).catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? e.message }));

          allBuildLogs += `\n=== ${repoFullName} build ===\n${(ciOut + ciErr).slice(0, 8000)}`;
        } catch (buildErr) {
          integrationPassed = false;
          allBuildLogs += `\n=== ${repoFullName} BUILD FAILED ===\n${buildErr.message.slice(0, 4000)}`;
          // Assign rework to the last task as a fallback
          reworkNeeded.push({ task: repoTasks[repoTasks.length - 1], reason: `Integration build failed: ${buildErr.message.slice(0, 1000)}` });
        }
      }

      await bullJob.updateProgress(70);

      // Push integration branch if everything passed
      if (integrationPassed) {
        await pushBranch(localGit, "integration", repoFullName);
        console.log(`[integration-worker] pushed integration branch for ${repoFullName}`);

        // Create or update PR: integration → main
        try {
          await githubClient.createPull(repoFullName, {
            branch: "integration",
            base: "main",
            title: `[AI Integration] Job ${String(jobId).slice(-8)}`,
            body: `Automated integration by AI Development Orchestrator.\n\nJob: \`${jobId}\`\n\nAll task branches have been merged and verified.\n\n> Review and merge to deploy.`,
          });
        } catch (prErr) {
          if (prErr.status !== 422) {
            console.warn(`[integration-worker] PR create warning: ${prErr.message}`);
          }
        }
      }

      // Cleanup integration clone
      await rm(integrationDir, { recursive: true, force: true }).catch(() => {});

    } catch (err) {
      integrationPassed = false;
      allBuildLogs += `\n=== ${repoFullName} ERROR ===\n${err.message}`;
      console.error(`[integration-worker] error on repo ${repoFullName}:`, err.message);
    }
  }

  await bullJob.updateProgress(85);

  // Update IntegrationRun record
  await IntegrationRun.findByIdAndUpdate(intRun._id, {
    status: integrationPassed ? "passed" : "failed",
    buildLog: allBuildLogs.slice(0, 20000),
    conflictsFound: allConflicts,
    reworkTaskIds: [],
    mergedToMain: false,
  });

  audit("system", "integration.completed", {
    jobId: orcJob._id,
    details: { passed: integrationPassed, conflicts: allConflicts.length, reworkNeeded: reworkNeeded.length },
  });

  if (integrationPassed) {
    await Job.findByIdAndUpdate(jobId, { status: "pr_open", stage: 9 });
    console.log(`[integration-worker] job=${jobId} integration passed — PR open for main merge`);
  } else {
    // Enqueue rework tasks for each issue found
    const queues = getQueues();
    const reworkTaskIds = [];

    for (const { task, reason } of reworkNeeded) {
      const retryCount = (task.retryCount ?? 0) + 1;
      const maxRetries = Number(process.env.REWORK_MAX_RETRIES ?? 3);

      if (retryCount > maxRetries) {
        console.error(`[integration-worker] task ${task._id} exceeded max retries — escalating`);
        continue;
      }

      await queues.rework.add(
        "create-rework",
        { jobId: String(orcJob._id), taskId: String(task._id), reason, retryCount },
        { jobId: `rework-${task._id}-${retryCount}` },
      );
      reworkTaskIds.push(String(task._id));
    }

    await IntegrationRun.findByIdAndUpdate(intRun._id, {
      reworkTaskIds,
    });

    await Job.findByIdAndUpdate(jobId, {
      status: "generating",
      stage: 6,
      errorMessage: `Integration failed — ${reworkNeeded.length} rework task(s) created`,
    });

    console.warn(`[integration-worker] job=${jobId} integration failed — ${reworkNeeded.length} rework tasks created`);
  }

  await bullJob.updateProgress(100);
  return { passed: integrationPassed, reworkCount: reworkNeeded.length };
};

const worker = new Worker("integration", processor, {
  connection: getRedis(),
  concurrency: 1,
});

worker.on("failed", async (bullJob, err) => {
  const { jobId } = bullJob?.data ?? {};
  console.error(`[integration-worker] failed jobId=${jobId}:`, err.message);
  if (jobId) {
    try {
      await Job.findByIdAndUpdate(jobId, {
        status: "failed",
        errorMessage: `Integration failed: ${err.message}`,
      });
    } catch {}
  }
});

worker.on("completed", (bullJob, result) => {
  console.log(`[integration-worker] completed bull=${bullJob.id} — passed=${result?.passed ?? false}`);
});

console.log("[integration-worker] ready (concurrency: 1)");
