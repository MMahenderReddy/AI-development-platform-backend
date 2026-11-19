/**
 * Reanalysis Worker — Document Update Pipeline
 *
 * Queue: "reanalysis"
 * Job data: { deltaJobId: string, documentId: string, parentJobId: string }
 *
 * Triggered by POST /documents/reanalyze/:projectId when a user uploads
 * an updated version of a project document.
 *
 * Steps:
 *  1. Load delta job, new document, parent job, parent document
 *  2. Parse new document → extract + auto-approve requirements
 *     (skipped on retry if requirements already saved)
 *  3. Diff new requirements against previous approved requirements (AI + Jaccard fallback)
 *  4. Handle REMOVED requirements:
 *       - pending / queued / assigned → cancel task + mark PMS task obsolete
 *       - generating / pushed / pr_open / merged → flag for review
 *  5. Handle MODIFIED requirements:
 *       - pending / queued → update task description in DB + PMS
 *       - assigned / generating and beyond → flag for review
 *  6. Handle ADDED requirements:
 *       - Generate new tasks via OpenAI → enqueue pmsSync
 *  7. Save delta summary to job, advance status
 *
 * Idempotency:
 *  - Requirements extraction: skipped if newDocument.requirements already populated
 *  - Task cancellation: checks task.obsolete before cancelling
 *  - Task flagging: checks task.flaggedForReview before setting
 *  - pmsSync enqueue: BullMQ deduplication by jobId prevents duplicate task creation
 *
 * Security:
 *  - Never modifies tasks from a different project
 *  - Never touches tasks in merged / deployed / failed / cancelled state
 *  - PMS workspace is always taken from the job document, never from request data
 */
import { Worker } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { connectDb } from "../lib/db.js";
import { parseDocument } from "../lib/documentParser.js";
import {
  extractRequirementsFromChunk,
  generateTasksFromRequirements,
} from "../lib/openaiClient.js";
import { diffRequirements } from "../lib/requirementDiff.js";
import { recordCost } from "../lib/costTracker.js";
import { pmsClientFor } from "../lib/pmsClient.js";
import { audit } from "../lib/audit.js";
import { getQueues } from "../lib/queues.js";
import Job from "../models/Job.js";
import Task from "../models/Task.js";
import Document from "../models/Document.js";
import config from "../config/env.js";

await connectDb();

const sep = "=".repeat(50);

