/**
 * Code Review Worker — Lead Developer AI Gate
 *
 * Queue: "code-review"
 * Job name: "review-pr"
 * Job data: { jobId: string, prNumber: number, repoFullName: string }
 *
 * Reviews a pull request as the Lead Developer:
 *  1. Fetches the PR diff from GitHub
 *  2. Loads the job's tasks and their requirements
 *  3. Sends diff + requirements to OpenAI for structured review
 *  4. Posts a GitHub review:
 *     - APPROVE       → marks job leadDevReviewStatus: "approved"
 *     - REQUEST_CHANGES → marks job leadDevReviewStatus: "changes_requested",
 *                         enqueues rework for each pushed task
 */
import "dotenv/config";
import { Worker } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { connectDb } from "../lib/db.js";
import { githubClient } from "../lib/githubClient.js";
import { getOpenAI } from "../lib/openaiClient.js";
import { getQueues } from "../lib/queues.js";
import { audit } from "../lib/audit.js";
import Job from "../models/Job.js";
import Task from "../models/Task.js";
import Document from "../models/Document.js";

await connectDb();

// ── OpenAI review tool schema ─────────────────────────────────────────────────

const REVIEW_TOOL = {
  type: "function",
  function: {
    name: "submit_review",
    description: "Submit the Lead Developer code review decision",
    parameters: {
      type: "object",
      required: ["decision", "summary"],
      properties: {
        decision: {
          type: "string",
          enum: ["APPROVE", "REQUEST_CHANGES"],
          description: "APPROVE if the code meets requirements and quality standards; REQUEST_CHANGES if there are issues that must be fixed",
        },
        summary: {
          type: "string",
          description: "2-4 sentence summary of the review for the PR comment",
        },
        issues: {
          type: "array",
          items: { type: "string" },
          description: "List of specific issues found (required when decision is REQUEST_CHANGES)",
        },
      },
    },
  },
};

// ── Build review prompt ───────────────────────────────────────────────────────

function buildReviewPrompt(tasks, diff) {
  const taskBlock = tasks.map((t, i) => {
    const reqs = (t.requirementIds ?? []).join(", ") || "N/A";
    return `Task ${i + 1}: ${t.title}\n  Description: ${t.description ?? "(none)"}\n  Requirements: ${reqs}`;
  }).join("\n\n");

  return `You are the Lead Developer reviewing a pull request.

## Tasks being implemented
${taskBlock}

## Pull Request Diff
\`\`\`diff
${diff}
\`\`\`

Review the diff against the task requirements. Evaluate:
1. Does the implementation satisfy the stated requirements?
2. Are there bugs, logic errors, or missing edge cases?
3. Are there security vulnerabilities (SQL injection, XSS, path traversal, hardcoded secrets)?
4. Is the code quality acceptable (readable, no dead code, no debug artifacts)?
5. Will it integrate cleanly without breaking existing functionality?

Call submit_review with your decision.`;
}

// ── Worker processor ──────────────────────────────────────────────────────────

