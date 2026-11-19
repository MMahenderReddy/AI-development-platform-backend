/**
 * Requirement diff — compares two approved-requirement sets and classifies changes.
 *
 * Strategy:
 *  1. Try AI-powered diff via OpenAI function calling (handles paraphrasing, reordering)
 *  2. Fall back to Jaccard word-token similarity on failure
 *
 * Returns:
 *  {
 *    unchanged: Requirement[],              // same meaning, no action needed
 *    added:     Requirement[],              // new, no matching previous req
 *    modified:  { prev, next }[],           // matched pair, content changed
 *    removed:   Requirement[],              // in prev, no match in new
 *    aiUsed:    boolean,
 *    usage?:    OpenAI usage object,
 *  }
 */
import { getOpenAI } from "./openaiClient.js";
import config from "../config/env.js";

// ── OpenAI-powered diff ──────────────────────────────────────────────────────

const DIFF_TOOL = {
  type: "function",
  function: {
    name: "save_requirement_diff",
    description:
      "Map each new requirement to its closest previous requirement and list which previous requirements were removed.",
    parameters: {
      type: "object",
      required: ["mappings", "removedPrevReqIds"],
      properties: {
        mappings: {
          type: "array",
          description: "One entry per NEW requirement",
          items: {
            type: "object",
            required: ["newReqId", "changeType"],
            properties: {
              newReqId: {
                type: "string",
                description: "ID of the new requirement (e.g. REQ-001)",
              },
              prevReqId: {
                type: "string",
                description:
                  "ID of the matching previous requirement. Omit or null for added requirements.",
              },
              changeType: {
                type: "string",
                enum: ["unchanged", "modified", "added"],
                description:
                  "unchanged = same meaning even if reworded; modified = same topic but significantly changed; added = entirely new",
              },
            },
          },
        },
        removedPrevReqIds: {
          type: "array",
          description:
            "IDs of PREVIOUS requirements that have no corresponding new requirement",
          items: { type: "string" },
        },
      },
    },
  },
};

const DIFF_SYSTEM = `You are a software requirements analyst comparing two versions of a requirements document.

Rules:
- For each NEW requirement, classify it as: unchanged (same meaning as an old req, even if reworded), modified (covers the same feature but content changed significantly), or added (no matching old requirement)
- Each previous requirement may be matched to at most one new requirement, and vice versa
- List every previous requirement ID that has no corresponding new requirement in removedPrevReqIds
- Use ONLY requirement IDs from the input — never fabricate IDs
- Respond exclusively by calling save_requirement_diff`;

