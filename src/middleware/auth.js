import config from "../config/env.js";
import { unauthorized, forbidden } from "../lib/errors.js";

export const requireAuth = (req, res, next) => {
  try {
    if (!config.s2sKey) {
      return next(new Error("ORCHESTRATOR_S2S_KEY not configured"));
    }
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) throw unauthorized();
    const key = auth.slice(7);
    if (!key || key !== config.s2sKey) throw unauthorized();
    req.user = { _id: "system", name: "orchestrator-service", role: "admin" };
    next();
  } catch (err) {
    next(err.name === "ApiError" ? err : unauthorized());
  }
};

export const requireRole = (...roles) =>
  (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden(`Requires role: ${roles.join(" or ")}`));
    next();
  };
