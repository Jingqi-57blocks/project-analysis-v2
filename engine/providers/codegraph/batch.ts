/**
 * The batch adapter contract for reading a CodeGraph index.
 *
 * This is the design boundary PI-6 implements and later M1 tasks read from. One
 * batch read enumerates everything downstream needs — nodes, edges, unresolved
 * references, metadata and truncation — instead of the former per-symbol CLI
 * loop (one subprocess per callable symbol, ~96% of a run).
 *
 * Two boundaries are fixed here and must not be crossed:
 *
 * 1. **Isolation.** CodeGraph's internal format never reaches the shared model.
 *    A record carries the graph's own `nativeId` as a raw identity; the
 *    canonical FactId (shared-fact contract) is assigned later, on the way into
 *    the model. Internal schema types stay private to the adapter.
 * 2. **Version traceability.** The CodeGraph and schema version are always
 *    recorded in the snapshot metadata, so an upgrade can never silently change
 *    a reported fact — a surprising result traces back to the version that
 *    produced it. A schema the adapter does not support fails closed.
 *
 * Interactive commands (explore/impact) are per-query and are NOT the base
 * import path — they are exactly what made the old adapter N+1. The batch path
 * reads an isolated, read-only, version-gated index database. Nothing is ever
 * written into analyzed source.
 */

import { VERIFIED_VERSION } from "./cli.js";

/** A node in the graph, in the adapter's vocabulary — not CodeGraph's internal shape. */
export interface CodeGraphNodeRecord {
  /** CodeGraph's own node id. A raw identity kept beside the canonical id, never inside it. */
  readonly nativeId: string;
  /** symbol | route | import | ... — an open label, not CodeGraph's internal enum. */
  readonly kind: string;
  readonly name: string;
  /** Relative to the index root. */
  readonly filePath: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface CodeGraphEdgeRecord {
  readonly nativeId: string;
  /** call | import | ... */
  readonly kind: string;
  readonly fromNativeId: string;
  /** Null when the edge is unresolved (see unresolvedReferences for the reason). */
  readonly toNativeId: string | null;
  readonly filePath: string;
  readonly startLine: number | null;
}

/** A reference the graph knows exists but could not resolve — a fact, not missing data. */
export interface UnresolvedReference {
  readonly fromNativeId: string;
  readonly name: string;
  readonly filePath: string;
  readonly startLine: number | null;
  readonly reason: string;
}

export interface SnapshotMetadata {
  readonly codegraphVersion: string;
  readonly schemaVersion: string;
  readonly indexRoot: string;
  /** The root prefixes covered, so the reader can partition without another query. */
  readonly rootPrefixes: readonly string[];
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface TruncationInfo {
  readonly truncated: boolean;
  readonly limit: number | null;
  readonly reason: string | null;
}

export interface CodeGraphSnapshot {
  readonly nodes: readonly CodeGraphNodeRecord[];
  readonly edges: readonly CodeGraphEdgeRecord[];
  readonly unresolvedReferences: readonly UnresolvedReference[];
  readonly metadata: SnapshotMetadata;
  readonly truncation: TruncationInfo;
}

/**
 * Why a batch read could not produce a trustworthy snapshot. The read fails
 * closed to one of these — never a partial snapshot presented as success.
 */
export type DegradationReason =
  | { readonly kind: "version-incompatible"; readonly installed: string | null; readonly verified: string }
  | { readonly kind: "schema-unsupported"; readonly found: string; readonly supported: string }
  | { readonly kind: "index-incomplete"; readonly detail: string }
  | { readonly kind: "index-build-failed"; readonly detail: string };

export type SnapshotOutcome =
  | { readonly ok: true; readonly snapshot: CodeGraphSnapshot }
  | { readonly ok: false; readonly degradation: DegradationReason };

/**
 * The batch adapter. One `read` enumerates the whole index for an index root
 * that lives outside every analyzed source root. Implemented in PI-6.
 */
export interface BatchAdapter {
  read(indexRoot: string): SnapshotOutcome;
}

export const VERIFIED_CODEGRAPH_VERSION = VERIFIED_VERSION;

/** The snapshot schema this adapter contract understands. Bumped by a breaking change. */
export const SUPPORTED_SNAPSHOT_SCHEMA = "1";

/**
 * The version/schema gate. A missing install or an unsupported schema fails
 * closed to a degradation. A CodeGraph version that differs from the verified
 * one is NOT a failure — the adapter still works across a patch bump — but it is
 * always carried in metadata, so a changed fact traces to the version. Returns
 * null when the snapshot may be trusted.
 */
export function checkVersionGate(
  installed: string | null,
  schema: string | null,
): DegradationReason | null {
  if (installed === null) {
    return { kind: "version-incompatible", installed: null, verified: VERIFIED_CODEGRAPH_VERSION };
  }
  if (schema !== null && schema !== SUPPORTED_SNAPSHOT_SCHEMA) {
    return { kind: "schema-unsupported", found: schema, supported: SUPPORTED_SNAPSHOT_SCHEMA };
  }
  return null;
}

/** True when a CodeGraph version differs from the verified one and must be recorded. */
export function versionDiffersFromVerified(installed: string): boolean {
  return installed !== VERIFIED_CODEGRAPH_VERSION;
}
