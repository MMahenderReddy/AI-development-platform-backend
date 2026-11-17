import { Router } from "express";
import { existsSync } from "fs";
import { simpleGit } from "simple-git";
import Job from "../models/Job.js";
import Task from "../models/Task.js";
import Approval from "../models/Approval.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { notFound, badRequest, conflict } from "../lib/errors.js";
import { pmsClient } from "../lib/pmsClient.js";
import config from "../config/env.js";
import { githubClient } from "../lib/githubClient.js";
import { pushBranch } from "../lib/gitOps.js";
import { getQueues } from "../lib/queues.js";
import { audit } from "../lib/audit.js";
import { getJobCostSummary } from "../lib/costTracker.js";

const TASK_TYPES = ["task", "bug", "feature", "improvement"];
const PRIORITIES = ["urgent", "high", "medium", "low"];
const STORY_POINTS = [1, 2, 3, 5, 8, 13];

const sanitiseTitle = (s) => String(s ?? "").trim().slice(0, 140);
const sanitiseDescription = (s) => String(s ?? "").trim().slice(0, 5000);

const router = Router();

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.projectId) filter.pmsProjectId = req.query.projectId;
    const jobs = await Job.find(filter).sort({ createdAt: -1 }).limit(50).lean();
    res.json(jobs);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id).lean();
    if (!job) throw notFound("Job");
    res.json(job);
  } catch (err) {
    next(err);
  }
});

const ACTIVE_JOB_STATUSES = [
  "pending", "analyzing", "awaiting_requirements_approval", "generating_tasks",
  "awaiting_task_approval", "syncing_to_pms", "awaiting_assignment", "auto_assigning",
  "generating", "quality_gate", "quality_failed", "awaiting_diff_approval",
  "awaiting_push_approval", "pushed", "pr_open",
];

router.post("/", requireAuth, requireRole("admin", "manager", "lead"), async (req, res, next) => {
  try {
    const { pmsProjectId, repoFullName, mode } = req.body ?? {};
    if (!pmsProjectId) throw badRequest("pmsProjectId is required");
    if (!repoFullName) throw badRequest("repoFullName is required");
    const jobMode = mode === "standalone" ? "standalone" : "pms";

    // Duplicate job guard — prevent two active jobs for the same PMS project
    const existing = await Job.findOne({ pmsProjectId, status: { $in: ACTIVE_JOB_STATUSES } }).lean();
    if (existing) {
      throw conflict(
        `An active job already exists for project ${pmsProjectId} ` +
        `(jobId: ${existing._id}, status: ${existing.status}). ` +
        "Cancel or complete it before starting a new one.",
      );
    }

    // Verify the project exists in PMS (skip for standalone or when PMS is not configured)
    if (jobMode === "pms" && config.pms.serviceEmail && config.pms.servicePassword) {
      await pmsClient.getProject(pmsProjectId);
    }

    const job = await Job.create({
      pmsProjectId,
      repoFullName,
      mode: jobMode,
      createdBy: req.user._id,
      status: "pending",
      stage: 1,
    });
    res.status(201).json(job);
  } catch (err) {
    next(err);
  }
});

// ── Task review (Stage 3) ─────────────────────────────────────────────────────

