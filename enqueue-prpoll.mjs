import "dotenv/config";
import { connectDb } from "./src/lib/db.js";
import { getQueues } from "./src/lib/queues.js";
import Job from "./src/models/Job.js";

await connectDb();

const jobId = "6afe9669fb493e679aaae758";
const orcJob = await Job.findById(jobId).lean();
if (!orcJob) { console.error("Job not found"); process.exit(1); }

console.log(`Job: ${orcJob._id}  status=${orcJob.status}  PR=#${orcJob.prNumber}  repo=${orcJob.repoFullName}  tasks=${orcJob.pmsTaskIds?.length}`);

if (!orcJob.prNumber || !orcJob.repoFullName) {
  console.error("Job is missing prNumber or repoFullName — cannot enqueue");
  process.exit(1);
}

const queues = getQueues();
const bullJobId = `poll-pr-${orcJob._id}`;

await queues.prPoll.add(
  "poll-pr",
  { jobId: String(orcJob._id), prNumber: orcJob.prNumber, repoFullName: orcJob.repoFullName },
  { jobId: bullJobId, attempts: 60, backoff: { type: "fixed", delay: 5 * 60 * 1000 } },
);

// Reset review status so the new review runs
await Job.findByIdAndUpdate(jobId, { leadDevReviewStatus: "pending", status: "pushed" });
console.log(`\n✓ Enqueued into pr-poll queue`);
console.log(`  BullMQ job id: ${bullJobId}`);
console.log(`  PR #${orcJob.prNumber} on ${orcJob.repoFullName}`);
process.exit(0);
