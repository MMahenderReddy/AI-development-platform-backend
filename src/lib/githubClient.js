/**
 * GitHub App client for the AI Development Orchestrator.
 *
 * This is a SEPARATE GitHub App from the one used by the PMS.
 * Required permissions: contents:write, pull_requests:write, metadata:read
 *
 * Uses RS256 JWT → installation access token (1h TTL) flow.
 * Token is cached in Redis and refreshed 5 minutes before expiry.
 */
import { createSign } from "crypto";
import { getRedis } from "./redis.js";
import config from "../config/env.js";

const TOKEN_KEY = "github:orchestrator:token";
const TOKEN_TTL_S = 55 * 60; // cache for 55 min — token expires in 60 min

// ── JWT Generation (RS256) ───────────────────────────────────────────────────

const makeAppJwt = () => {
  if (!config.github.appId || !config.github.privateKey) {
    throw new Error("GitHub App not configured — set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.github.appId })).toString("base64url");
  const data = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(data);
  const sig = sign.sign(config.github.privateKey, "base64url");
  return `${data}.${sig}`;
};

// ── Installation Token ───────────────────────────────────────────────────────

const fetchInstallationToken = async () => {
  const appJwt = makeAppJwt();
  const installationId = config.github.installationId;
  if (!installationId) throw new Error("GITHUB_APP_INSTALLATION_ID not set");

  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${appJwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub installation token fetch failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.token;
};

const getToken = async () => {
  const cached = await getRedis().get(TOKEN_KEY);
  if (cached) return cached;
  const token = await fetchInstallationToken();
  await getRedis().set(TOKEN_KEY, token, "EX", TOKEN_TTL_S);
  return token;
};

// ── GitHub API Helper ────────────────────────────────────────────────────────

const MAX_RATE_LIMIT_WAIT_MS = 2 * 60_000; // cap waits at 2 minutes

const ghRequest = async (method, path, body, _retried = false) => {
  const token = await getToken();
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Handle rate limiting — parse Retry-After or X-RateLimit-Reset, wait once
  if (!_retried && (res.status === 429 || (res.status === 403 && res.headers.get("X-RateLimit-Remaining") === "0"))) {
    let waitMs = 60_000;
    const retryAfter = res.headers.get("Retry-After");
    const rlReset = res.headers.get("X-RateLimit-Reset");
    if (retryAfter) {
      waitMs = Number(retryAfter) * 1000;
    } else if (rlReset) {
      waitMs = Math.max(1000, Number(rlReset) * 1000 - Date.now() + 1000);
    }
    waitMs = Math.min(waitMs, MAX_RATE_LIMIT_WAIT_MS);
    console.warn(`[github] rate limited — waiting ${Math.round(waitMs / 1000)}s (${method} ${path})`);
    await new Promise((r) => setTimeout(r, waitMs));
    return ghRequest(method, path, body, true);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.message ?? `GitHub API error ${res.status}`);
    err.status = res.status;
    err.code = res.status === 409 ? "CONFLICT" : res.status === 404 ? "NOT_FOUND"
      : (res.status === 429 || res.status === 403) ? "RATE_LIMITED" : "GITHUB_ERROR";
    throw err;
  }
  return res.status === 204 ? {} : res.json();
};

const enc = encodeURIComponent;

// ── Public API ───────────────────────────────────────────────────────────────

export const githubClient = {
  isConfigured: () => config.github.isConfigured(),

  /**
   * Returns HTTPS clone URL with embedded token for use with simple-git.
   * Format: https://x-access-token:{TOKEN}@github.com/{owner}/{repo}.git
   * The token is NOT logged.
   */
  cloneUrl: async (fullName) => {
    const token = await getToken();
    return `https://x-access-token:${token}@github.com/${fullName}.git`;
  },

  /** Get the default branch and current HEAD SHA. */
  repoInfo: (fullName) =>
    ghRequest("GET", `/repos/${fullName}`).then((r) => ({
      defaultBranch: r.default_branch,
      fullName: r.full_name,
    })),

  /** Create a branch from a base ref (defaults to repo default branch). */
  createBranch: async (fullName, branchName, fromRef) => {
    const refData = await ghRequest("GET", `/repos/${fullName}/git/ref/heads/${enc(fromRef)}`);
    const sha = refData.object.sha;
    await ghRequest("POST", `/repos/${fullName}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha,
    });
    return { name: branchName, sha };
  },

  /** Get the current HEAD SHA of a branch. */
  branchSha: (fullName, branch) =>
    ghRequest("GET", `/repos/${fullName}/git/ref/heads/${enc(branch)}`).then((r) => r.object.sha),

  /** Compare two refs — returns changed files. */
  compare: (fullName, base, head) =>
    ghRequest("GET", `/repos/${fullName}/compare/${enc(base)}...${enc(head)}`).then((r) => ({
      ahead: r.ahead_by,
      behind: r.behind_by,
      files: (r.files ?? []).map((f) => ({ path: f.filename, status: f.status })),
    })),

  /** Open a pull request. Returns { number, htmlUrl }. */
  createPull: (fullName, { branch, base, title, body }) =>
    ghRequest("POST", `/repos/${fullName}/pulls`, { title, head: branch, base, body }).then((p) => ({
      number: p.number,
      htmlUrl: p.html_url,
      title: p.title,
    })),

  /**
   * Find the first open PR whose head matches the given branch.
   * Returns { number, htmlUrl } or null if none found.
   * Used to recover the PR number when createPull returns 422 (PR already exists).
   */
  findPullByBranch: async (fullName, branch) => {
    const [owner] = fullName.split("/");
    const list = await ghRequest("GET", `/repos/${fullName}/pulls?state=open&head=${enc(owner)}:${enc(branch)}&per_page=5`);
    if (!Array.isArray(list) || list.length === 0) return null;
    const p = list[0];
    return { number: p.number, htmlUrl: p.html_url };
  },

  /** Get pull request status. */
  getPull: (fullName, number) =>
    ghRequest("GET", `/repos/${fullName}/pulls/${number}`).then((p) => ({
      number: p.number,
      state: p.merged_at ? "merged" : p.state,
      mergeable: p.mergeable,
      headSha: p.head.sha,
    })),

  /** List reviews for a pull request. Returns array of { user, state, submittedAt }. */
  getPullReviews: (fullName, number) =>
    ghRequest("GET", `/repos/${fullName}/pulls/${number}/reviews`).then((reviews) =>
      (reviews ?? []).map((r) => ({
        user: r.user?.login ?? "unknown",
        state: r.state,
        submittedAt: r.submitted_at,
      })),
    ),

  /**
   * Get all check runs for a commit SHA.
   * Returns { allPassed, anyFailed, pending, runs[] }
   * allPassed = every run completed successfully (or was skipped/neutral)
   * anyFailed = at least one run failed/cancelled/timed_out/action_required
   * pending   = at least one run is still queued/in_progress (and none failed)
   */
  getCheckRuns: async (fullName, ref) => {
    let runs = [];
    let page = 1;
    while (true) {
      const data = await ghRequest("GET", `/repos/${fullName}/commits/${enc(ref)}/check-runs?per_page=100&page=${page}`);
      const batch = data.check_runs ?? [];
      runs.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    if (runs.length === 0) return { allPassed: true, anyFailed: false, pending: false, runs: [] };
    const FAIL_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);
    const PASS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
    const anyFailed = runs.some((r) => r.status === "completed" && FAIL_CONCLUSIONS.has(r.conclusion));
    const pending   = runs.some((r) => r.status !== "completed");
    const allPassed = !anyFailed && !pending && runs.every((r) => PASS_CONCLUSIONS.has(r.conclusion));
    return {
      allPassed,
      anyFailed,
      pending,
      runs: runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion })),
    };
  },

  /**
   * Merge a pull request.
   * mergeMethod: "squash" (default) | "merge" | "rebase"
   * Returns { merged, sha, message }
   */
  mergePull: (fullName, number, { mergeMethod = "squash", commitTitle, commitMessage } = {}) =>
    ghRequest("PUT", `/repos/${fullName}/pulls/${number}/merge`, {
      merge_method: mergeMethod,
      ...(commitTitle  ? { commit_title:   commitTitle }  : {}),
      ...(commitMessage ? { commit_message: commitMessage } : {}),
    }).then((r) => ({
      merged:  r.merged ?? true,
      sha:     r.sha,
      message: r.message,
    })),
};
