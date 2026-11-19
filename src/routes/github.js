/**
 * GitHub OAuth routes — individual member GitHub account connection.
 *
 * Token storage is in the PMS database, not the orchestrator.
 * After the OAuth code exchange, tokens are forwarded to PMS via pmsClient.
 *
 * Endpoints:
 *   GET  /api/github/oauth/initiate        — redirect member to GitHub authorization
 *   GET  /api/github/oauth/callback        — exchange code, forward tokens to PMS
 *   DELETE /api/github/oauth/disconnect    — remove member's GitHub connection (via PMS)
 *   GET  /api/github/oauth/status          — connection status (proxied from PMS)
 *   GET  /api/github/oauth/check-repo/:owner/:repo — verify Write access
 *   GET  /api/github/oauth/connect-page    — self-contained login+OAuth HTML page
 */
import { Router } from "express";
import jwt from "jsonwebtoken";
import { requireAuth } from "../middleware/auth.js";
import {
  exchangeCode,
  getGitHubUser,
  getGitHubPrimaryEmail,
  checkRepoPermission,
  resolveUserToken,
} from "../lib/githubOAuth.js";
import { pmsClient } from "../lib/pmsClient.js";
import OrchestratorUser from "../models/OrchestratorUser.js";
import config from "../config/env.js";
import { audit } from "../lib/audit.js";
import { badRequest, forbidden } from "../lib/errors.js";

const router = Router();

const CALLBACK_PATH = "/api/github/oauth/callback";

function callbackUrl() {
  return `${config.github.publicUrl}${CALLBACK_PATH}`;
}

// ── Initiate OAuth flow ───────────────────────────────────────────────────────

router.get("/oauth/initiate", requireAuth, (req, res, next) => {
  try {
    if (!config.github.isOAuthConfigured()) {
      return res.status(503).json({
        error: "GITHUB_OAUTH_NOT_CONFIGURED",
        message: "GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET must be set in the orchestrator env.",
      });
    }

    // Signed state prevents CSRF on callback
    const state = jwt.sign({ sub: String(req.user._id), ts: Date.now() }, config.jwtSecret, { expiresIn: "10m" });

    const params = new URLSearchParams({
      client_id: config.github.oauthClientId,
      redirect_uri: callbackUrl(),
      scope: "repo user:email",
      state,
    });

    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  } catch (err) {
    next(err);
  }
});

// ── OAuth callback ────────────────────────────────────────────────────────────

router.get("/oauth/callback", async (req, res, next) => {
  try {
    const { code, state, error: ghError } = req.query;

    if (ghError) {
      return res.redirect(
        `${config.corsOrigins[0]}/github-connected?error=${encodeURIComponent(ghError)}`
      );
    }

    if (!code || !state) throw badRequest("Missing code or state");

    // Verify signed state
    let payload;
    try {
      payload = jwt.verify(String(state), config.jwtSecret);
    } catch {
      throw badRequest("Invalid or expired state parameter — please try connecting again");
    }

    const orchestratorUserId = payload.sub;

    // Exchange code for tokens
    const tokenData = await exchangeCode(String(code));

    if (!tokenData.access_token) {
      throw new Error("GitHub did not return an access token");
    }

    // Fetch the GitHub user to verify identity
    const ghUser = await getGitHubUser(tokenData.access_token);
    const ghEmail = await getGitHubPrimaryEmail(tokenData.access_token);

    // Look up the orchestrator user to find their PMS user ID
    const orchUser = await OrchestratorUser.findById(orchestratorUserId).select("pmsUserId name").lean();
    if (!orchUser?.pmsUserId) {
      throw new Error(`Orchestrator user ${orchestratorUserId} has no linked PMS user ID`);
    }

    // Forward tokens to PMS for encrypted storage — orchestrator never persists them
    await pmsClient.storeGithubCredentials(orchUser.pmsUserId, {
      githubUserId:            String(ghUser.id),
      githubLogin:             ghUser.login,
      githubEmail:             ghEmail ?? ghUser.email ?? "",
      accessToken:             tokenData.access_token,
      refreshToken:            tokenData.refresh_token ?? null,
      expiresIn:               tokenData.expires_in ?? null,
      refreshTokenExpiresIn:   tokenData.refresh_token_expires_in ?? null,
    });

    // Store non-sensitive metadata only on the orchestrator user record
    await OrchestratorUser.findByIdAndUpdate(orchestratorUserId, {
      "githubAuth.githubUserId":  String(ghUser.id),
      "githubAuth.githubLogin":   ghUser.login,
      "githubAuth.githubEmail":   ghEmail ?? ghUser.email ?? "",
      "githubAuth.connectedAt":   new Date(),
    });

    audit({ _id: orchestratorUserId }, "github.connected", {
      details: { githubLogin: ghUser.login, githubUserId: ghUser.id },
    });

    // Redirect to frontend success page
    res.redirect(
      `${config.corsOrigins[0]}/github-connected?login=${encodeURIComponent(ghUser.login)}`
    );
  } catch (err) {
    next(err);
  }
});