// Tasks that have not started active development — safe to cancel or update
const SAFE_TO_CANCEL  = new Set(["pending", "queued", "assigned"]);
// Tasks with no code generated yet — safe to update description
const SAFE_TO_UPDATE  = new Set(["pending", "queued"]);
// Terminal states — no action needed
const TERMINAL_STATES = new Set(["merged", "deployed", "failed", "cancelled"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildUpdatedDescription(originalDesc, prevReq, nextReq, docVersion) {
  const prevText = prevReq.editedText ?? prevReq.text;
  const nextText = nextReq.editedText ?? nextReq.text;
  return [
    `📝 **REQUIREMENT UPDATED** (Document v${docVersion})`,
    ``,
    `**New requirement:** ${nextText}`,
    `**Previous requirement:** ${prevText}`,
    ``,
    `---`,
    `**Original task description:**`,
    originalDesc ?? "(no description provided)",
  ].join("\n");
}

function buildRemovedDescription(originalDesc, reqId, docVersion) {
  return [
    `⚠️ **FLAGGED FOR REVIEW** — Requirement Removed (Document v${docVersion})`,
    ``,
    `Requirement \`${reqId}\` was removed from the updated project document.`,
    `This task was already in progress when the change occurred.`,
    `Please review whether this task should continue, be modified, or be cancelled manually.`,
    ``,
    `---`,
    `**Original task description:**`,
    originalDesc ?? "(no description provided)",
  ].join("\n");
}

function buildModifiedFlagDescription(originalDesc, prevReq, nextReq, docVersion) {
  const prevText = prevReq.editedText ?? prevReq.text;
  const nextText = nextReq.editedText ?? nextReq.text;
  return [
    `⚠️ **FLAGGED FOR REVIEW** — Requirement Modified (Document v${docVersion})`,
    ``,
    `Requirement \`${prevReq.id}\` was updated in the revised project document.`,
    `This task was already in progress when the change occurred.`,
    `Please review and update the implementation if needed.`,
    ``,
    `**Updated requirement:** ${nextText}`,
    `**Previous requirement:** ${prevText}`,
    ``,
    `---`,
    `**Original task description:**`,
    originalDesc ?? "(no description provided)",
  ].join("\n");
}

// ── Main processor ───────────────────────────────────────────────────────────

const processor = async (bullJob) => {
  const { deltaJobId, documentId, parentJobId } = bullJob.data;

  console.log(`\n${sep}`);
  console.log(`[reanalysis-worker] ===== DOCUMENT REANALYSIS STARTED =====`);
  console.log(`[reanalysis-worker] Delta Job ID:  ${deltaJobId}`);
  console.log(`[reanalysis-worker] Document ID:   ${documentId}`);
  console.log(`[reanalysis-worker] Parent Job ID: ${parentJobId}`);
  console.log(`[reanalysis-worker] Time:          ${new Date().toISOString()}`);
  console.log(`${sep}`);

  // ── Step 1: Load all data ─────────────────────────────────────────────────
  const [deltaJob, newDoc, parentJob] = await Promise.all([
    Job.findById(deltaJobId),
    Document.findById(documentId),
    Job.findById(parentJobId),
  ]);

  if (!deltaJob) throw new Error(`Delta job ${deltaJobId} not found`);
  if (!newDoc)   throw new Error(`Document ${documentId} not found`);
  if (!parentJob) throw new Error(`Parent job ${parentJobId} not found`);

  const parentDoc = await Document.findOne({ jobId: parentJob._id }).sort({ createdAt: -1 });
  if (!parentDoc) throw new Error(`No document found for parent job ${parentJobId}`);

  const prevApproved = (parentDoc.requirements ?? []).filter((r) => r.approved);
  if (prevApproved.length === 0) {
    throw new Error("Parent job has no approved requirements to diff against");
  }

  console.log(`[reanalysis-worker] Parent document: "${parentDoc.originalName}" (v${parentDoc.documentVersion ?? 1}) — ${prevApproved.length} approved requirements`);
  console.log(`[reanalysis-worker] New document:    "${newDoc.originalName}" (v${newDoc.documentVersion ?? 1})`);

  await bullJob.updateProgress(5);

  // ── Step 2: Extract requirements from new document ────────────────────────
  let newApproved;

  if ((newDoc.requirements ?? []).length > 0) {
    // Retry path: requirements already extracted in a previous attempt
    console.log(`\n[reanalysis-worker] STEP 2 — Requirements already extracted (retry) — using cached ${newDoc.requirements.length} requirements`);
    newApproved = newDoc.requirements.filter((r) => r.approved);
  } else {
    console.log(`\n[reanalysis-worker] STEP 2 — Parsing document and extracting requirements...`);

    let parsed;
    try {
      parsed = await parseDocument(newDoc.storagePath, newDoc.mimeType);
      console.log(`[reanalysis-worker]   ✓ Parsed: ${parsed.text.length.toLocaleString()} characters`);
    } catch (err) {
      throw new Error(`Document parsing failed: ${err.message}`);
    }

    await bullJob.updateProgress(15);

    const { requirements: extracted, usage: extractUsage } = await extractRequirementsFromChunk(parsed.text);
    await recordCost({
      jobId: deltaJobId,
      operation: "extract_requirements_delta",
      model: config.openai.model,
      promptTokens:     extractUsage?.prompt_tokens     ?? 0,
      completionTokens: extractUsage?.completion_tokens ?? 0,
    });

    const requirements = extracted.map((r, i) => ({
      id:       `REQ-${String(i + 1).padStart(3, "0")}`,
      text:     r.text,
      category: r.category ?? "feature",
      priority: r.priority ?? "medium",
      approved: true,
      rejected: false,
    }));

    console.log(`[reanalysis-worker]   ✓ Extracted ${requirements.length} requirements`);
    for (const r of requirements) {
      console.log(`[reanalysis-worker]     ${r.id} [${r.category}/${r.priority}] ${r.text.slice(0, 80)}${r.text.length > 80 ? "…" : ""}`);
    }

    newDoc.requirements = requirements;
    await newDoc.save();
    newApproved = requirements;

    deltaJob.status = "generating_tasks";
    deltaJob.stage = 3;
    deltaJob.aiModel = config.openai.model;
    await deltaJob.save();
  }

  await bullJob.updateProgress(30);

  // ── Step 3: Diff requirements ─────────────────────────────────────────────
  console.log(`\n[reanalysis-worker] STEP 3 — Diffing ${prevApproved.length} previous vs ${newApproved.length} new requirements...`);

  const diff = await diffRequirements(prevApproved, newApproved);

  console.log(`[reanalysis-worker]   Method:    ${diff.aiUsed ? "AI (OpenAI)" : "Jaccard similarity (fallback)"}`);
  console.log(`[reanalysis-worker]   Unchanged: ${diff.unchanged.length}`);
  console.log(`[reanalysis-worker]   Added:     ${diff.added.length}`);
  console.log(`[reanalysis-worker]   Modified:  ${diff.modified.length}`);
  console.log(`[reanalysis-worker]   Removed:   ${diff.removed.length}`);

  if (diff.added.length > 0) {
    console.log(`[reanalysis-worker]   Added requirements:`);
    for (const r of diff.added) console.log(`[reanalysis-worker]     + ${r.id}: ${r.text.slice(0, 80)}`);
  }
  if (diff.modified.length > 0) {
    console.log(`[reanalysis-worker]   Modified requirements:`);
    for (const { prev, next } of diff.modified) {
      console.log(`[reanalysis-worker]     ~ ${prev.id} → ${next.id}: ${next.text.slice(0, 80)}`);
    }
  }
  if (diff.removed.length > 0) {
    console.log(`[reanalysis-worker]   Removed requirements:`);
    for (const r of diff.removed) console.log(`[reanalysis-worker]     - ${r.id}: ${r.text.slice(0, 80)}`);
  }

  await bullJob.updateProgress(45);

  const pmsClient = pmsClientFor(deltaJob.pmsWorkspace ?? "core");
  let tasksCancelled = 0, tasksFlagged = 0, tasksUpdated = 0, tasksQueued = 0;

  // ── Step 4: Handle REMOVED requirements ──────────────────────────────────
  if (diff.removed.length > 0) {
    console.log(`\n[reanalysis-worker] STEP 4 — Processing ${diff.removed.length} removed requirement(s)...`);
  }

  for (const removedReq of diff.removed) {
    const tasks = await Task.find({
      jobId: parentJob._id,
      requirementIds: removedReq.id,
    }).lean();

    for (const task of tasks) {
      if (TERMINAL_STATES.has(task.status)) continue; // already done or cancelled

      if (SAFE_TO_CANCEL.has(task.status) && !task.obsolete) {
        // Safe to cancel — no code work has started
        await Task.findByIdAndUpdate(task._id, {
          status:   "cancelled",
          obsolete: true,
          flagNote: `Requirement ${removedReq.id} was removed in document v${newDoc.documentVersion}. Task cancelled automatically.`,
        });
        tasksCancelled++;
        console.log(`[reanalysis-worker]   ✓ Cancelled task ${task.pmsTaskId} (${task.status}) — req ${removedReq.id} removed`);

        // Update PMS task to reflect cancellation
        if (task.pmsTaskId) {
          try {
            await pmsClient.moveTask(task.pmsTaskId, "cancelled",
              `Requirement removed in document revision (v${newDoc.documentVersion})`);
          } catch {
            // PMS may not support "cancelled" as a move target — update description instead
            try {
              await pmsClient.updateTask(task.pmsTaskId, {
                description: [
                  `🚫 **CANCELLED** — Requirement Removed (Document v${newDoc.documentVersion})`,
                  ``,
                  `Requirement \`${removedReq.id}\` was removed from the updated project document.`,
                  `This task was automatically cancelled.`,
                  ``,
                  `---`,
                  task.description ?? "(no description)",
                ].join("\n"),
              });
            } catch (e2) {
              console.warn(`[reanalysis-worker]   ⚠ Could not update PMS task ${task.pmsTaskId}: ${e2.message}`);
            }
          }
        }
      } else if (!task.obsolete && !task.flaggedForReview) {
        // Task is in-progress — flag for manual review
        const flagNote = `Requirement ${removedReq.id} was removed in document v${newDoc.documentVersion}. Task is ${task.status} — manual review required.`;
        await Task.findByIdAndUpdate(task._id, { flaggedForReview: true, flagNote });
        tasksFlagged++;
        console.log(`[reanalysis-worker]   ⚑ Flagged task ${task.pmsTaskId} (${task.status}) — req ${removedReq.id} removed`);

        if (task.pmsTaskId) {
          try {
            await pmsClient.updateTask(task.pmsTaskId, {
              description: buildRemovedDescription(task.description, removedReq.id, newDoc.documentVersion),
            });
          } catch (e) {
            console.warn(`[reanalysis-worker]   ⚠ PMS update failed for ${task.pmsTaskId}: ${e.message}`);
          }
        }
      }
    }
  }

  await bullJob.updateProgress(60);

  // ── Step 5: Handle MODIFIED requirements ─────────────────────────────────
  if (diff.modified.length > 0) {
    console.log(`\n[reanalysis-worker] STEP 5 — Processing ${diff.modified.length} modified requirement(s)...`);
  }

  for (const { prev, next } of diff.modified) {
    const tasks = await Task.find({
      jobId: parentJob._id,
      requirementIds: prev.id,
    }).lean();

    for (const task of tasks) {
      if (TERMINAL_STATES.has(task.status)) continue;
      if (task.obsolete) continue;

      if (SAFE_TO_UPDATE.has(task.status) && !task.flaggedForReview) {
        // Task not yet started — update description
        const updatedDesc = buildUpdatedDescription(task.description, prev, next, newDoc.documentVersion);
        await Task.findByIdAndUpdate(task._id, { description: updatedDesc });
        tasksUpdated++;
        console.log(`[reanalysis-worker]   ✎ Updated task ${task.pmsTaskId} (${task.status}) — req ${prev.id} modified`);

        if (task.pmsTaskId) {
          try {
            await pmsClient.updateTask(task.pmsTaskId, { description: updatedDesc });
          } catch (e) {
            console.warn(`[reanalysis-worker]   ⚠ PMS update failed for ${task.pmsTaskId}: ${e.message}`);
          }
        }
      } else if (!task.flaggedForReview) {
        // Task in progress — flag for manual review
        const flagNote = `Requirement ${prev.id} was modified in document v${newDoc.documentVersion}. Task is ${task.status} — manual review required.`;
        await Task.findByIdAndUpdate(task._id, { flaggedForReview: true, flagNote });
        tasksFlagged++;
        console.log(`[reanalysis-worker]   ⚑ Flagged task ${task.pmsTaskId} (${task.status}) — req ${prev.id} modified`);

        if (task.pmsTaskId) {
          try {
            await pmsClient.updateTask(task.pmsTaskId, {
              description: buildModifiedFlagDescription(task.description, prev, next, newDoc.documentVersion),
            });
          } catch (e) {
            console.warn(`[reanalysis-worker]   ⚠ PMS update failed for ${task.pmsTaskId}: ${e.message}`);
          }
        }
      }
    }
  }

  await bullJob.updateProgress(75);

  // ── Step 6: Handle ADDED requirements ────────────────────────────────────
  if (diff.added.length > 0) {
    console.log(`\n[reanalysis-worker] STEP 6 — Generating tasks for ${diff.added.length} new requirement(s)...`);

    const { tasks: aiTasks, usage: taskUsage } = await generateTasksFromRequirements(diff.added);
    await recordCost({
      jobId: deltaJobId,
      operation: "generate_tasks_delta",
      model: config.openai.model,
      promptTokens:     taskUsage?.prompt_tokens     ?? 0,
      completionTokens: taskUsage?.completion_tokens ?? 0,
    });

    tasksQueued = aiTasks.length;
    console.log(`[reanalysis-worker]   ✓ Generated ${aiTasks.length} task(s) for new requirements`);
    for (const t of aiTasks) {
      console.log(`[reanalysis-worker]     • "${t.title}" [${t.type}/${t.priority}/${t.taskArea}]`);
    }

    deltaJob.set("aiGeneratedTasks", aiTasks);
    deltaJob.status = "syncing_to_pms";
    deltaJob.stage  = 4;

    const queues = getQueues();
    await queues.pmsSync.add(
      "create-tasks",
      {
        jobId:        String(deltaJob._id),
        pmsProjectId: deltaJob.pmsProjectId,
        tasks:        aiTasks,
      },
      { jobId: `pmssync-${deltaJob._id}` },
    );
    console.log(`[reanalysis-worker]   ✓ Enqueued pms-sync for ${aiTasks.length} new task(s)`);
  } else {
    // No new tasks to create — reanalysis is fully complete
    console.log(`\n[reanalysis-worker] STEP 6 — No new requirements; marking delta job complete`);
    deltaJob.status = "delta_complete";
    deltaJob.stage  = 10;
  }

  // ── Step 7: Save delta summary ────────────────────────────────────────────
  deltaJob.deltaSummary = {
    requirementChanges: {
      total:     prevApproved.length + diff.added.length,
      unchanged: diff.unchanged.length,
      added:     diff.added.length,
      modified:  diff.modified.length,
      removed:   diff.removed.length,
    },
    taskActions: {
      newTasksQueued:        tasksQueued,
      tasksUpdated,
      tasksCancelled,
      tasksFlaggedForReview: tasksFlagged,
    },
  };

  await deltaJob.save();

  audit("system", "reanalysis.completed", {
    jobId: deltaJob._id,
    details: {
      parentJobId,
      documentVersion: newDoc.documentVersion,
      diffMethod:      diff.aiUsed ? "openai" : "jaccard",
      requirementChanges: deltaJob.deltaSummary.requirementChanges,
      taskActions:        deltaJob.deltaSummary.taskActions,
    },
  });

  await bullJob.updateProgress(100);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${sep}`);
  console.log(`[reanalysis-worker] ===== REANALYSIS SUMMARY =====`);
  console.log(`${sep}`);
  console.log(`\n  REQUIREMENT DIFF (${diff.aiUsed ? "AI" : "Jaccard fallback"})`);
  console.log(`  Unchanged:   ${diff.unchanged.length}`);
  console.log(`  Added:       ${diff.added.length}`);
  console.log(`  Modified:    ${diff.modified.length}`);
  console.log(`  Removed:     ${diff.removed.length}`);
  console.log(`\n  TASK ACTIONS`);
  console.log(`  Cancelled:        ${tasksCancelled}`);
  console.log(`  Updated:          ${tasksUpdated}`);
  console.log(`  Flagged:          ${tasksFlagged}`);
  console.log(`  New tasks queued: ${tasksQueued}`);
  console.log(`\n  Delta job status: ${deltaJob.status}`);
  console.log(`${sep}\n`);

  return {
    unchanged:      diff.unchanged.length,
    added:          diff.added.length,
    modified:       diff.modified.length,
    removed:        diff.removed.length,
    tasksCancelled,
    tasksUpdated,
    tasksFlagged,
    tasksQueued,
    finalStatus:    deltaJob.status,
  };
};

// ── Worker setup ──────────────────────────────────────────────────────────────

const worker = new Worker("reanalysis", processor, {
  connection: getRedis(),
  concurrency: 2,
});

worker.on("failed", async (bullJob, err) => {
  const { deltaJobId } = bullJob?.data ?? {};
  console.error(`[reanalysis-worker] ✗ FAILED deltaJobId=${deltaJobId}: ${err.message}`);
  if (deltaJobId) {
    try {
      await Job.findByIdAndUpdate(deltaJobId, {
        status:       "failed",
        errorMessage: `Reanalysis failed: ${err.message}`,
      });
    } catch (dbErr) {
      console.error("[reanalysis-worker] could not update job status:", dbErr.message);
    }
  }
});

worker.on("completed", (bullJob, result) => {
  const s = result ?? {};
  console.log(
    `[reanalysis-worker] ✓ Completed bull=${bullJob.id} — ` +
    `added=${s.added ?? 0} modified=${s.modified ?? 0} removed=${s.removed ?? 0} ` +
    `cancelled=${s.tasksCancelled ?? 0} flagged=${s.tasksFlagged ?? 0} queued=${s.tasksQueued ?? 0}`,
  );
});

console.log("[reanalysis-worker] ready (concurrency: 2)");
