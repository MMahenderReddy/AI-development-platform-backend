/**
 * Analysis Worker — Autonomous Pipeline
 *
 * Job data: { jobId: string, documentId: string }
 *
 * Steps:
 *  1. Load Job and Document from MongoDB
 *  2. Parse the uploaded file → plain text (documentParser)
 *  3. If text > 500 KB, split into chunks
 *  4. Call OpenAI with function calling to extract requirements from each chunk
 *  5. Merge, deduplicate, and renumber requirements
 *  6. Auto-approve all requirements, then immediately enqueue generate-tasks
 *     (no human approval gate — fully autonomous)
 *
 * generate-tasks processor:
 *  Generates PMS tasks from approved requirements with taskArea classification,
 *  then immediately enqueues pms-sync (no human approval gate).
 */
import { Worker } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { connectDb } from "../lib/db.js";
import { parseDocument, chunkText } from "../lib/documentParser.js";
import { extractRequirementsFromChunk, generateTasksFromRequirements } from "../lib/openaiClient.js";
import { audit } from "../lib/audit.js";
import Job from "../models/Job.js";
import Document from "../models/Document.js";
import { getQueues } from "../lib/queues.js";
import config from "../config/env.js";

await connectDb();

const CHUNK_THRESHOLD = 500_000; // characters — matches documentParser.MAX_CHARS

// ── Task generation processor ─────────────────────────────────────────────────

const generateTasksProcessor = async (bullJob) => {
  const { jobId, documentId } = bullJob.data;
  console.log(`[analysis-worker] generating tasks for job=${jobId}`);

  const [orcJob, doc] = await Promise.all([Job.findById(jobId), Document.findById(documentId)]);
  if (!orcJob || !doc) throw new Error("Job or document not found");

  const approvedReqs = doc.requirements.filter((r) => r.approved);
  if (approvedReqs.length === 0) throw new Error("No approved requirements to generate tasks from");

  await bullJob.updateProgress(20);
  const aiTasks = await generateTasksFromRequirements(approvedReqs);
  await bullJob.updateProgress(80);

  orcJob.set("aiGeneratedTasks", aiTasks);
  orcJob.status = "syncing_to_pms";
  orcJob.stage = 4;
  await orcJob.save();

  audit("system", "tasks.generated", {
    jobId: orcJob._id,
    details: { taskCount: aiTasks.length },
  });

  // Auto-fire pms-sync immediately — no human approval gate
  const queues = getQueues();
  await queues.pmsSync.add(
    "create-tasks",
    {
      jobId: String(orcJob._id),
      pmsProjectId: orcJob.pmsProjectId,
      tasks: aiTasks,
    },
    { jobId: `pmssync:${orcJob._id}` },
  );
  console.log(`[analysis-worker] enqueued pms-sync for job=${jobId} (${aiTasks.length} tasks)`);

  await bullJob.updateProgress(100);
  return { taskCount: aiTasks.length };
};

// ── Analysis processor ────────────────────────────────────────────────────────

const processor = async (bullJob) => {
  if (bullJob.name === "generate-tasks") return generateTasksProcessor(bullJob);
  const { jobId, documentId } = bullJob.data;
  console.log(`[analysis-worker] starting job=${jobId} doc=${documentId}`);

  const [orcJob, doc] = await Promise.all([
    Job.findById(jobId),
    Document.findById(documentId),
  ]);

  if (!orcJob) throw new Error(`Job ${jobId} not found`);
  if (!doc) throw new Error(`Document ${documentId} not found`);
  if (!doc.storagePath) throw new Error(`Document ${documentId} has no storage path`);

  // ── Step 1: Parse document ────────────────────────────────────────────────
  await bullJob.updateProgress(10);
  let parsed;
  try {
    parsed = await parseDocument(doc.storagePath, doc.mimeType);
  } catch (err) {
    throw new Error(`Document parsing failed: ${err.message}`);
  }

  // Persist the extracted text (truncated if large) for display in the UI
  doc.extractedText = parsed.text.slice(0, 100_000); // cap stored preview at 100 KB
  if (parsed.truncated) {
    console.warn(`[analysis-worker] doc ${documentId} truncated to ${CHUNK_THRESHOLD} chars`);
  }

  // ── Step 2: Extract requirements ─────────────────────────────────────────
  await bullJob.updateProgress(20);
  let allRequirements = [];

  if (parsed.text.length > CHUNK_THRESHOLD) {
    // Large document: chunk and process each piece
    doc.chunked = true;
    const chunks = chunkText(parsed.text);
    console.log(`[analysis-worker] processing ${chunks.length} chunks for doc ${documentId}`);

    for (let i = 0; i < chunks.length; i++) {
      const offset = allRequirements.length;
      const reqs = await extractRequirementsFromChunk(chunks[i], i, offset);
      allRequirements.push(...reqs);
      await bullJob.updateProgress(20 + Math.floor((i / chunks.length) * 60));
    }
  } else {
    allRequirements = await extractRequirementsFromChunk(parsed.text);
    await bullJob.updateProgress(80);
  }

  // ── Step 3: Deduplicate and normalise ─────────────────────────────────────
  // Renumber sequentially after merging chunks
  const seen = new Set();
  const unique = allRequirements.filter((r) => {
    const key = r.text.toLowerCase().trim().slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const requirements = unique.map((r, i) => ({
    id: `REQ-${String(i + 1).padStart(3, "0")}`,
    text: r.text,
    category: r.category ?? "feature",
    priority: r.priority ?? "medium",
    approved: false,
    rejected: false,
  }));

  // ── Step 4: Auto-approve all requirements and advance ────────────────────
  await bullJob.updateProgress(90);
  // Mark all requirements approved — no human gate
  doc.requirements = requirements.map((r) => ({ ...r, approved: true }));
  await doc.save();

  orcJob.status = "generating_tasks";
  orcJob.stage = 3;
  orcJob.aiModel = config.openai.model;
  await orcJob.save();

  audit("system", "analysis.completed", {
    jobId: orcJob._id,
    details: { requirementsCount: requirements.length, chunked: doc.chunked },
  });

  // Immediately enqueue task generation — no human approval gate
  const queues = getQueues();
  await queues.analysis.add(
    "generate-tasks",
    { jobId: String(orcJob._id), documentId: String(doc._id) },
    { jobId: `gentasks:${orcJob._id}` },
  );
  console.log(`[analysis-worker] enqueued generate-tasks for job=${jobId}`);

  await bullJob.updateProgress(100);
  console.log(`[analysis-worker] done job=${jobId}, ${requirements.length} requirements auto-approved`);
  return { requirementsCount: requirements.length };
};

const worker = new Worker("analysis", processor, {
  connection: getRedis(),
  concurrency: 3,
});

worker.on("failed", async (bullJob, err) => {
  console.error(`[analysis-worker] failed job=${bullJob?.data?.jobId}:`, err.message);
  if (bullJob?.data?.jobId) {
    try {
      await Job.findByIdAndUpdate(bullJob.data.jobId, {
        status: "failed",
        errorMessage: `Analysis failed: ${err.message}`,
      });
    } catch (dbErr) {
      console.error("[analysis-worker] could not update job status:", dbErr.message);
    }
  }
});

worker.on("completed", (bullJob) => {
  console.log(`[analysis-worker] completed bull=${bullJob.id}`);
});

console.log("[analysis-worker] ready");