// ── Disconnect ────────────────────────────────────────────────────────────────

router.delete("/oauth/disconnect", requireAuth, async (req, res, next) => {
  try {
    const targetId = req.query.userId ?? String(req.user._id);

    if (targetId !== String(req.user._id) && !["admin", "manager"].includes(req.user.role)) {
      throw forbidden("Only admin/manager can disconnect another member's GitHub account");
    }

    const orchUser = await OrchestratorUser.findById(targetId).select("pmsUserId email").lean();

    // Remove from PMS (the credential store)
    if (orchUser?.pmsUserId) {
      await pmsClient.disconnectGithub(orchUser.pmsUserId).catch((e) => console.warn("[github] PMS disconnect warning:", e.message));
    }

    // Clear metadata from orchestrator
    await OrchestratorUser.findByIdAndUpdate(targetId, { $unset: { githubAuth: 1 } });

    audit(req.user, "github.disconnected", { details: { targetEmail: orchUser?.email } });
    res.json({ ok: true, message: "GitHub account disconnected" });
  } catch (err) {
    next(err);
  }
});

// ── Status (proxied from PMS) ─────────────────────────────────────────────────

router.get("/oauth/status", requireAuth, async (req, res, next) => {
  try {
    const targetId = req.query.userId ?? String(req.user._id);

    if (targetId !== String(req.user._id) && !["admin", "manager"].includes(req.user.role)) {
      throw forbidden("Requires admin/manager role to view another member's status");
    }

    const orchUser = await OrchestratorUser.findById(targetId)
      .select("pmsUserId githubAuth.githubLogin githubAuth.githubEmail githubAuth.connectedAt")
      .lean();

    if (!orchUser) return res.status(404).json({ error: "NOT_FOUND", message: "User not found" });

    if (!orchUser.pmsUserId) {
      return res.json({ connected: false, reason: "no_pms_link" });
    }

    // Fetch authoritative status from PMS
    try {
      const status = await pmsClient.getGithubStatus(orchUser.pmsUserId);
      res.json(status);
    } catch {
      // Fall back to local metadata if PMS is unreachable
      const auth = orchUser.githubAuth;
      res.json(auth?.githubLogin ? { connected: true, githubLogin: auth.githubLogin, githubEmail: auth.githubEmail, connectedAt: auth.connectedAt } : { connected: false });
    }
  } catch (err) {
    next(err);
  }
});

// ── Check repo permission ─────────────────────────────────────────────────────

router.get("/oauth/check-repo/:owner/:repo", requireAuth, async (req, res, next) => {
  try {
    const { owner, repo } = req.params;
    const fullName = `${owner}/${repo}`;
    const targetId = req.query.userId ?? String(req.user._id);

    const orchUser = await OrchestratorUser.findById(targetId)
      .select("pmsUserId githubAuth.githubLogin")
      .lean();

    if (!orchUser?.pmsUserId) {
      return res.json({ connected: false, permission: "none", message: "GitHub account not connected" });
    }

    const token = await resolveUserToken(targetId); // calls PMS internally
    const permission = await checkRepoPermission(token, fullName);

    res.json({
      connected: true,
      githubLogin: orchUser.githubAuth?.githubLogin ?? null,
      repoFullName: fullName,
      permission,
      canPush: permission === "write",
    });
  } catch (err) {
    next(err);
  }
});

