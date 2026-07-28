import { digestDirectory } from "../targets/digest.js";
import { readGitInfo } from "./gitinfo.js";

/** The subset of a selected root this stage needs. Avoids a dependency on workspace's Selection shape. */
export interface RootInput {
  readonly name: string;
  readonly path: string;
  readonly isGitRepo: boolean;
}

export interface RootSnapshot {
  readonly name: string;
  readonly path: string;
  /** Always present. This is the identity — git metadata is supplementary. */
  readonly contentDigest: string;
  readonly vcs: "git" | "none";
  readonly commitSha: string | null;
  readonly branch: string | null;
  /** `null` when `vcs` is `"none"` — there is no working tree to be dirty. */
  readonly dirty: boolean | null;
}

/**
 * Captures one root's identity: what it contains, and — where available —
 * what version control says about it.
 *
 * A root with `.git` whose git commands fail unexpectedly still gets
 * `vcs: "git"` with the remaining fields `null`. Falling back to `vcs: "none"`
 * would misrepresent a real repository as having no version control, which is
 * a wrong-but-confident answer rather than an honest unknown.
 */
export function snapshotRoot(root: RootInput): RootSnapshot {
  const contentDigest = digestDirectory(root.path);

  if (!root.isGitRepo) {
    return {
      name: root.name,
      path: root.path,
      contentDigest,
      vcs: "none",
      commitSha: null,
      branch: null,
      dirty: null,
    };
  }

  const info = readGitInfo(root.path);
  return {
    name: root.name,
    path: root.path,
    contentDigest,
    vcs: "git",
    commitSha: info?.commitSha ?? null,
    branch: info?.branch ?? null,
    dirty: info?.dirty ?? null,
  };
}
