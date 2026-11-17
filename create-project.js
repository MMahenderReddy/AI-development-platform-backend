import "dotenv/config";
import mongoose from "mongoose";
import Project from "./src/models/Project.js";
import OrchestratorUser from "./src/models/OrchestratorUser.js";

await mongoose.connect(process.env.MONGODB_URI, { dbName: "orchestrator_db" });

const admin = await OrchestratorUser.findOne({ email: "mahender@tektreeinc.com" });
if (!admin) throw new Error("Admin user not found — run seed-users.js first");

const existing = await Project.findOne({ projectId: "testing" });
if (existing) {
  console.log("Project already exists:", existing._id.toString());
  console.log("  projectId:", existing.projectId);
  console.log("  pmsProjectId:", existing.pmsProjectId);
} else {
  const project = await Project.create({
    name: "Testing",
    projectId: "testing",
    pmsProjectId: "pd92d39b74e42",
    repoConfig: {
      mode: "mono",
      defaultRepo: "MMahenderReddy/Testing",
      baseBranch: "main",
      integrationBranch: "integration",
    },
    createdBy: admin._id,
  });
  console.log("Created project:", project._id.toString());
  console.log("  projectId (use this in URL):", project.projectId);
  console.log("  pmsProjectId:", project.pmsProjectId);
  console.log("  repo:", project.repoConfig.defaultRepo);
}

await mongoose.disconnect();