/** Return the AI-generated task suggestions for a job. */
router.get("/:id/tasks", requireAuth, async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id).lean();
    if (!job) throw notFound("Job");
    res.json({
      status: job.status,
      stage: job.stage,
      tasks: job.aiGeneratedTasks ?? [],
      pmsTaskIds: job.pmsTaskIds ?? [],
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Approve the reviewed task list and trigger PMS task creation.
 * Body: { tasks: [{ title, description, type, priority, points, requirementIds }] }
 * Tasks with no title are silently dropped. Titles are truncated to 140 chars.
 */
router.post("/:id/tasks/approve", requireAuth, requireRole("admin", "manager", "lead"), async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) throw notFound("Job");
    if (job.status !== "awaiting_task_approval") {
      throw badRequest(`Cannot approve tasks in status: ${job.status}`);
    }

    const rawTasks = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    if (rawTasks.length === 0) throw badRequest("At least one task must be approved");

    // Validate and sanitise each task
    const tasks = rawTasks.map((t) => {
      const title = sanitiseTitle(t.title);
      if (!title) throw badRequest(`Task is missing a title`);
      if (!TASK_TYPES.includes(t.type)) throw badRequest(`Invalid task type: ${t.type}`);
      if (!PRIORITIES.includes(t.priority)) throw badRequest(`Invalid priority: ${t.priority}`);
      const points = t.points ? Number(t.points) : null;
      if (points && !STORY_POINTS.includes(points)) throw badRequest(`Invalid story points: ${t.points}`);
      return {
        title,
        description: sanitiseDescription(t.description),
        type: t.type,
        priority: t.priority,
        points,
        requirementIds: Array.isArray(t.requirementIds) ? t.requirementIds.slice(0, 20) : [],
        assigneeId: t.assigneeId ?? null,
      };
    });

    // Record Stage 3 approval
    await Approval.create({
      jobId: job._id,
      stage: 3,
      stageName: "task_review",
      decision: "approved",
      approvedBy: req.user._id,
      payload: { taskCount: tasks.length },
    });

    job.set("aiGeneratedTasks", tasks);

    if (job.mode === "standalone") {
      // Standalone: skip PMS sync, create Task docs directly and auto-assign
      job.status = "awaiting_assignment";
      job.stage = 5;
      job.pmsTaskIds = tasks.map((_, i) => `standalone-${job._id}-${i}`);
      await job.save();

      const taskDocs = tasks.map((t, i) => ({
        jobId: job._id,
        pmsTaskId: `standalone-${job._id}-${i}`,
        title: t.title,
        description: t.description ?? "",
        type: t.type ?? "task",
        priority: t.priority ?? "medium",
        points: t.points ?? undefined,
        requirementIds: t.requirementIds ?? [],
        ...(t.assigneeId ? { assignedTo: t.assigneeId, status: "assigned" } : { status: "pending" }),
        repoFullName: job.repoFullName,
      }));
      await Task.insertMany(taskDocs);

      const queues = getQueues();
      await queues.taskAssign.add(
        "assign-tasks",
        { jobId: String(job._id) },
        { jobId: `taskassign-${job._id}` },
      );
    } else {
      // PMS mode: sync tasks to PMS (Stage 4 — auto)
      job.status = "syncing_to_pms";
      job.stage = 4;
      await job.save();

      const queues = getQueues();
      await queues.pmsSync.add(
        "create-tasks",
        { jobId: String(job._id), pmsProjectId: job.pmsProjectId, tasks },
        { jobId: `pmssync-${job._id}` },
      );
    }

    audit(req.user, "tasks.approved", {
      jobId: job._id,
      details: { taskCount: tasks.length, mode: job.mode },
    });

    res.json({ taskCount: tasks.length, job });
  } catch (err) {
    next(err);
  }
});

// ── Code generation (Stage 6 — auto after Team Lead assigns in PMS) ──────────

/**
 * Team Lead calls this after assigning the PMS task to trigger code generation.
 * Body: { pmsTaskId } — the PMS task ID to implement. Defaults to pmsTaskIds[0].
 */
router.post("/:id/start-codegen", requireAuth, requireRole("admin", "manager", "lead"), async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) throw notFound("Job");
    if (job.status !== "awaiting_assignment") {
      throw badRequest(`Cannot start code generation in status: ${job.status}`);
    }
    if (!githubClient.isConfigured()) {
      throw badRequest("GitHub App is not configured — set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, and GITHUB_APP_INSTALLATION_ID");
    }

    const pmsTaskId = req.body?.pmsTaskId ?? job.pmsTaskIds?.[0];
    if (!pmsTaskId) throw badRequest("No pmsTaskId provided and no PMS tasks on this job");

    // For standalone tasks, skip PMS verification; for PMS tasks, verify they still exist
    const isStandalone = String(pmsTaskId).startsWith("standalone-");
    if (!isStandalone) {
      try {
        await pmsClient.getTask(pmsTaskId);
      } catch (err) {
        throw badRequest(`PMS task ${pmsTaskId} not found: ${err.message}`);
      }
    }

    job.status = "generating";
    job.stage = 6;
    await job.save();

    // Apply manual assignee if provided, then mark task as generating
    const taskUpdate = { status: "generating" };
    if (req.body?.assigneeId) {
      taskUpdate.assignedTo = req.body.assigneeId;
    }
    await Task.findOneAndUpdate({ jobId: job._id, pmsTaskId }, taskUpdate);

    const queues = getQueues();
    await queues.codegen.add(
      "generate-code",
      { jobId: String(job._id), pmsTaskId },
      { jobId: `codegen-${job._id}-${pmsTaskId}` },
    );

    audit(req.user, "codegen.started", { jobId: job._id, details: { pmsTaskId, assigneeId: req.body?.assigneeId } });

    res.json({ status: job.status, stage: job.stage, pmsTaskId });
  } catch (err) {
    next(err);
  }
});

