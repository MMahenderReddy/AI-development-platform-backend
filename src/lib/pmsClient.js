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
  const headers = {
    "Content-Type": "application/json",
    "x-pms-workspace": "consultants",
  };
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
  const email = config.pms.serviceEmail;
  const password = config.pms.servicePassword;
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
   * Uses /api/tasks/ai-create which: requires no assignee, sets reporter="system",
   * and handles idempotency by source key to prevent duplicates on retry.
   */
  createTask: (input) =>
    request("POST", "/api/tasks/ai-create", {
      body: {
        ...input,
        source: input.source ?? undefined,
      },
    }),

  moveTask: (taskId, to, reason) =>
    request("POST", `/api/tasks/${encodeURIComponent(taskId)}/move`, { body: { to, reason } }),

  getTask: (taskId) => request("GET", `/api/tasks/${encodeURIComponent(taskId)}`),

  /**
   * Look up a task by its `source` string — the idempotency key the orchestrator stamps
   * on every task it creates. Returns the task object if found, null if not.
   * Uses the PMS task list endpoint filtered by source (best-effort — returns null on
   * any error so callers fall through to creating the task instead).
   */
  getTaskBySource: async (sourceKey) => {
    try {
      const res = await request("GET", `/api/tasks?source=${encodeURIComponent(sourceKey)}&limit=1`);
      const tasks = Array.isArray(res) ? res : (res?.tasks ?? res?.data ?? []);
      return tasks.length > 0 ? tasks[0] : null;
    } catch {
      return null;
    }
  },

  /**
   * List all users visible to the service account in the current workspace.
   * Returns an array of PMS user objects (with _id, name, email, role, title fields).
   */
  listUsers: () => request("GET", "/api/users"),

  /**
   * Fetch the members of a specific PMS project.
   * Returns the project object (which has a `members` array of user IDs).
   */
  getProjectMembers: async (projectId) => {
    const proj = await request("GET", `/api/projects/${encodeURIComponent(projectId)}`);
    if (!proj?.members?.length) return [];
    // Fetch all workspace users, then filter to project members.
    // PMS REST API serialises the user id as `id` (not `_id`), so check both.
    const allUsers = await request("GET", "/api/users");
    const memberSet = new Set(proj.members.map(String));
    return (Array.isArray(allUsers) ? allUsers : []).filter((u) =>
      memberSet.has(String(u.id ?? u._id)),
    );
  },

  /**
   * Partial-update a PMS task (assignee, title, description, priority, due, points).
   * taskId is the PMS task _id string (e.g. "TEST-12").
   * patch is a plain object with the fields to change.
   */
  updateTask: (taskId, patch) =>
    request("PATCH", `/api/tasks/${encodeURIComponent(taskId)}`, { body: patch }),

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
