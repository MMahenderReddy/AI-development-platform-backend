import { Schema, model } from "mongoose";

const integrationRunSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", index: true },
    jobIds:    [{ type: Schema.Types.ObjectId, ref: "Job" }],
    status: {
      type: String,
      enum: ["running", "passed", "failed", "partial"],
      default: "running",
    },
    taskBranches: [
      {
        taskId:     { type: Schema.Types.ObjectId, ref: "Task" },
        branchName: String,
        repo:       String,
        sha:        String,
      },
    ],
    buildLog:        { type: String, default: "" },
    conflictsFound:  [{ file: String, description: String }],
    reworkTaskIds:   [{ type: Schema.Types.ObjectId, ref: "Task" }],
    integrationBranch: String,
    mergedToMain:    { type: Boolean, default: false },
    attempt:         { type: Number, default: 1 },
    errorMessage:    String,
  },
  { timestamps: true },
);

integrationRunSchema.index({ status: 1 });

export default model("IntegrationRun", integrationRunSchema);
