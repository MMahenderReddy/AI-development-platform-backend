/**
 * GitHub OAuth routes — individual member GitHub account connection.
 *
 * Token storage is in the PMS database, not the orchestrator.
 * After the OAuth code exchange, tokens are forwarded to PMS via pmsClient.
 *
 * Endpoints:
 *   GET  /api/github/oauth/initiate?pmsUserId=xxx  — redirect member to GitHub authorization
 *   GET  /api/github/oauth/callback               — exchange code, forward tokens to PMS
 *   DELETE /api/github/oauth/disconnect?pmsUserId=xxx — remove member's GitHub connection
 *   GET  /api/github/oauth/status?pmsUserId=xxx   — connection status (proxied from PMS)
 *   GET  /api/github/oauth/check-repo/:owner/:repo?pmsUserId=xxx — verify Write access
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
import config from "../config/env.js";
import { audit } from "../lib/audit.js";
import { badRequest, forbidden } from "../lib/errors.js";

const router = Router();

const CALLBACK_PATH = "/api/github/oauth/callback";

function callbackUrl() {
  return `${config.github.publicUrl}${CALLBACK_PATH}`;
}

// ── Initiate OAuth flow ───────────────────────────────────────────────────────
// pmsUserId must be passed as a query param by the PMS frontend.
// No S2S auth needed here — the signed state prevents CSRF.

router.get("/oauth/initiate", (req, res, next) => {
  try {
    if (!config.github.isOAuthConfigured()) {
      return res.status(503).json({
        error: "GITHUB_OAUTH_NOT_CONFIGURED",
        message: "GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET must be set in the orchestrator env.",
      });
    }

    const pmsUserId = String(req.query.pmsUserId ?? "").trim();
    if (!pmsUserId) {
      return res.status(400).json({ error: "BAD_REQUEST", message: "pmsUserId query param is required" });
    }

    // Signed state prevents CSRF on callback
    const state = jwt.sign({ pmsUserId, ts: Date.now() }, config.jwtSecret, { expiresIn: "10m" });

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

    // Decode state early so we can pass pmsUserId through error redirects
    let earlyUserId = "";
    if (state) {
      try {
        const p = jwt.verify(String(state), config.jwtSecret);
        earlyUserId = p.pmsUserId ?? "";
      } catch { /* expired/invalid — ignore */ }
    }

    if (ghError) {
      const ep = new URLSearchParams({ error: ghError });
      if (earlyUserId) ep.set("pmsUserId", earlyUserId);
      return res.redirect(`${config.corsOrigins[0]}/github-connected?${ep}`);
    }

    if (!code || !state) throw badRequest("Missing code or state");

    // Verify signed state — extracts pmsUserId directly
    let payload;
    try {
      payload = jwt.verify(String(state), config.jwtSecret);
    } catch {
      throw badRequest("Invalid or expired state parameter — please try connecting again");
    }

    const pmsUserId = payload.pmsUserId;
    if (!pmsUserId) throw badRequest("State missing pmsUserId");

    // Exchange code for tokens
    const tokenData = await exchangeCode(String(code));
    if (!tokenData.access_token) {
      throw new Error("GitHub did not return an access token");
    }

    // Fetch the GitHub user to verify identity
    const ghUser = await getGitHubUser(tokenData.access_token);
    const ghEmail = await getGitHubPrimaryEmail(tokenData.access_token);

    // Forward tokens to PMS for encrypted storage — orchestrator never persists them
    await pmsClient.storeGithubCredentials(pmsUserId, {
      githubUserId:            String(ghUser.id),
      githubLogin:             ghUser.login,
      githubEmail:             ghEmail ?? ghUser.email ?? "",
      accessToken:             tokenData.access_token,
      refreshToken:            tokenData.refresh_token ?? null,
      expiresIn:               tokenData.expires_in ?? null,
      refreshTokenExpiresIn:   tokenData.refresh_token_expires_in ?? null,
    });

    audit({ _id: pmsUserId }, "github.connected", {
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
    const pmsUserId = String(req.query.pmsUserId ?? req.body?.pmsUserId ?? "").trim();
    if (!pmsUserId) throw badRequest("pmsUserId is required");

    await pmsClient.disconnectGithub(pmsUserId).catch((e) =>
      console.warn("[github] PMS disconnect warning:", e.message)
    );

    audit(req.user, "github.disconnected", { details: { pmsUserId } });
    res.json({ ok: true, message: "GitHub account disconnected" });
  } catch (err) {
    next(err);
  }
});

// ── Status (proxied from PMS) ─────────────────────────────────────────────────

router.get("/oauth/status", requireAuth, async (req, res, next) => {
  try {
    const pmsUserId = String(req.query.pmsUserId ?? "").trim();
    if (!pmsUserId) throw badRequest("pmsUserId query param required");

    try {
      const status = await pmsClient.getGithubStatus(pmsUserId);
      res.json(status);
    } catch {
      res.json({ connected: false });
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
    const pmsUserId = String(req.query.pmsUserId ?? "").trim();
    if (!pmsUserId) throw badRequest("pmsUserId query param required");

    const token = await resolveUserToken(pmsUserId);
    const permission = await checkRepoPermission(token, fullName);

    res.json({
      connected: true,
      repoFullName: fullName,
      permission,
      canPush: permission === "write",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
