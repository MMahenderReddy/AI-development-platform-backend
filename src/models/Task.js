import { Schema, model } from "mongoose";

export const TASK_STATUSES = [
  "pending",            // created, waiting for assignment
  "assigned",           // auto-assigned to a member (Phase 2)
  "queued",             // stagger-delay pending dispatch (Phase 2)
  "generating",         // codegen worker running
  "quality_gate",       // quality gate runner running (Phase 3)
  "quality_failed",     // quality gate failed; blocked until override
  "awaiting_diff",      // diff review needed
  "awaiting_push",      // push approval needed
  "pushed",             // branch pushed to GitHub
  "pr_open",            // PR is open — awaiting human review/merge
  "changes_requested",  // reviewer requested changes (Phase 4)
  "merged",             // PR merged — terminal success
  "failed",             // terminal failure
  "cancelled",          // cancelled
];

const taskSchema = new Schema(
  {
    jobId:         { type: Schema.Types.ObjectId, ref: "Job", required: true, index: true },
    pmsTaskId:     { type: String, index: true },
    title:         { type: String, required: true },
    description:   String,
    type:          { type: String, enum: ["task", "bug", "feature", "improvement"], default: "task" },
    priority:      { type: String, enum: ["urgent", "high", "medium", "low"], default: "medium" },
    points:        Number,
    requirementIds: [String],

    // dependency graph — task starts only when all predecessors are merged
    dependsOn:     [{ type: Schema.Types.ObjectId, ref: "Task" }],

    status:        { type: String, enum: TASK_STATUSES, default: "pending", index: true },

    // assignment (Phase 2 auto-assign fills this; Phase 1 manual start-codegen leaves null)
    assignedTo:    { type: Schema.Types.ObjectId, ref: "OrchestratorUser", index: true },

    // repo resolution (Phase 2 reads from RepoMapping; Phase 1 copies from Job)
    repoFullName:  String,
    baseBranch:    String,
    branchName:    String,
    clonePath:     String,

    prNumber:      Number,
    prUrl:         String,
    diffSummary:   Schema.Types.Mixed,
    qualityOutput: String,

    // set when quality gate is bypassed by an admin/manager
    qualityOverride: {
      by:     { type: Schema.Types.ObjectId, ref: "OrchestratorUser" },
      reason: String,
      at:     Date,
    },

    cost: {
      promptTokens:     Number,
      completionTokens: Number,
      totalUsd:         Number,
    },

    errorMessage:    String,
    lastHeartbeatAt: Date,
  },
  { timestamps: true },
);

taskSchema.index({ jobId: 1, pmsTaskId: 1 });
taskSchema.index({ assignedTo: 1, status: 1 });

export default model("Task", taskSchema);