// ── Diff review (Stage 7) ─────────────────────────────────────────────────────

/** Approve the AI-generated diff — advances to awaiting_push_approval (Stage 8) */
router.post("/:id/diff/approve", requireAuth, requireRole("admin", "manager", "lead"), async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) throw notFound("Job");
    if (job.status !== "awaiting_diff_approval") {
      throw badRequest(`Cannot approve diff in status: ${job.status}`);
    }

    await Approval.create({
      jobId: job._id,
      stage: 7,
      stageName: "diff_review",
      decision: "approved",
      approvedBy: req.user._id,
      notes: req.body?.notes ?? "",
      payload: { diffSummary: job.diffSummary },
    });

    job.status = "awaiting_push_approval";
    job.stage = 8;
    await job.save();

    // Advance tasks that are awaiting_diff → awaiting_push
    await Task.updateMany(
      { jobId: job._id, status: "awaiting_diff" },
      { status: "awaiting_push" },
    );

    audit(req.user, "diff.approved", { jobId: job._id });

    res.json({ status: job.status, stage: job.stage });
  } catch (err) {
    next(err);
  }
});

/** Reject the AI-generated diff — marks job as failed for manual follow-up */
router.post("/:id/diff/reject", requireAuth, requireRole("admin", "manager", "lead"), async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) throw notFound("Job");
    if (job.status !== "awaiting_diff_approval") {
      throw badRequest(`Cannot reject diff in status: ${job.status}`);
    }

    const reason = String(req.body?.reason ?? "").trim().slice(0, 500) || "Diff rejected by reviewer";

    await Approval.create({
      jobId: job._id,
      stage: 7,
      stageName: "diff_review",
      decision: "rejected",
      approvedBy: req.user._id,
      notes: reason,
    });

    job.status = "failed";
    job.errorMessage = `Diff rejected: ${reason}`;
    await job.save();

    await Task.updateMany(
      { jobId: job._id, status: "awaiting_diff" },
      { status: "failed", errorMessage: `Diff rejected: ${reason}` },
    );

    audit(req.user, "diff.rejected", { jobId: job._id, details: { reason } });

    res.json({ status: job.status });
  } catch (err) {
    next(err);
  }
});

// ── Push approval (Stage 8) ───────────────────────────────────────────────────

/**
 * Team Lead approves the push: branch is pushed to GitHub and a PR is opened.
 * Body: { notes? }
 */
