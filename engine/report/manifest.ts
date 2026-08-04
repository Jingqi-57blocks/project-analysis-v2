/**
 * The binding between a report and the snapshot it was written from.
 *
 * Without one, a report names no snapshot at all and the audit has to guess.
 * The guess it used to make — the highest snapshot id in the file — is wrong in
 * two ways the base's own design guarantees will happen: a knowledge base holds
 * more than one workspace, and a run that fails after persisting but before
 * publishing leaves an unpublished snapshot sitting at the highest id. Auditing
 * a report against either is auditing it against the wrong analysis, and the
 * verdict looks exactly the same as a correct one.
 *
 * So the author records what it read, and the audit re-resolves it from the
 * base and compares. A manifest that disagrees with the base is itself the
 * finding: it means the report was written from something other than what it
 * claims, or the base moved underneath it.
 */

import type { Store } from "../store/types.js";

export interface ReportManifest {
  /** The workspace the analysis covered, as the base records it. */
  readonly workspacePath: string;
  /** The run whose snapshot was read. The one field the author must supply. */
  readonly runId: string;
  readonly snapshotId: number;
  /** The source-state hash the snapshot was published under. */
  readonly identity: string;
  readonly publishedAt: string;
  readonly specId: string;
  readonly language: string;
  /** The code-index version behind this snapshot, or null when none took part. */
  readonly codegraphVersion: string | null;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new ManifestError(`manifest.json: "${field}" must be a non-empty string`);
  }
  return value;
}

/** Parses a manifest, refusing anything that would leave the binding partial. */
export function parseManifest(source: string): ReportManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new ManifestError(`manifest.json is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (typeof raw !== "object" || raw === null) throw new ManifestError("manifest.json must be an object");
  const record = raw as Record<string, unknown>;

  const snapshotId = record["snapshotId"];
  if (typeof snapshotId !== "number" || !Number.isInteger(snapshotId)) {
    throw new ManifestError('manifest.json: "snapshotId" must be an integer');
  }
  const codegraphVersion = record["codegraphVersion"];
  if (codegraphVersion !== null && typeof codegraphVersion !== "string") {
    throw new ManifestError('manifest.json: "codegraphVersion" must be a string or null');
  }

  return {
    workspacePath: requireString(record["workspacePath"], "workspacePath"),
    runId: requireString(record["runId"], "runId"),
    snapshotId,
    identity: requireString(record["identity"], "identity"),
    publishedAt: requireString(record["publishedAt"], "publishedAt"),
    specId: requireString(record["specId"], "specId"),
    language: requireString(record["language"], "language"),
    codegraphVersion: codegraphVersion ?? null,
  };
}

/** The code-index version recorded against a snapshot, or null if none ran. */
export function codegraphVersionOf(store: Store, snapshotId: number): string | null {
  const row = store.get<{ version: string | null }>(
    "SELECT version FROM provider_checks WHERE snapshot_id = ? AND provider_id = 'codegraph' AND available = 1",
    [snapshotId],
  );
  return row?.version ?? null;
}

export interface ResolvedSnapshotFacts {
  readonly id: number;
  readonly identity: string;
  readonly publishedAt: string;
  readonly workspacePath: string;
  readonly codegraphVersion: string | null;
}

/**
 * Every way the manifest can disagree with the base, named rather than counted.
 *
 * All four are reported together: knowing only that "something disagrees" leaves
 * the reader unable to tell a stale manifest from a rebuilt base.
 */
export function manifestDisagreements(
  manifest: ReportManifest,
  actual: ResolvedSnapshotFacts,
): readonly string[] {
  const out: string[] = [];
  if (manifest.snapshotId !== actual.id) {
    out.push(`snapshotId ${manifest.snapshotId} — run ${manifest.runId} is snapshot ${actual.id}`);
  }
  if (manifest.identity !== actual.identity) {
    out.push(`identity ${manifest.identity} — the published snapshot's is ${actual.identity}`);
  }
  if (manifest.publishedAt !== actual.publishedAt) {
    out.push(`publishedAt ${manifest.publishedAt} — the base records ${actual.publishedAt}`);
  }
  if (manifest.workspacePath !== actual.workspacePath) {
    out.push(`workspacePath ${manifest.workspacePath} — the base records ${actual.workspacePath}`);
  }
  if (manifest.codegraphVersion !== actual.codegraphVersion) {
    out.push(
      `codegraphVersion ${manifest.codegraphVersion ?? "null"} — the base records ${actual.codegraphVersion ?? "null"}`,
    );
  }
  return out;
}
