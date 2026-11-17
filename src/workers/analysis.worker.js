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
import { recordCost } from "../lib/costTracker.js";
import { audit } from "../lib/audit.js";
import Job from "../models/Job.js";
import Document from "../models/Document.js";
import { getQueues } from "../lib/queues.js";
import config from "../config/env.js";

await connectDb();

const CHUNK_THRESHOLD = 500_000; // characters — matches documentParser.MAX_CHARS
const sep = "=".repeat(50);

// ── Task generation processor ─────────────────────────────────────────────────

const generateTasksProcessor = async (bullJob) => {
  const { jobId, documentId } = bullJob.data;

  console.log(`\n${sep}`);
  console.log(`[analysis-worker] ===== TASK GENERATION STARTED =====`);
  console.log(`[analysis-worker] Job ID:      ${jobId}`);
  console.log(`[analysis-worker] Document ID: ${documentId}`);
  console.log(`[analysis-worker] Time:        ${new Date().toISOString()}`);
  console.log(`${sep}`);

  const [orcJob, doc] = await Promise.all([Job.findById(jobId), Document.findById(documentId)]);
  if (!orcJob || !doc) throw new Error("Job or document not found");

  const approvedReqs = doc.requirements.filter((r) => r.approved);
  console.log(`[analysis-worker] Approved requirements to process: ${approvedReqs.length}`);
  if (approvedReqs.length === 0) throw new Error("No approved requirements to generate tasks from");

  for (const r of approvedReqs) {
    console.log(`[analysis-worker]   • ${r.id} [${r.category}/${r.priority}] ${r.text.slice(0, 80)}${r.text.length > 80 ? "…" : ""}`);
  }

  await bullJob.updateProgress(20);
  console.log(`\n[analysis-worker] Calling OpenAI to generate tasks from ${approvedReqs.length} requirements...`);
  console.log(`[analysis-worker] Model: ${config.openai.model}`);

  const { tasks: aiTasks, usage: taskUsage } = await generateTasksFromRequirements(approvedReqs);
  await recordCost({
    jobId: String(orcJob._id),
    operation: "generate_tasks",
    model: config.openai.model,
    promptTokens:     taskUsage?.prompt_tokens     ?? 0,
    completionTokens: taskUsage?.completion_tokens ?? 0,
  });

  console.log(`\n[analysis-worker] OpenAI generated ${aiTasks.length} task(s):`);
  for (const t of aiTasks) {
    console.log(`[analysis-worker]   • "${t.title}"`);
    console.log(`[analysis-worker]     type=${t.type} priority=${t.priority} area=${t.taskArea} points=${t.points ?? "?"} estHours=${t.estimatedHours ?? "?"}h`);
    console.log(`[analysis-worker]     reqs=[${(t.requirementIds ?? []).join(", ")}]`);
  }
  console.log(`[analysis-worker] OpenAI usage — prompt=${taskUsage?.prompt_tokens ?? 0} completion=${taskUsage?.completion_tokens ?? 0} tokens`);

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
    { jobId: `pmssync-${orcJob._id}` },
  );

  console.log(`\n[analysis-worker] ✓ Enqueued pms-sync for job=${jobId} (${aiTasks.length} tasks)`);
  console.log(`${sep}\n`);

  await bullJob.updateProgress(100);
  return { taskCount: aiTasks.length };
};

// ── Analysis processor ────────────────────────────────────────────────────────

