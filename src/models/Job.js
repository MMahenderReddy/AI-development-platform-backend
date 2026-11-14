import { Schema, model } from "mongoose";

const JOB_STATUSES = [
  "pending",
  "analyzing",
  "awaiting_requirements_approval",
  "generating_tasks",
  "awaiting_task_approval",
  "syncing_to_pms",
  "awaiting_assignment",
  "generating",
  "awaiting_diff_approval",
  "quality_gate",
  "awaiting_push_approval",
  "pushed",
  "pr_open",
  "merged",
  "failed",
  "cancelled",
];

const jobSchema = new Schema(
  {
    status: { type: String, enum: JOB_STATUSES, default: "pending", required: true },
    stage: { type: Number, min: 1, max: 10, default: 1 },
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
  },
  { timestamps: true },
);

jobSchema.index({ status: 1 });
jobSchema.index({ pmsProjectId: 1 });
jobSchema.index({ createdBy: 1 });

export default model("Job", jobSchema);
