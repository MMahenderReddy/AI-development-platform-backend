import { Schema, model } from "mongoose";

const JOB_STATUSES = [
  "pending",
  "analyzing",
  "generating_tasks",
  "syncing_to_pms",
  "awaiting_assignment",
  "auto_assigning",
  "generating",
  "quality_gate",
  "quality_failed",
  "pushed",
  "integrating",
  "deploying",
  "pr_open",
  "merged",
  "deployed",
  "failed",
  "cancelled",
  // legacy statuses kept for backward compat — no longer entered by autonomous flow
  "awaiting_requirements_approval",
  "awaiting_task_approval",
  "awaiting_diff_approval",
  "awaiting_push_approval",
  "changes_requested",
];

const jobSchema = new Schema(
  {
    status: { type: String, enum: JOB_STATUSES, default: "pending", required: true },
    stage: { type: Number, min: 1, max: 10, default: 1 },
    projectId: { type: Schema.Types.ObjectId, ref: "Project" },
    documentId: { type: Schema.Types.ObjectId, ref: "Document" },
    pmsProjectId: String,
    pmsTaskIds: [String],
    repoFullName: String,
    branchName: String,
    prNumber: Number,
    prUrl: String,
    cloneBaseSha: String,
    aiModel: String,
    createdBy: { type: Schema.Types.ObjectId, ref: "OrchestratorUser", required: true },
    assignedToPmsUserId: String,
    errorMessage: String,
    qualityGateLog: String,
    diffSummary: Schema.Types.Mixed,  // structured: { summary, filesChanged, additions, deletions, files }
    clonePath: String,                 // persistent clone dir for push step
    aiGeneratedTasks: [Schema.Types.Mixed],
    mode: { type: String, enum: ["pms", "standalone"], default: "pms" },
    lastHeartbeatAt: Date,
    ciFailCount: { type: Number, default: 0 },  // consecutive CI failures on the integration PR
  },
  { timestamps: true },
);

jobSchema.index({ status: 1 });
jobSchema.index({ pmsProjectId: 1 });
jobSchema.index({ createdBy: 1 });

export default model("Job", jobSchema);
