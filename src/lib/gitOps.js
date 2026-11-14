/**
 * Git operations for the AI code-generation pipeline.
 *
 * All commits use the bot identity — never a human user's name or email.
 * Clones are stored under <workspaceDir>/clones/<jobId> for persistence across
 * the generate → push-approval → push lifecycle.
 */
import { simpleGit } from "simple-git";
import { mkdir, rm, readFile } from "fs/promises";
import { join, resolve, sep } from "path";
import { githubClient } from "./githubClient.js";
import config from "../config/env.js";

export const BOT_NAME = "AI Orchestrator Bot";
export const BOT_EMAIL = "ai-orchestrator[bot]@users.noreply.github.com";

/** Returns the persistent clone directory path for a given job ID */
export function cloneDirForJob(jobId) {
  return resolve(join(config.sandbox.workspaceDir, "clones", String(jobId)));
}

/**
 * Clone <fullName> to targetDir using a fresh GitHub App token.
 * Returns a simple-git instance pre-configured with the bot identity.
 */
export async function cloneRepo(fullName, targetDir, { depth = 100 } = {}) {
  await mkdir(targetDir, { recursive: true });
  const cloneUrl = await githubClient.cloneUrl(fullName);
  const base = simpleGit();
  await base.clone(cloneUrl, targetDir, [`--depth=${depth}`]);
  const repo = simpleGit(targetDir);
  await repo.addConfig("user.name", BOT_NAME);
  await repo.addConfig("user.email", BOT_EMAIL);
  return repo;
}

/** Checkout a new branch off origin/<baseBranch> */
export async function createBranch(git, branchName, baseBranch) {
  await git.checkoutBranch(branchName, `origin/${baseBranch}`);
}

/** Stage all changes and create a commit with the bot identity already set */
export async function commitChanges(git, message) {
  await git.add(".");
  return git.commit(message);
}

/**
 * Push <branchName> to origin, refreshing the GitHub App token before pushing
 * so short-lived tokens never expire between generation and push.
 */
export async function pushBranch(git, branchName, fullName) {
  const freshUrl = await githubClient.cloneUrl(fullName);
  await git.remote(["set-url", "origin", freshUrl]);
  await git.push("origin", branchName, ["--set-upstream"]);
}

/** Get the diff between HEAD and the common ancestor with origin/<baseBranch> */
export async function getDiff(git, baseBranch) {
  const mergeBase = await git.raw(["merge-base", `origin/${baseBranch}`, "HEAD"]);
  return git.diff([mergeBase.trim(), "HEAD"]);
}

/** Return the current HEAD SHA */
export async function getHeadSha(git) {
  return (await git.revparse(["HEAD"])).trim();
}

/** Fetch latest remote state */
export async function fetchOrigin(git) {
  await git.fetch(["origin"]);
}

/** Remove the clone directory, suppressing errors (e.g. already deleted) */
export async function cleanupClone(dir) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {}
}

/**
 * Build a codebase context string from the repo for the AI prompt.
 * Uses `git ls-files` so .gitignore is automatically respected.
 * Total output is capped at maxChars.
 */
export async function buildCodebaseContext(git, repoDir, task, maxChars = 60000) {
  const rawList = await git.raw(["ls-files"]);
  const allFiles = rawList.split("\n").map((f) => f.trim()).filter(Boolean);

  // Score files: higher = more relevant to the task
  const keywords = (task.title + " " + (task.description ?? ""))
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);

  const scored = allFiles.map((f) => {
    const lower = f.toLowerCase();
    const score = keywords.reduce((n, kw) => n + (lower.includes(kw) ? 2 : 0), 0)
      + (f.includes("package.json") || f.includes("tsconfig") || f === "README.md" ? 1 : 0)
      + (f.endsWith(".md") ? 0.5 : 0);
    return { f, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const parts = [];
  let used = 0;
  for (const { f } of scored) {
    if (used >= maxChars) break;
    try {
      const content = await readFile(join(repoDir, f), "utf8");
      const snippet = content.slice(0, 8000); // cap per file
      const entry = `--- ${f} ---\n${snippet}\n`;
      if (used + entry.length > maxChars) continue;
      parts.push(entry);
      used += entry.length;
    } catch {}
  }

  return parts.join("\n") || "(empty repository)";
}

/**
 * Parse a unified diff into structured stats.
 * Returns { summary, filesChanged, additions, deletions, files }
 */
export function parseDiffStat(rawDiff) {
  const files = [];
  let additions = 0;
  let deletions = 0;

  const blocks = rawDiff.split(/^diff --git /m).slice(1);
  for (const block of blocks) {
    const match = block.match(/^a\/.+ b\/(.+)\n/);
    if (!match) continue;
    const path = match[1].trim();
    const adds = (block.match(/^\+(?!\+\+)/mg) ?? []).length;
    const dels = (block.match(/^-(?!--)/mg) ?? []).length;
    additions += adds;
    deletions += dels;
    files.push({ path, additions: adds, deletions: dels, patch: block.slice(0, 5000) });
  }

  return {
    summary: `${files.length} file(s) changed, ${additions} insertion(s)(+), ${deletions} deletion(s)(-)`,
    filesChanged: files.length,
    additions,
    deletions,
    files,
  };
}
