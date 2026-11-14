export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status ?? statusFor(code);
  }
}

const statusFor = (code) => {
  switch (code) {
    case "NOT_FOUND": return 404;
    case "FORBIDDEN": return 403;
    case "UNAUTHORIZED": return 401;
    case "CONFLICT": return 409;
    case "RATE_LIMITED": return 429;
    case "VALIDATION": return 422;
    case "BAD_REQUEST": return 400;
    default: return 500;
  }
};

export const notFound = (what) => new ApiError("NOT_FOUND", `${what} not found`, 404);
export const forbidden = (msg = "Forbidden") => new ApiError("FORBIDDEN", msg, 403);
export const unauthorized = (msg = "Not authenticated") => new ApiError("UNAUTHORIZED", msg, 401);
export const conflict = (msg) => new ApiError("CONFLICT", msg, 409);
export const badRequest = (msg) => new ApiError("BAD_REQUEST", msg, 400);
