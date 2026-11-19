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

const rawRequest = async (method, path, { body, cookie, workspace } = {}) => {
  const headers = {
    "Content-Type": "application/json",
  };
  if (cookie) headers["Cookie"] = `pms_token=${cookie}`;
  if (workspace === "consultants") headers["x-pms-workspace"] = "consultants";

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
      await getRedis().del(SESSION_KEY);
      const fresh = await login();
      return rawRequest(method, path, { ...options, cookie: fresh });
    }
    throw err;
  }
};

// ── Workspace-scoped client factory ──────────────────────────────────────────
// Workers use pmsClientFor(orcJob.pmsWorkspace ?? "core") to scope all API
// calls to the correct workspace (core = Tek Tree, consultants = Consultants).
const clientFor = (workspace) => ({
  me: () => request("GET", "/api/auth/me", { workspace }),
  ensureSession: async () => {
    try { await request("GET", "/api/auth/me", { workspace }); }
    catch { await getRedis().del(SESSION_KEY); await login(); }
  },
  listProjects: () => request("GET", "/api/projects", { workspace }),
  getProject: (projectId) => request("GET", `/api/projects/${encodeURIComponent(projectId)}`, { workspace }),
  createTask: (input) =>
    request("POST", "/api/tasks/ai-create", {
      body: { ...input, source: input.source ?? undefined },
      workspace,
    }),
  moveTask: (taskId, to, reason) =>
    request("POST", `/api/tasks/${encodeURIComponent(taskId)}/move`, { body: { to, reason }, workspace }),
  getTask: (taskId) => request("GET", `/api/tasks/${encodeURIComponent(taskId)}`, { workspace }),
  getTaskBySource: async (sourceKey) => {
    try {
      const res = await request("GET", `/api/tasks?source=${encodeURIComponent(sourceKey)}&limit=1`, { workspace });
      const tasks = Array.isArray(res) ? res : (res?.tasks ?? res?.data ?? []);
      return tasks.length > 0 ? tasks[0] : null;
    } catch { return null; }
  },
  listUsers: () => request("GET", "/api/users", { workspace }),
  getProjectMembers: async (projectId) => {
    const proj = await request("GET", `/api/projects/${encodeURIComponent(projectId)}`, { workspace });
    if (!proj?.members?.length) return [];
    const allUsers = await request("GET", "/api/users", { workspace });
    const memberSet = new Set(proj.members.map(String));
    return (Array.isArray(allUsers) ? allUsers : []).filter((u) =>
      memberSet.has(String(u.id ?? u._id)),
    );
  },
  updateTask: (taskId, patch) =>
    request("PATCH", `/api/tasks/${encodeURIComponent(taskId)}`, { body: patch, workspace }),
  storeGithubCredentials: (pmsUserId, data) =>
    request("POST", `/api/github/oauth/credentials/${encodeURIComponent(pmsUserId)}`, { body: data, workspace }),
  getGithubToken: (pmsUserId) =>
    request("GET", `/api/github/oauth/credentials/${encodeURIComponent(pmsUserId)}/token`, { workspace }),
  getGithubStatus: (pmsUserId) =>
    request("GET", `/api/github/oauth/credentials/${encodeURIComponent(pmsUserId)}/status`, { workspace }),
  disconnectGithub: (pmsUserId) =>
    request("DELETE", `/api/github/oauth/credentials/${encodeURIComponent(pmsUserId)}`, { workspace }),
  createPull: (projectId, { branch, title, description }) =>
    request("POST", `/api/pulls/${encodeURIComponent(projectId)}`, {
      body: { branch, title, description }, workspace,
    }),
  getPull: (projectId, number) =>
    request("GET", `/api/pulls/${encodeURIComponent(projectId)}/${number}`, { workspace }),
  listPullsForProject: (projectId) =>
    request("GET", `/api/pulls/${encodeURIComponent(projectId)}`, { workspace }),
});

// ── Public API ───────────────────────────────────────────────────────────────

/** Default client scoped to the core (Tek Tree) workspace. */
export const pmsClient = clientFor("core");

/**
 * Return a workspace-scoped PMS client.
 * Workers should call: const client = pmsClientFor(orcJob.pmsWorkspace ?? "core")
 * @param {string} workspace  "core" | "consultants"
 */
export const pmsClientFor = (workspace) => clientFor(workspace ?? "core");