async function processor(bullJob) {
  const { jobId, prNumber, repoFullName } = bullJob.data;

  console.log(`[code-review-worker] reviewing PR #${prNumber} for job ${jobId}`);

  const orcJob = await Job.findById(jobId);
  if (!orcJob) throw new Error(`Job ${jobId} not found`);

  // Skip if already reviewed
  if (orcJob.leadDevReviewStatus === "approved") {
    console.log(`[code-review-worker] job ${jobId} already approved — skipping`);
    return { skipped: true };
  }

  // ── 1. Fetch PR diff ───────────────────────────────────────────────────────
  const diff = await githubClient.getPullDiff(repoFullName, prNumber);
  console.log(`[code-review-worker] diff fetched — ${diff.length} chars`);

  // ── 2. Load tasks for this job ─────────────────────────────────────────────
  const tasks = await Task.find({ jobId: orcJob._id })
    .select("title description requirementIds pmsTaskId status")
    .lean();

  if (!tasks.length) {
    console.warn(`[code-review-worker] no tasks found for job ${jobId} — auto-approving`);
    await Job.findByIdAndUpdate(jobId, {
      leadDevReviewStatus: "approved",
      leadDevReviewSummary: "No tasks found — approved automatically.",
    });
    return { approved: true, reason: "no_tasks" };
  }

  // ── 3. Call OpenAI ─────────────────────────────────────────────────────────
  const openai = getOpenAI();
  const model = process.env.OPENAI_MODEL ?? "gpt-4o";

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.1,
    tools: [REVIEW_TOOL],
    tool_choice: { type: "function", function: { name: "submit_review" } },
    messages: [
      {
        role: "system",
        content:
          "You are a Senior Lead Developer performing a mandatory code review. " +
          "Be thorough but fair. Approve code that meets requirements and has no critical issues. " +
          "Request changes only for real bugs, security issues, or missing requirements — not style preferences.",
      },
      { role: "user", content: buildReviewPrompt(tasks, diff) },
    ],
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("OpenAI returned no tool call for code review");

  let reviewResult;
  try {
    reviewResult = JSON.parse(toolCall.function.arguments);
  } catch {
    throw new Error(`Failed to parse review result: ${toolCall.function.arguments?.slice(0, 200)}`);
  }

  const { decision, summary, issues = [] } = reviewResult;
  console.log(`[code-review-worker] decision=${decision}  summary="${summary.slice(0, 100)}"`);

  // ── 4. Post GitHub review ──────────────────────────────────────────────────
  const reviewBody = decision === "APPROVE"
    ? `**Lead Developer Review: Approved ✓**\n\n${summary}`
    : `**Lead Developer Review: Changes Requested**\n\n${summary}\n\n**Issues:**\n${issues.map((i) => `- ${i}`).join("\n")}`;

  await githubClient.createReview(repoFullName, prNumber, { event: decision, body: reviewBody });
  console.log(`[code-review-worker] GitHub review posted — ${decision}`);

  // ── 5. Update job + handle rework if needed ────────────────────────────────
  if (decision === "APPROVE") {
    await Job.findByIdAndUpdate(jobId, {
      leadDevReviewStatus: "approved",
      leadDevReviewSummary: summary,
      status: "pr_open",
    });

    audit("system", "pr.lead_review_approved", {
      jobId: orcJob._id,
      details: { prNumber, repoFullName, summary },
    });

    console.log(`[code-review-worker] job ${jobId} approved — prPoll will merge on next poll`);
  } else {
    await Job.findByIdAndUpdate(jobId, {
      leadDevReviewStatus: "changes_requested",
      leadDevReviewSummary: summary,
      status: "changes_requested",
    });

    const reworkReason = [summary, ...issues.map((i) => `- ${i}`)].join("\n");

    const pushedTasks = await Task.find({
      jobId: orcJob._id,
      status: { $in: ["pr_open", "pushed", "in_review"] },
    }).lean();

    const queues = getQueues();
    for (const task of pushedTasks) {
      const retryCount = (task.retryCount ?? 0) + 1;
      await queues.rework.add(
        "create-rework",
        {
          jobId: String(orcJob._id),
          taskId: String(task._id),
          reason: `Lead Developer review requested changes:\n${reworkReason}`,
          retryCount,
        },
        { jobId: `rework-review-${task._id}-${retryCount}` },
      );
    }

    audit("system", "pr.lead_review_changes_requested", {
      jobId: orcJob._id,
      details: { prNumber, repoFullName, summary, issues, reworkCount: pushedTasks.length },
    });

    console.log(`[code-review-worker] changes requested — enqueued ${pushedTasks.length} rework task(s)`);
  }

  return { decision, prNumber };
}

// ── Worker setup ──────────────────────────────────────────────────────────────

const worker = new Worker("code-review", processor, {
  connection: getRedis(),
  concurrency: 3,
});

worker.on("failed", async (bullJob, err) => {
  const { jobId } = bullJob?.data ?? {};
  console.error(`[code-review-worker] failed jobId=${jobId}:`, err.message);
  if (jobId) {
    await Job.findByIdAndUpdate(jobId, {
      errorMessage: `Lead Developer code review failed: ${err.message}`,
    }).catch(() => {});
  }
});

console.log("[code-review-worker] ready (concurrency: 3)");
