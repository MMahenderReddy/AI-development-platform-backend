/**
 * PMS API client for the orchestrator service account.
 *
 * The PMS uses HttpOnly cookies — there is no Bearer token support.
 * We maintain a session token in Redis (TTL 11h) and re-login before expiry.
 * All Bull workers share the same Redis-backed token.
 *
 * NEVER log the actual token value. NEVER store PMS credentials in anything
 * other than environment variables.
 */
import { getRedis } from "./redis.js";
import config from "../config/env.js";

const SESSION_KEY = "pms:session:token";
const SESSION_TTL_S = 11 * 60 * 60; // 11h — PMS JWT is 12h, re-login 1h before expiry

const pmsUrl = (path) => `${config.pms.apiUrl}${path}`;

const rawRequest = async (method, path, { body, cookie } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = `pms_token=${cookie}`;

  const res = await fetch(pmsUrl(path), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "omit",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`PMS API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.code = res.status === 401 ? "PMS_UNAUTHORIZED" : "PMS_ERROR";
    throw err;
  }

  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? res.json() : {};
};

const login = async () => {
  const { email, password } = config.pms;
  if (!email || !password) throw new Error("PMS service account credentials not configured (PMS_SERVICE_EMAIL / PMS_SERVICE_PASSWORD)");

  const res = await fetch(pmsUrl("/api/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PMS login failed (${res.status}): ${text.slice(0, 200)}`);
  }

  // Extract the HttpOnly cookie value from Set-Cookie header (server-side only)
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/pms_token=([^;]+)/);
  if (!match) throw new Error("PMS login response did not set pms_token cookie");

  const token = match[1];
  await getRedis().set(SESSION_KEY, token, "EX", SESSION_TTL_S);
  console.log("[pmsClient] session refreshed");
  return token;
};

const getToken = async () => {
  const cached = await getRedis().get(SESSION_KEY);
  if (cached) return cached;
  return login();
};

const request = async (method, path, options = {}, retried = false) => {
  const token = await getToken();
  try {
    return await rawRequest(method, path, { ...options, cookie: token });
  } catch (err) {
    if (err.code === "PMS_UNAUTHORIZED" && !retried) {
      // Token may have expired early — force re-login once
      await getRedis().del(SESSION_KEY);
      const fresh = await login();
      return rawRequest(method, path, { ...options, cookie: fresh });
    }
    throw err;
  }
};

// ── Public API ───────────────────────────────────────────────────────────────

export const pmsClient = {
  /** Verify the session is working and return the current service account user. */
  me: () => request("GET", "/api/auth/me"),

  /** Force a fresh login (useful on startup). */
  ensureSession: async () => {
    try {
      await pmsClient.me();
    } catch {
      await getRedis().del(SESSION_KEY);
      await login();
    }
  },

  // ── Projects ──────────────────────────────────────────────────────────────

  /** List all projects the service account can see. Returns projects that have a repo set. */
  listProjects: () => request("GET", "/api/projects"),

  getProject: (projectId) => request("GET", `/api/projects/${encodeURIComponent(projectId)}`),

  // ── Tasks ─────────────────────────────────────────────────────────────────

  /**
   * Create a PMS task as the orchestrator service account.
   * reporter is set to "system" server-side — the PMS treats this as an automatic task.
   */
  createTask: (input) =>
    request("POST", "/api/tasks", {
      body: {
        ...input,
        // source links back to the orchestrator job for traceability
        source: input.source ?? undefined,
      },
    }),

  moveTask: (taskId, to, reason) =>
    request("POST", `/api/tasks/${encodeURIComponent(taskId)}/move`, { body: { to, reason } }),

  getTask: (taskId) => request("GET", `/api/tasks/${encodeURIComponent(taskId)}`),

  // ── Pull Requests ─────────────────────────────────────────────────────────

  /**
   * Create a PR via PMS. The branch must already exist on GitHub.
   * PMS will auto-move the linked task from todo/in_progress → in_review.
   * title: 5–120 chars; description: max 10,000 chars.
   */
  createPull: (projectId, { branch, title, description }) =>
    request("POST", `/api/pulls/${encodeURIComponent(projectId)}`, {
      body: { branch, title, description },
    }),

  getPull: (projectId, number) =>
    request("GET", `/api/pulls/${encodeURIComponent(projectId)}/${number}`),

  listPullsForProject: (projectId) =>
    request("GET", `/api/pulls/${encodeURIComponent(projectId)}`),
};