router.post("/:id/push/approve", requireAuth, requireRole("admin", "manager", "lead"), async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) throw notFound("Job");
    if (job.status !== "awaiting_push_approval") {
      throw badRequest(`Cannot approve push in status: ${job.status}`);
    }
    if (!githubClient.isConfigured()) {
      throw badRequest("GitHub App is not configured");
    }
    if (!job.clonePath || !existsSync(job.clonePath)) {
      throw badRequest(
        "Clone directory not found — the server may have restarted. Cancel this job and start a new one from Stage 6."
      );
    }

    // Load the persistent clone
    const git = simpleGit(job.clonePath);

    // Detect base branch from the clone
    let baseBranch = "main";
    try {
      const symref = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
      baseBranch = symref.trim().replace("refs/remotes/origin/", "") || "main";
    } catch {}

    // Stale-branch recheck — block push on detected merge conflicts
    const { detectConflicts } = await import("../lib/conflictDetect.js");
    const freshConflict = await detectConflicts(git, baseBranch, job.cloneBaseSha ?? "");
    if (freshConflict.hasConflicts === true) {
      throw conflict(
        `Merge conflicts detected with ${baseBranch}: ${freshConflict.message}. ` +
        "Rebase the feature branch manually and restart from Stage 6, or cancel this job.",
      );
    }
    if (freshConflict.diverged) {
      console.warn(`[push-approve] base branch diverged (no conflicts) — proceeding with note in PR body`);
    }

    // Push branch to GitHub (refreshes token before push)
    console.log(`[push-approve] pushing ${job.branchName} → ${job.repoFullName}`);
    await pushBranch(git, job.branchName, job.repoFullName);

    // Build PR title and body
    const diff = job.diffSummary ?? {};
    const pmsTaskList = (job.pmsTaskIds ?? []).join(", ") || "—";
    const prTitle = `AI: ${(diff.files?.[0]?.path ?? job.branchName ?? "code changes")}`.slice(0, 100);
    const prBody = [
      "## AI-Generated Code Changes",
      "",
      `**Branch:** \`${job.branchName}\``,
      `**Base:** \`${baseBranch}\``,
      `**Orchestrator Job:** ${job._id}`,
      `**PMS Tasks:** ${pmsTaskList}`,
      "",
      "### Summary",
      diff.summary ?? "See diff for details.",
      "",
      diff.files?.length
        ? "### Files Changed\n" + diff.files.map((f) => `- \`${f.path}\` (+${f.additions}/-${f.deletions})`).join("\n")
        : "",
      "",
      "---",
      `*This code was generated by AI Orchestrator Bot and reviewed by a human reviewer before push.*`,
      `*Bot commit identity: \`ai-orchestrator[bot]@users.noreply.github.com\` — not a human contributor.*`,
    ].filter((l) => l !== undefined).join("\n");

    // Create GitHub PR
    const pr = await githubClient.createPull(job.repoFullName, {
      branch: job.branchName,
      base: baseBranch,
      title: prTitle,
      body: prBody,
    });

    console.log(`[push-approve] PR #${pr.number} opened: ${pr.htmlUrl}`);

    // Move PMS tasks to in_review (best-effort — don't fail push if PMS is down)
    for (const taskId of job.pmsTaskIds ?? []) {
      try {
        await pmsClient.moveTask(taskId, "in_review", `PR #${pr.number} opened: ${pr.htmlUrl}`);
      } catch (e) {
        console.warn(`[push-approve] could not move PMS task ${taskId} to in_review:`, e.message);
      }
    }

    // Record Stage 8 approval
    await Approval.create({
      jobId: job._id,
      stage: 8,
      stageName: "push_approval",
      decision: "approved",
      approvedBy: req.user._id,
      notes: req.body?.notes ?? "",
      payload: { prNumber: pr.number, prUrl: pr.htmlUrl },
    });

    // Advance job to pr_open
    job.status = "pr_open";
    job.stage = 9;
    job.prNumber = pr.number;
    job.prUrl = pr.htmlUrl;
    await job.save();

    // Advance tasks awaiting_push → pr_open with PR details
    await Task.updateMany(
      { jobId: job._id, status: "awaiting_push" },
      { status: "pr_open", prNumber: pr.number, prUrl: pr.htmlUrl },
    );

    // Enqueue PR polling (checks every 5 min, up to 20 attempts)
    const queues = getQueues();
    await queues.prPoll.add(
      "poll-pr",
      { jobId: String(job._id), prNumber: pr.number, repoFullName: job.repoFullName },
      { jobId: `prpoll-${job._id}-${pr.number}` },
    );

    audit(req.user, "push.approved", {
      jobId: job._id,
      details: { prNumber: pr.number, prUrl: pr.htmlUrl },
    });

    res.json({ status: job.status, stage: job.stage, prNumber: pr.number, prUrl: pr.htmlUrl });
  } catch (err) {
    next(err);
  }
});

// ── Cancel ────────────────────────────────────────────────────────────────────

router.get("/:id/cost", requireAuth, async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id).lean();
    if (!job) return next(notFound("Job not found"));
    const summary = await getJobCostSummary(req.params.id);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/cancel", requireAuth, requireRole("admin", "manager", "lead"), async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) throw notFound("Job");
    if (["merged", "cancelled"].includes(job.status)) throw badRequest("Job is already complete");
    job.status = "cancelled";
    await job.save();
    res.json(job);
  } catch (err) {
    next(err);
  }
});

export default router;
