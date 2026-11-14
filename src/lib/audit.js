import AuditLog from "../models/AuditLog.js";

export const audit = (actor, action, details = {}) => {
  const { jobId, pmsTaskId, repoFullName, approvedBy, ...rest } = details;
  AuditLog.create({
    actor: typeof actor === "object" ? String(actor._id ?? actor.id ?? actor) : actor,
    action,
    jobId: jobId ?? null,
    pmsTaskId: pmsTaskId ?? null,
    repoFullName: repoFullName ?? null,
    approvedBy: approvedBy ?? null,
    details: Object.keys(rest).length ? rest : undefined,
  }).catch((err) => console.error("[audit] write failed:", err.message));
};