// ── Connect-page (login + OAuth in one visit, no separate orchestrator UI needed) ─────────────

const CONNECT_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect GitHub — KultWorks AI</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f4f5f7; color: #1a1a2e;
      min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
    }
    .card {
      background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,.10);
      padding: 40px; width: 100%; max-width: 420px;
    }
    .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 28px }
    .brand-icon { font-size: 28px }
    .brand-name { font-size: 18px; font-weight: 700; color: #3b51f8 }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px }
    .subtitle { font-size: 14px; color: #6b7280; margin-bottom: 28px; line-height: 1.5 }
    .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px }
    label { font-size: 13px; font-weight: 600; color: #374151 }
    input {
      border: 1px solid #d1d5db; border-radius: 8px; padding: 10px 14px;
      font-size: 14px; outline: none; transition: border-color .15s;
    }
    input:focus { border-color: #3b51f8; box-shadow: 0 0 0 3px rgba(59,81,248,.15) }
    .error { background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 10px 14px; font-size: 13px; color: #b91c1c; margin-bottom: 16px }
    button {
      width: 100%; padding: 11px; border: none; border-radius: 8px;
      background: #3b51f8; color: #fff; font-size: 14px; font-weight: 600;
      cursor: pointer; transition: background .15s; margin-top: 4px;
    }
    button:hover { background: #2d3fc7 }
    button:disabled { opacity: .6; cursor: not-allowed }
    .steps { margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 20px }
    .step { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px }
    .step-num { background: #eff2ff; color: #3b51f8; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; margin-top: 1px }
    .step-text { font-size: 13px; color: #4b5563; line-height: 1.5 }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <span class="brand-icon">🤖</span>
      <span class="brand-name">KultWorks AI</span>
    </div>
    <h1>Connect GitHub</h1>
    <p class="subtitle">Sign in with your orchestrator account to link your GitHub. The AI will push code and open pull requests under your GitHub identity.</p>
    <form id="form">
      <div class="field">
        <label for="email">Orchestrator email</label>
        <input type="email" id="email" placeholder="you@tektreeinc.com" required autofocus autocomplete="email">
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input type="password" id="password" required autocomplete="current-password">
      </div>
      <div id="error" class="error" hidden></div>
      <button type="submit" id="btn">Sign in &amp; Connect GitHub →</button>
    </form>
    <div class="steps">
      <div class="step"><div class="step-num">1</div><div class="step-text">Sign in with your orchestrator credentials</div></div>
      <div class="step"><div class="step-num">2</div><div class="step-text">Authorize on GitHub — one click, then you're done</div></div>
      <div class="step"><div class="step-num">3</div><div class="step-text">The AI uses your account for every push &amp; PR on your tasks</div></div>
    </div>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn');
      const errEl = document.getElementById('error');
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      errEl.hidden = true;
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('password').value })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message || 'Invalid credentials');
        window.location.href = '/api/github/oauth/initiate';
      } catch (ex) {
        errEl.textContent = ex.message;
        errEl.hidden = false;
        btn.disabled = false;
        btn.textContent = 'Sign in & Connect GitHub →';
      }
    });
  </script>
</body>
</html>`;

router.get("/oauth/connect-page", (req, res, next) => {
  try {
    // If already authenticated, skip the login form and go straight to OAuth
    const token = req.cookies?.orch_token;
    if (token) {
      try {
        jwt.verify(token, config.jwtSecret);
        return res.redirect("/api/github/oauth/initiate");
      } catch {
        // Token invalid/expired — fall through to show login form
      }
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(CONNECT_PAGE_HTML);
  } catch (err) {
    next(err);
  }
});

export default router;