const processor = async (bullJob) => {
  if (bullJob.name === "generate-tasks") return generateTasksProcessor(bullJob);
  const { jobId, documentId } = bullJob.data;

  console.log(`\n${sep}`);
  console.log(`[analysis-worker] ===== DOCUMENT ANALYSIS STARTED =====`);
  console.log(`[analysis-worker] Job ID:      ${jobId}`);
  console.log(`[analysis-worker] Document ID: ${documentId}`);
  console.log(`[analysis-worker] Time:        ${new Date().toISOString()}`);
  console.log(`${sep}`);

  const [orcJob, doc] = await Promise.all([
    Job.findById(jobId),
    Document.findById(documentId),
  ]);

  if (!orcJob) throw new Error(`Job ${jobId} not found`);
  if (!doc) throw new Error(`Document ${documentId} not found`);
  if (!doc.storagePath) throw new Error(`Document ${documentId} has no storage path`);

  console.log(`\n[analysis-worker] DOCUMENT DETAILS`);
  console.log(`[analysis-worker]   Name:     ${doc.originalName}`);
  console.log(`[analysis-worker]   Type:     ${doc.mimeType}`);
  console.log(`[analysis-worker]   Size:     ${doc.sizeBytes != null ? `${doc.sizeBytes} bytes` : "unknown"}`);
  console.log(`[analysis-worker]   Path:     ${doc.storagePath}`);

  // ── Step 1: Parse document ────────────────────────────────────────────────
  await bullJob.updateProgress(10);
  console.log(`\n[analysis-worker] STEP 1 — Parsing document...`);
  let parsed;
  try {
    parsed = await parseDocument(doc.storagePath, doc.mimeType);
    console.log(`[analysis-worker]   ✓ Document parsed successfully`);
    console.log(`[analysis-worker]   Characters extracted: ${parsed.text.length.toLocaleString()}`);
    console.log(`[analysis-worker]   Truncated: ${parsed.truncated ? "YES (> 500K chars)" : "No"}`);
    console.log(`[analysis-worker]   Preview: ${parsed.text.slice(0, 150).replace(/\n/g, " ")}…`);
  } catch (err) {
    console.error(`[analysis-worker]   ✗ Document parsing FAILED: ${err.message}`);
    throw new Error(`Document parsing failed: ${err.message}`);
  }

  // Persist the extracted text (truncated if large) for display in the UI
  doc.extractedText = parsed.text.slice(0, 100_000);
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
    console.log(`\n[analysis-worker] STEP 2 — Extracting requirements (${chunks.length} chunks, document > 500K chars)`);

    for (let i = 0; i < chunks.length; i++) {
      console.log(`[analysis-worker]   Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
      const offset = allRequirements.length;
      const { requirements: reqs, usage: extractUsage } = await extractRequirementsFromChunk(chunks[i], i, offset);
      await recordCost({
        jobId: String(orcJob._id),
        operation: "extract_requirements",
        model: config.openai.model,
        promptTokens:     extractUsage?.prompt_tokens     ?? 0,
        completionTokens: extractUsage?.completion_tokens ?? 0,
      });
      console.log(`[analysis-worker]   Chunk ${i + 1}: extracted ${reqs.length} requirements`);
      allRequirements.push(...reqs);
      await bullJob.updateProgress(20 + Math.floor((i / chunks.length) * 60));
    }
  } else {
    console.log(`\n[analysis-worker] STEP 2 — Extracting requirements (single pass, ${parsed.text.length.toLocaleString()} chars)`);
    console.log(`[analysis-worker]   Calling OpenAI (model: ${config.openai.model})...`);
    const { requirements: extracted, usage: extractUsage } = await extractRequirementsFromChunk(parsed.text);
    await recordCost({
      jobId: String(orcJob._id),
      operation: "extract_requirements",
      model: config.openai.model,
      promptTokens:     extractUsage?.prompt_tokens     ?? 0,
      completionTokens: extractUsage?.completion_tokens ?? 0,
    });
    allRequirements = extracted;
    console.log(`[analysis-worker]   ✓ Extracted ${allRequirements.length} requirements`);
    console.log(`[analysis-worker]   OpenAI usage — prompt=${extractUsage?.prompt_tokens ?? 0} completion=${extractUsage?.completion_tokens ?? 0} tokens`);
    await bullJob.updateProgress(80);
  }

  // ── Step 3: Deduplicate and normalise ─────────────────────────────────────
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

  console.log(`\n[analysis-worker] STEP 3 — Deduplication`);
  console.log(`[analysis-worker]   Raw requirements:    ${allRequirements.length}`);
  console.log(`[analysis-worker]   After deduplication: ${requirements.length}`);

  console.log(`\n[analysis-worker] REQUIREMENTS LIST:`);
  for (const r of requirements) {
    console.log(`[analysis-worker]   ${r.id} [${r.category}/${r.priority}] ${r.text.slice(0, 100)}${r.text.length > 100 ? "…" : ""}`);
  }

  // ── Step 4: Auto-approve all requirements and advance ────────────────────
  await bullJob.updateProgress(90);
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
    { jobId: `gentasks-${orcJob._id}` },
  );

  console.log(`\n[analysis-worker] STEP 4 — Auto-approved all ${requirements.length} requirements`);
  console.log(`[analysis-worker] ✓ Enqueued generate-tasks for job=${jobId}`);
  console.log(`\n[analysis-worker] DOCUMENT PROCESSING SUMMARY`);
  console.log(`[analysis-worker]   Document:              ${doc.originalName}`);
  console.log(`[analysis-worker]   Characters parsed:     ${parsed.text.length.toLocaleString()}`);
  console.log(`[analysis-worker]   Requirements extracted: ${requirements.length}`);
  console.log(`[analysis-worker]   Auto-approved:         ${requirements.length}`);
  console.log(`[analysis-worker]   Failed:                0`);
  console.log(`${sep}\n`);

  await bullJob.updateProgress(100);
  return { requirementsCount: requirements.length };
};

const worker = new Worker("analysis", processor, {
  connection: getRedis(),
  concurrency: 3,
});

worker.on("failed", async (bullJob, err) => {
  console.error(`[analysis-worker] ✗ FAILED job=${bullJob?.data?.jobId}: ${err.message}`);
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
  console.log(`[analysis-worker] ✓ Completed bull=${bullJob.id}`);
});

console.log("[analysis-worker] ready");