async function diffWithAI(prevReqs, newReqs) {
  const client = getOpenAI();

  const fmt = (reqs) =>
    reqs
      .map((r) => `${r.id}: ${(r.editedText ?? r.text).slice(0, 300)}`)
      .join("\n");

  const response = await client.chat.completions.create({
    model: config.openai.model,
    max_tokens: 2048,
    temperature: 0,
    tools: [DIFF_TOOL],
    tool_choice: { type: "function", function: { name: "save_requirement_diff" } },
    messages: [
      { role: "system", content: DIFF_SYSTEM },
      {
        role: "user",
        content: `PREVIOUS requirements:\n${fmt(prevReqs)}\n\nNEW requirements:\n${fmt(newReqs)}\n\nClassify every new requirement and identify removed previous requirements.`,
      },
    ],
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("AI diff returned no function call");

  return {
    parsed: JSON.parse(toolCall.function.arguments),
    usage: response.usage ?? null,
  };
}

function buildResultFromAI(prevReqs, newReqs, parsed) {
  const prevById = Object.fromEntries(prevReqs.map((r) => [r.id, r]));
  const newById = Object.fromEntries(newReqs.map((r) => [r.id, r]));
  const mappedNewIds = new Set();
  const usedPrevIds = new Set();
  const unchanged = [], added = [], modified = [];

  for (const m of parsed.mappings ?? []) {
    const newReq = newById[m.newReqId];
    if (!newReq || mappedNewIds.has(m.newReqId)) continue; // skip unknown or dup IDs
    mappedNewIds.add(m.newReqId);

    if (m.changeType === "added" || !m.prevReqId) {
      added.push(newReq);
    } else {
      const prevReq = prevById[m.prevReqId];
      if (!prevReq || usedPrevIds.has(m.prevReqId)) {
        // AI hallucinated prev ID or reused it — treat as added
        added.push(newReq);
      } else {
        usedPrevIds.add(m.prevReqId);
        if (m.changeType === "unchanged") {
          unchanged.push(newReq);
        } else {
          modified.push({ prev: prevReq, next: newReq });
        }
      }
    }
  }

  // Any new reqs not covered by mappings → added
  for (const newReq of newReqs) {
    if (!mappedNewIds.has(newReq.id)) added.push(newReq);
  }

  // Removed = every prev req not matched
  const removed = prevReqs.filter((r) => !usedPrevIds.has(r.id));

  return { unchanged, added, modified, removed };
}

// ── Jaccard fallback ─────────────────────────────────────────────────────────

function jaccardScore(textA, textB) {
  const tokenize = (s) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean),
    );
  const setA = tokenize(textA);
  const setB = tokenize(textB);
  const inter = new Set([...setA].filter((t) => setB.has(t)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : inter.size / union.size;
}

function diffLocally(prevReqs, newReqs) {
  // ≥0.75 overlap → unchanged; ≥0.35 → modified; else → added
  const UNCHANGED_THRESHOLD = 0.75;
  const MODIFIED_THRESHOLD = 0.35;

  const prevById = Object.fromEntries(prevReqs.map((r) => [r.id, r]));
  const usedPrevIds = new Set();
  const unchanged = [], added = [], modified = [];

  for (const newReq of newReqs) {
    const newText = newReq.editedText ?? newReq.text;
    let bestScore = 0, bestPrevId = null;

    for (const prevReq of prevReqs) {
      if (usedPrevIds.has(prevReq.id)) continue;
      const score = jaccardScore(newText, prevReq.editedText ?? prevReq.text);
      if (score > bestScore) {
        bestScore = score;
        bestPrevId = prevReq.id;
      }
    }

    if (bestScore >= UNCHANGED_THRESHOLD) {
      unchanged.push(newReq);
      usedPrevIds.add(bestPrevId);
    } else if (bestScore >= MODIFIED_THRESHOLD) {
      modified.push({ prev: prevById[bestPrevId], next: newReq });
      usedPrevIds.add(bestPrevId);
    } else {
      added.push(newReq);
    }
  }

  const removed = prevReqs.filter((r) => !usedPrevIds.has(r.id));
  return { unchanged, added, modified, removed };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Diff two sets of approved requirements.
 * Tries AI-powered comparison first; falls back to Jaccard similarity.
 *
 * @param {object[]} prevReqs  Approved requirements from the previous document
 * @param {object[]} newReqs   Approved requirements from the new document
 * @returns {Promise<{unchanged, added, modified, removed, aiUsed, usage?}>}
 */
export async function diffRequirements(prevReqs, newReqs) {
  if (prevReqs.length === 0) {
    return { unchanged: [], added: newReqs, modified: [], removed: [], aiUsed: false };
  }
  if (newReqs.length === 0) {
    return { unchanged: [], added: [], modified: [], removed: prevReqs, aiUsed: false };
  }

  try {
    const { parsed, usage } = await diffWithAI(prevReqs, newReqs);
    const result = buildResultFromAI(prevReqs, newReqs, parsed);
    return { ...result, aiUsed: true, usage };
  } catch (err) {
    console.warn(`[requirementDiff] AI diff failed (${err.message}) — falling back to Jaccard`);
    const result = diffLocally(prevReqs, newReqs);
    return { ...result, aiUsed: false };
  }
}
