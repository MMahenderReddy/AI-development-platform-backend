import rateLimit from "express-rate-limit";

/**
 * Shared rate-limit helper.
 * windowMs / max can be overridden per route.
 */
const makeLimit = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "RATE_LIMITED", message },
    skip: (req) => req.ip === "::1" || req.ip === "127.0.0.1",
  });

/** General API: 200 req / 15 min */
export const apiLimiter = makeLimit(
  15 * 60 * 1000,
  200,
  "Too many requests — please slow down"
);

/** Auth endpoints: 10 login attempts / 15 min */
export const authLimiter = makeLimit(
  15 * 60 * 1000,
  10,
  "Too many login attempts — try again in 15 minutes"
);

/** Document upload: 20 uploads / hour */
export const uploadLimiter = makeLimit(
  60 * 60 * 1000,
  20,
  "Upload limit reached — try again in an hour"
);

/** Job creation: 30 new jobs / hour */
export const jobCreateLimiter = makeLimit(
  60 * 60 * 1000,
  30,
  "Too many jobs created — try again in an hour"
);
