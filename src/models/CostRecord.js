import { Schema, model } from "mongoose";

const costRecordSchema = new Schema(
  {
    jobId:   { type: Schema.Types.ObjectId, ref: "Job",  required: true, index: true },
    taskId:  { type: Schema.Types.ObjectId, ref: "Task", index: true },
    operation: {
      type: String,
      enum: ["extract_requirements", "generate_tasks", "generate_code"],
      required: true,
    },
    model:            { type: String, required: true },
    promptTokens:     { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens:      { type: Number, default: 0 },
    promptUsd:        { type: Number, default: 0 },
    completionUsd:    { type: Number, default: 0 },
    totalUsd:         { type: Number, default: 0 },
  },
  { timestamps: true },
);

costRecordSchema.index({ jobId: 1, operation: 1 });

export default model("CostRecord", costRecordSchema);
