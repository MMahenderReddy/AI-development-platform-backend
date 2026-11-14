/**
 * One-time seed script: creates the initial admin user.
 * Run once: node scripts/seed-admin.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import OrchestratorUser from "../src/models/OrchestratorUser.js";

const ADMIN_EMAIL = "admin@orchestrator.local";
const ADMIN_PASSWORD = "Admin@Orch2025!";
const ADMIN_NAME = "Admin";

await mongoose.connect(process.env.MONGODB_URI);

const existing = await OrchestratorUser.findOne({ email: ADMIN_EMAIL });
if (existing) {
  console.log(`User ${ADMIN_EMAIL} already exists (role: ${existing.role})`);
} else {
  const passwordHash = await OrchestratorUser.hashPassword(ADMIN_PASSWORD);
  await OrchestratorUser.create({
    name: ADMIN_NAME,
    email: ADMIN_EMAIL,
    passwordHash,
    role: "admin",
    status: "active",
  });
  console.log(`Created admin user: ${ADMIN_EMAIL}`);
}

await mongoose.disconnect();
