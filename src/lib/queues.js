/**
 * BullMQ queue definitions — shared between Express routes and worker processes.
 * Import this file to get queue instances; each call returns the same singleton.
 *
 * Queue concurrency rules (from architecture design):
 *  analysis-queue   concurrency 3 — read-only AI analysis, safe to parallelise
 *  codegen-queue    concurrency 1 — serialised per queue instance; prevents parallel
 *                                   write conflicts on the same repo
 *  pms-sync-queue   concurrency 3 — PMS REST calls are rate-limited
 *  pr-poll-queue    concurrency 5 — lightweight polling
 */
import { Queue } from "bullmq";
import { getRedis } from "./redis.js";

const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
  attempts: 3,
  backoff: { type: "exponential", delay: 30_000 },
};

let _queues = null;

export const getQueues = () => {
  if (_queues) return _queues;
  const connection = getRedis();
  _queues = {
    analysis: new Queue("analysis", { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
    codegen: new Queue("codegen", { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
    pmsSync: new Queue("pms-sync", { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
    prPoll: new Queue("pr-poll", {
      connection,
      defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, attempts: 20, backoff: { type: "fixed", delay: 5 * 60_000 } },
    }),
  };
  return _queues;
};
