/**
 * Seed script — creates sample users for the AI Development Orchestrator.
 * Run once: node seed-users.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import OrchestratorUser from "./src/models/OrchestratorUser.js";

await mongoose.connect(process.env.MONGODB_URI, { dbName: "orchestrator_db" });
console.log("Connected to MongoDB");

const users = [
  {
    name: "Mahender (Admin)",
    email: "mahender@tektreeinc.com",
    password: "Admin@123",
    role: "admin",
    skills: ["javascript", "react", "node"],
  },
  {
    name: "Sarah Manager",
    email: "sarah@tektreeinc.com",
    password: "Manager@123",
    role: "manager",
    skills: ["project-management", "agile"],
  },
  {
    name: "Alex Lead",
    email: "alex@tektreeinc.com",
    password: "Lead@123",
    role: "lead",
    skills: ["javascript", "typescript", "node", "react"],
  },
  {
    name: "Dev One",
    email: "dev1@tektreeinc.com",
    password: "Dev@12345",
    role: "viewer",
    skills: ["javascript", "react"],
  },
  {
    name: "Dev Two",
    email: "dev2@tektreeinc.com",
    password: "Dev@12345",
    role: "viewer",
    skills: ["python", "node", "typescript"],
  },
];

let created = 0;
let skipped = 0;

for (const u of users) {
  const exists = await OrchestratorUser.findOne({ email: u.email });
  if (exists) {
    console.log(`  skip  ${u.email}  (already exists)`);
    skipped++;
    continue;
  }
  const passwordHash = await OrchestratorUser.hashPassword(u.password);
  await OrchestratorUser.create({
    name: u.name,
    email: u.email,
    passwordHash,
    role: u.role,
    skills: u.skills,
    status: "active",
  });
  console.log(`  created  ${u.email}  [${u.role}]  password: ${u.password}`);
  created++;
}

console.log(`\nDone — ${created} created, ${skipped} skipped`);
await mongoose.disconnect();
