import { execFileSync } from "node:child_process";

/**
 * Version-control metadata for one root, read at analysis time.
 *
 * This is supplementary to the content digest, never a substitute for it — a
 * commit SHA does not identify what was read when the working tree is dirty,
 * since the SHA and the actual file bytes have diverged.
 */
export interface GitInfo {
  readonly commitSha: string;
  /** `null` for a detached HEAD. */
  readonly branch: string | null;
  readonly dirty: boolean;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args as string[], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Reads git metadata for a root that is already known to be a git repository.
 *
 * Read-only: every subcommand used here inspects state, none mutates it.
 *
 * Returns `null` only when the git commands themselves fail unexpectedly —
 * a corrupted repository, or no git binary on PATH. Callers must not treat
 * that as "not a git repo": the caller already established `.git` exists, so
 * a `null` here is an honest partial (commit/branch/dirty unknown), not
 * grounds to silently reclassify the root as unversioned.
 */
export function readGitInfo(rootPath: string): GitInfo | null {
  try {
    const commitSha = git(rootPath, ["rev-parse", "HEAD"]);
    const branchRef = git(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = git(rootPath, ["status", "--porcelain"]);

    return {
      commitSha,
      branch: branchRef === "HEAD" ? null : branchRef,
      dirty: status.length > 0,
    };
  } catch {
    return null;
  }
}
