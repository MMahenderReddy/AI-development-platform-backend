/**
 * Reset script — clears all orchestrator jobs, tasks, documents, and BullMQ queues.
 * Run: node scripts/reset-all.mjs
 */
import "dotenv/config";
import mongoose from "mongoose";
import Redis from "ioredis";

const MONGO_URI = process.env.MONGODB_URI;
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// ── MongoDB cleanup ───────────────────────────────────────────────────────────
console.log("\n=== Connecting to MongoDB...");
await mongoose.connect(MONGO_URI, { dbName: "orchestrator_db" });
console.log("Connected to orchestrator_db");

const db = mongoose.connection.db;
const collections = await db.listCollections().toArray();
const names = collections.map((c) => c.name);

const toClear = ["jobs", "tasks", "documents", "approvals", "auditlogs", "costs"];
for (const col of toClear) {
  if (names.includes(col)) {
    const result = await db.collection(col).deleteMany({});
    console.log(`  ✓ Cleared ${col}: ${result.deletedCount} documents removed`);
  } else {
    console.log(`  - ${col}: collection not found, skipping`);
  }
}

await mongoose.disconnect();
console.log("MongoDB cleanup done.\n");

// ── PMS database cleanup ──────────────────────────────────────────────────────
console.log("=== Connecting to PMS database (pms_dev)...");
await mongoose.connect(MONGO_URI, { dbName: "pms_dev" });
console.log("Connected to pms_dev");

const pmsDb = mongoose.connection.db;
const pmsCols = await pmsDb.listCollections().toArray();
const pmsColNames = pmsCols.map((c) => c.name);
console.log("  Collections found:", pmsColNames.join(", "));

// Delete only AI-generated tasks (source starts with "ai-orchestrator:")
if (pmsColNames.includes("tasks")) {
  const aiTasks = await pmsDb.collection("tasks").deleteMany({
    source: { $regex: /^ai-orchestrator:/ }
  });
  console.log(`  ✓ Cleared PMS AI tasks: ${aiTasks.deletedCount} removed`);
} else {
  console.log("  - tasks collection not found in pms_dev");
}

await mongoose.disconnect();
console.log("PMS cleanup done.\n");

// ── Redis / BullMQ cleanup ────────────────────────────────────────────────────
console.log("=== Connecting to Redis...");
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

// Get all BullMQ-related keys
const keys = await redis.keys("bull:*");
if (keys.length === 0) {
  console.log("  No BullMQ keys found in Redis.");
} else {
  // Delete in batches of 100
  for (let i = 0; i < keys.length; i += 100) {
    await redis.del(...keys.slice(i, i + 100));
  }
  console.log(`  ✓ Cleared ${keys.length} BullMQ Redis keys`);
}

await redis.quit();
console.log("Redis cleanup done.\n");

console.log("✅ Reset complete — all jobs, tasks, documents and queues cleared.");
console.log("   Restart npm run dev:all then submit a new document to start fresh.\n");
