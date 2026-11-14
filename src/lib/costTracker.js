/**
 * AI cost tracking — records token usage and USD cost per operation.
 *
 * Pricing is model-aware with a configurable fallback via env vars:
 *   COST_USD_PER_1M_PROMPT      (default 5.00 — gpt-4o input rate)
 *   COST_USD_PER_1M_COMPLETION  (default 15.00 — gpt-4o output rate)
 *
 * Both the per-job CostRecord collection and the Task.cost summary field
 * are updated on every call, so the UI can read either source.
 */
import CostRecord from "../models/CostRecord.js";
import Task from "../models/Task.js";

const MODEL_PRICING_PER_1M = {
  "gpt-4o":               { prompt: 5.00,   completion: 15.00  },
  "gpt-4o-mini":          { prompt: 0.15,   completion: 0.60   },
  "gpt-4-turbo":          { prompt: 10.00,  completion: 30.00  },
  "gpt-4-turbo-preview":  { prompt: 10.00,  completion: 30.00  },
  "gpt-4":                { prompt: 30.00,  completion: 60.00  },
  "gpt-3.5-turbo":        { prompt: 0.50,   completion: 1.50   },
  "o1":                   { prompt: 15.00,  completion: 60.00  },
  "o1-mini":              { prompt: 3.00,   completion: 12.00  },
};

function computeUsd(model, promptTokens, completionTokens) {
  const pricing = MODEL_PRICING_PER_1M[model] ?? {
    prompt:     Number(process.env.COST_USD_PER_1M_PROMPT     ?? "5.00"),
    completion: Number(process.env.COST_USD_PER_1M_COMPLETION ?? "15.00"),
  };
  const promptUsd     = (promptTokens     / 1_000_000) * pricing.prompt;
  const completionUsd = (completionTokens / 1_000_000) * pricing.completion;
  return { promptUsd, completionUsd, totalUsd: promptUsd + completionUsd };
}

/**
 * Record a single AI call's token usage.
 * @param {{ jobId, taskId?, operation, model, promptTokens, completionTokens }} opts
 * @returns {{ promptTokens, completionTokens, totalUsd }}
 */
export async function recordCost({ jobId, taskId, operation, model, promptTokens = 0, completionTokens = 0 }) {
  if (!promptTokens && !completionTokens) return { promptTokens: 0, completionTokens: 0, totalUsd: 0 };

  const { promptUsd, completionUsd, totalUsd } = computeUsd(model, promptTokens, completionTokens);

  await CostRecord.create({
    jobId,
    taskId: taskId ?? undefined,
    operation,
    model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    promptUsd,
    completionUsd,
    totalUsd,
  });

  if (taskId) {
    await Task.findByIdAndUpdate(taskId, {
      $inc: {
        "cost.promptTokens":     promptTokens,
        "cost.completionTokens": completionTokens,
        "cost.totalUsd":         totalUsd,
      },
    });
  }

  return { promptTokens, completionTokens, totalUsd };
}

/**
 * Aggregate total cost across all CostRecord entries for a job.
 * @returns {{ totalUsd, totalTokens, byOperation: Record<string, { totalUsd, totalTokens }> }}
 */
export async function getJobCostSummary(jobId) {
  const records = await CostRecord.find({ jobId }).lean();
  const byOperation = {};
  let totalUsd = 0;
  let totalTokens = 0;

  for (const r of records) {
    totalUsd    += r.totalUsd;
    totalTokens += r.totalTokens;
    if (!byOperation[r.operation]) byOperation[r.operation] = { totalUsd: 0, totalTokens: 0 };
    byOperation[r.operation].totalUsd    += r.totalUsd;
    byOperation[r.operation].totalTokens += r.totalTokens;
  }

  return { totalUsd, totalTokens, byOperation, recordCount: records.length };
}
