import { Schema, model } from "mongoose";

const auditSchema = new Schema(
  {
    at: { type: Date, default: Date.now, required: true },
    actor: String,
    action: { type: String, required: true },
    jobId: Schema.Types.ObjectId,
    pmsTaskId: String,
    repoFullName: String,
    approvedBy: String,
    details: Schema.Types.Mixed,
  },
  { _id: true },
);

auditSchema.index({ jobId: 1 });
auditSchema.index({ at: -1 });

export default model("AuditLog", auditSchema);
