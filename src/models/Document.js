import { Schema, model } from "mongoose";

const requirementSchema = new Schema(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
    editedText: String,
    approved: { type: Boolean, default: false },
    rejected: { type: Boolean, default: false },
    approvedBy: Schema.Types.ObjectId,
    approvedAt: Date,
  },
  { _id: false },
);

const docSchema = new Schema(
  {
    jobId: { type: Schema.Types.ObjectId, ref: "Job", required: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project" },
    projectSlug: { type: String, default: "" },
    originalName: { type: String, required: true },
    mimeType: String,
    sizeBytes: Number,
    storagePath: String,
    extractedText: String,
    chunked: { type: Boolean, default: false },
    requirements: [requirementSchema],
    uploadedBy: { type: Schema.Types.ObjectId, ref: "OrchestratorUser" },
    // version history — links to the document this one was compared against
    previousDocumentId: { type: Schema.Types.ObjectId, ref: "Document", default: undefined },
    documentVersion:    { type: Number, default: 1 },
  },
  { timestamps: true },
);

docSchema.index({ jobId: 1 });
docSchema.index({ projectId: 1 });

export default model("Document", docSchema);
