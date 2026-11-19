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
  "in_review",
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
  // delta job completed with only modifications/removals — no new code to generate
  "delta_complete",
];

const jobSchema = new Schema(
  {
    status: { type: String, enum: JOB_STATUSES, default: "pending", required: true },
    stage: { type: Number, min: 1, max: 10, default: 1 },
    projectId: { type: Schema.Types.ObjectId, ref: "Project" },
    documentId: { type: Schema.Types.ObjectId, ref: "Document" },
    pmsProjectId: String,
    pmsWorkspace: { type: String, enum: ["core", "consultants"], default: "core" },
    pmsTaskIds: [String],
    repoFullName: String,
    branchName: String,
    prNumber: Number,
    prUrl: String,
    cloneBaseSha: String,
    aiModel: String,
    createdBy: { type: String, default: "system" },
    assignedToPmsUserId: String,
    errorMessage: String,
    qualityGateLog: String,
    diffSummary: Schema.Types.Mixed,  // structured: { summary, filesChanged, additions, deletions, files }
    clonePath: String,                 // persistent clone dir for push step
    aiGeneratedTasks: [Schema.Types.Mixed],
    mode: { type: String, enum: ["pms", "standalone"], default: "pms" },
    leadDevReviewStatus: { type: String, enum: ["pending", "approved", "changes_requested"], default: "pending" },
    leadDevReviewSummary: String,
    // delta job fields
    jobType:    { type: String, enum: ["initial", "delta"], default: "initial" },
    parentJobId: { type: Schema.Types.ObjectId, ref: "Job", default: undefined },
    deltaSummary: {
      requirementChanges: {
        total:     Number,
        unchanged: Number,
        added:     Number,
        modified:  Number,
        removed:   Number,
      },
      taskActions: {
        newTasksQueued:       Number,
        tasksUpdated:         Number,
        tasksCancelled:       Number,
        tasksFlaggedForReview: Number,
      },
    },
    lastHeartbeatAt: Date,
    ciFailCount: { type: Number, default: 0 },  // consecutive CI failures on the integration PR
  },
  { timestamps: true },
);

jobSchema.index({ status: 1 });
jobSchema.index({ pmsProjectId: 1 });
jobSchema.index({ createdBy: 1 });

export default model("Job", jobSchema);
