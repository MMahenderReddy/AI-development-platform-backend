import jwt from "jsonwebtoken";
import config from "../config/env.js";
import OrchestratorUser from "../models/OrchestratorUser.js";
import { unauthorized, forbidden } from "../lib/errors.js";

export const requireAuth = async (req, res, next) => {
  try {
    const token = req.cookies?.orch_token;
    if (!token) throw unauthorized();
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await OrchestratorUser.findById(payload.sub);
    if (!user || user.status !== "active") throw unauthorized("Session invalid");
    req.user = user;
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
