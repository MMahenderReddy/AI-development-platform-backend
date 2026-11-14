import { Schema, model } from "mongoose";

const projectSchema = new Schema(
  {
    name:         { type: String, required: true, trim: true },
    projectId:    { type: String, required: true, unique: true, lowercase: true, trim: true },
    pmsProjectId: { type: String, required: true },
    status: {
      type: String,
      enum: ["setup", "analyzing", "developing", "integrating", "deploying", "done", "failed", "paused"],
      default: "setup",
    },
    completionPct: { type: Number, default: 0, min: 0, max: 100 },

    repoConfig: {
      mode:               { type: String, enum: ["mono", "split"], default: "mono" },
      frontendRepo:       String,
      backendRepo:        String,
      defaultRepo:        String,
      baseBranch:         { type: String, default: "main" },
      integrationBranch:  { type: String, default: "integration" },
    },

    deployConfig: {
      enabled:        { type: Boolean, default: false },
      provider:       { type: String, enum: ["github_actions", "webhook", "none"], default: "none" },
      webhookUrl:     String,
      healthCheckUrl: String,
      autoMergeMain:  { type: Boolean, default: false },
    },

    teamMemberIds: [{ type: Schema.Types.ObjectId, ref: "OrchestratorUser" }],
    documents:     [{ type: Schema.Types.ObjectId, ref: "Document" }],
    createdBy:     { type: Schema.Types.ObjectId, ref: "OrchestratorUser", required: true },
  },
  { timestamps: true },
);

projectSchema.index({ pmsProjectId: 1 });
projectSchema.index({ status: 1 });

export default model("Project", projectSchema);
