import { Schema, model } from "mongoose";

const repoMappingSchema = new Schema(
  {
    pmsProjectId:     { type: String, required: true, index: true },
    repoType:         { type: String, enum: ["frontend", "backend", "mobile", "default"], default: "default" },
    repoFullName:     { type: String, required: true },      // "owner/repo"
    baseBranch:       { type: String, default: "main" },
    branchPattern:    { type: String, default: "orch/{taskId}/{slug}" }, // {taskId}, {slug}, {memberId}
    // when set, overrides skills-based assignment for this repo type
    assignedMemberId: { type: Schema.Types.ObjectId, ref: "OrchestratorUser" },
    createdBy:        { type: Schema.Types.ObjectId, ref: "OrchestratorUser", required: true },
  },
  { timestamps: true },
);

// one entry per project+repoType combination
repoMappingSchema.index({ pmsProjectId: 1, repoType: 1 }, { unique: true });

export default model("RepoMapping", repoMappingSchema);
