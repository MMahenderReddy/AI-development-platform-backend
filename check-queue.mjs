import "dotenv/config";
import { connectDb } from "./src/lib/db.js";
import { getRedis } from "./src/lib/redis.js";
import { Queue } from "bullmq";
import Job from "./src/models/Job.js";

await connectDb();
const redis = getRedis();

const jobs = await Job.find({ status: { $in: ["pushed", "pr_open", "merged", "delta_complete"] } })
  .sort({ createdAt: -1 }).limit(5)
  .select("_id status jobType pmsWorkspace pmsTaskIds prNumber repoFullName createdAt").lean();

console.log("\n=== Recent jobs (pushed/pr_open/merged/delta_complete) ===");
for (const j of jobs) {
  console.log(`  ${j._id}  type=${j.jobType ?? "standard"}  status=${j.status}  ws=${j.pmsWorkspace}  PR=#${j.prNumber ?? "none"}  tasks=${j.pmsTaskIds?.length ?? 0}`);
}

const q = new Queue("pr-poll", { connection: redis });
const [waiting, active, delayed, completed, failed] = await Promise.all([
  q.getWaiting(), q.getActive(), q.getDelayed(), q.getCompleted(0,5), q.getFailed(0,5)
]);

console.log("\n=== pr-poll queue ===");
console.log(`  waiting=${waiting.length}  active=${active.length}  delayed=${delayed.length}  completed=${completed.length}  failed=${failed.length}`);

for (const j of [...waiting, ...active, ...delayed]) {
  console.log(`  [${j.opts?.delay ? "delayed" : "waiting/active"}] id=${j.id}  data=${JSON.stringify(j.data)}`);
}
for (const j of failed) console.log(`  [failed] id=${j.id}  err=${j.failedReason?.slice(0,120)}`);

process.exit(0);
