/**
 * The frozen acceptance-target manifest.
 *
 * The two real projects V1 is graded on are pinned here by revision, so a test
 * or gate names a manifest identity rather than a floating branch, and a target
 * swap is a new manifest version with its reason recorded rather than an
 * in-place edit. A git root is pinned by commit SHA; a root with no version
 * control is pinned by a content digest (the same identity the drift check uses).
 *
 * Scope note: testing uses only WCP-V2 and angels-pizza. The Linear spec's
 * "third, distinct no-route-reader backend" is reconciled within these two —
 * angels-pizza's Vue-Router roots have no dedicated route reader, so it carries
 * the generic-path generalization (see `noDedicatedReader`).
 */

export type TargetVcs = "git" | "none";
export type RevisionKind = "git-sha" | "content-digest";
export type Gate = "M1" | "M2" | "M3" | "M4" | "M5" | "M6";
export const GATES: readonly Gate[] = ["M1", "M2", "M3", "M4", "M5", "M6"];

export interface TargetRoot {
  readonly name: string;
  readonly language: string;
  readonly vcs: TargetVcs;
  /** A 40-char git SHA, or a 64-char content digest. */
  readonly revision: string;
  readonly revisionKind: RevisionKind;
  readonly dirty: boolean;
  /** Whether a dedicated route reader (Gin/Express/React Router) recognizes this root. */
  readonly hasRouteReader: boolean;
  readonly note?: string;
}

export interface AcceptanceTarget {
  readonly id: string;
  /** Informational default; overridden per machine by the registry's env var. */
  readonly defaultPath: string;
  readonly vcs: TargetVcs;
  readonly roots: readonly TargetRoot[];
  /** The milestone gates this target participates in. */
  readonly gates: readonly Gate[];
  readonly selectionReason: string;
  /** True when the target exercises the generic path on roots no route reader covers. */
  readonly noDedicatedReader: boolean;
  /** The frozen prohibition: no target-specific production code, prompt or config. */
  readonly forbiddenSpecialization: string;
}

export interface TargetManifest {
  readonly version: string;
  readonly note: string;
  readonly targets: readonly AcceptanceTarget[];
}

export type ManifestValidation = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Structural validation: unique ids and root names, revisions matching their
 * kind (git SHA vs content digest), and the invariants the gates rely on — the
 * golden-slice target WCP-V2 is present, and at least one target exercises the
 * no-dedicated-reader generic path.
 */
export function validateManifest(manifest: TargetManifest): ManifestValidation {
  const reasons: string[] = [];
  const ids = new Set<string>();

  if (manifest.targets.length === 0) reasons.push("manifest has no targets");

  for (const target of manifest.targets) {
    if (ids.has(target.id)) reasons.push(`duplicate target id: ${target.id}`);
    ids.add(target.id);
    if (target.roots.length === 0) reasons.push(`${target.id}: no roots`);
    if (target.gates.length === 0) reasons.push(`${target.id}: no gates`);

    const rootNames = new Set<string>();
    for (const root of target.roots) {
      if (rootNames.has(root.name)) reasons.push(`${target.id}: duplicate root ${root.name}`);
      rootNames.add(root.name);
      for (const gate of target.gates) {
        if (!GATES.includes(gate)) reasons.push(`${target.id}: unknown gate ${gate}`);
      }
      const sha = /^[0-9a-f]{40}$/;
      const digest = /^[0-9a-f]{64}$/;
      if (root.revisionKind === "git-sha" && !sha.test(root.revision)) {
        reasons.push(`${target.id}/${root.name}: git-sha revision is not a 40-char SHA`);
      }
      if (root.revisionKind === "content-digest" && !digest.test(root.revision)) {
        reasons.push(`${target.id}/${root.name}: content-digest revision is not a 64-char digest`);
      }
      if (root.vcs === "none" && root.revisionKind !== "content-digest") {
        reasons.push(`${target.id}/${root.name}: a no-VCS root must be pinned by content digest`);
      }
    }
  }

  if (!ids.has("wcp-v2")) reasons.push("the golden-slice target wcp-v2 is missing");
  if (!manifest.targets.some((t) => t.noDedicatedReader)) {
    reasons.push("no target exercises the no-dedicated-reader generic path");
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
