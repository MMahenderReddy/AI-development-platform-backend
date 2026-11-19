/**
 * GitHub App user-to-server (OAuth) token management.
 *
 * Token STORAGE is in the PMS database (not the orchestrator).
 * resolveUserToken() calls the PMS API to retrieve a valid token.
 * The code-exchange helpers (exchangeCode, getGitHubUser, …) run during the
 * orchestrator's OAuth callback before the tokens are forwarded to PMS.
 */
import { pmsClient } from "./pmsClient.js";

const GH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GH_API = "https://api.github.com";

function clientId() {
  const id = process.env.GITHUB_APP_CLIENT_ID ?? "";
  if (!id) throw new Error("GITHUB_APP_CLIENT_ID not set");
  return id;
}
function clientSecret() {
  const s = process.env.GITHUB_APP_CLIENT_SECRET ?? "";
  if (!s) throw new Error("GITHUB_APP_CLIENT_SECRET not set");
  return s;
}

// ── Exchange authorization code for tokens ────────────────────────────────────

export async function exchangeCode(code) {
  const res = await fetch(GH_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId(),
      client_secret: clientSecret(),
      code,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`GitHub OAuth error: ${data.error_description ?? data.error}`);
  return data; // { access_token, refresh_token, expires_in, refresh_token_expires_in, token_type, scope }
}

// ── Refresh an expired access token ──────────────────────────────────────────

export async function refreshAccessToken(refreshToken) {
  const res = await fetch(GH_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`GitHub token refresh error: ${data.error_description ?? data.error}`);
  return data;
}

// ── Get authenticated GitHub user info ───────────────────────────────────────

export async function getGitHubUser(accessToken) {
  const res = await fetch(`${GH_API}/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`GitHub user lookup failed (${res.status})`);
  return res.json(); // { login, id, name, email, ... }
}

// ── Get user's primary verified email ────────────────────────────────────────

export async function getGitHubPrimaryEmail(accessToken) {
  const res = await fetch(`${GH_API}/user/emails`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) return null;
  const emails = await res.json();
  const primary = emails.find((e) => e.primary && e.verified);
  return primary?.email ?? null;
}

// ── Check if user has write on a repo ────────────────────────────────────────

export async function checkRepoPermission(accessToken, fullName) {
  const res = await fetch(`${GH_API}/repos/${fullName}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) return "none";
  const data = await res.json();
  const perm = data.permissions ?? {};
  if (perm.admin || perm.maintain || perm.push) return "write";
  if (perm.triage || perm.pull) return "read";
  return "none";
}

// ── Resolve a valid access token for a member (fetched from PMS) ─────────────

export async function resolveUserToken(pmsUserId) {
  if (!pmsUserId) throw new Error("No pmsUserId provided — cannot retrieve GitHub credentials.");

  // PMS handles decryption and auto-refresh; throws if not connected.
  const result = await pmsClient.getGithubToken(pmsUserId);
  if (!result?.accessToken) {
    throw new Error(
      `Member has not connected their GitHub account. ` +
      `Ask them to open Profile → AI Orchestrator and click Connect GitHub.`,
    );
  }
  return result.accessToken;
}
