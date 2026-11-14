import { Schema, model } from "mongoose";

const approvalSchema = new Schema(
  {
    jobId: { type: Schema.Types.ObjectId, ref: "Job", required: true },
    stage: { type: Number, required: true, min: 1, max: 10 },
    stageName: String,
    decision: { type: String, enum: ["approved", "rejected", "edited"], required: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: "OrchestratorUser", required: true },
    approvedAt: { type: Date, default: Date.now },
    notes: String,
    payload: Schema.Types.Mixed,
  },
  { _id: true },
);

approvalSchema.index({ jobId: 1, stage: 1 });

export default model("Approval", approvalSchema);
