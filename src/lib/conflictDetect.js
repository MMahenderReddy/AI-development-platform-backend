/**
 * Conflict detection: checks whether the base branch has diverged since the
 * clone was made and whether a text merge would produce conflicts.
 *
 * This is a safeguard — it does NOT block the push (the Team Lead sees any
 * warning in the diff review page and decides). Errors here are non-fatal.
 */

/**
 * @param {import('simple-git').SimpleGit} git
 * @param {string} baseBranch  e.g. "main"
 * @param {string} cloneBaseSha  SHA recorded at clone time
 * @returns {{ diverged: boolean, hasConflicts: boolean|null, message: string, latestBaseSha?: string }}
 */
export async function detectConflicts(git, baseBranch, cloneBaseSha) {
  try {
    await git.fetch(["origin", baseBranch]);

    const latestBaseSha = (await git.revparse([`origin/${baseBranch}`])).trim();

    if (latestBaseSha === cloneBaseSha) {
      return { diverged: false, hasConflicts: false, message: "Base branch is up to date" };
    }

    // Base has moved since clone — try merge-tree to detect text conflicts
    const branchHeadSha = (await git.revparse(["HEAD"])).trim();

    let hasConflicts = null;
    try {
      // git merge-tree exits with code 1 when conflicts exist
      await git.raw([
        "merge-tree",
        "--write-tree",
        "--name-only",
        cloneBaseSha,
        latestBaseSha,
        branchHeadSha,
      ]);
      hasConflicts = false;
    } catch (mergeErr) {
      // exit code 1 = conflicts; non-zero for other reasons = unknown
      hasConflicts = mergeErr.message?.includes("CONFLICT") ? true : null;
    }

    const short = (sha) => sha.slice(0, 7);
    return {
      diverged: true,
      hasConflicts,
      latestBaseSha,
      message: hasConflicts
        ? `Merge conflicts detected with ${baseBranch} (${short(cloneBaseSha)} → ${short(latestBaseSha)}). Manual resolution required before push.`
        : `Base branch moved (${short(cloneBaseSha)} → ${short(latestBaseSha)}) but no text conflicts detected.`,
    };
  } catch (err) {
    console.warn("[conflict-detect]", err.message);
    return { diverged: false, hasConflicts: null, message: err.message };
  }
}
