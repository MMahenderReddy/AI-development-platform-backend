import { Schema, model } from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["admin", "manager", "lead", "viewer"], default: "viewer" },
    pmsUserId: String,
    status: { type: String, enum: ["active", "disabled"], default: "active" },
    skills: [String],
    activeTaskCount: { type: Number, default: 0, min: 0 },
    capability: { type: String, enum: ["frontend", "backend", "fullstack", "lead"], default: "fullstack" },
    isAiAgent: { type: Boolean, default: false },
  },
  { timestamps: true },
);

userSchema.methods.verifyPassword = function (password) {
  return bcrypt.compare(password, this.passwordHash);
};

userSchema.statics.hashPassword = (password) => bcrypt.hash(password, 12);

export default model("OrchestratorUser", userSchema);
