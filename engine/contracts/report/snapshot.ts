/**
 * The identity of the analysis a report request reads.
 *
 * Every target in one ReportRequest shares a single AnalysisSnapshot: source is
 * read and providers run once, and each document reuses the result rather than
 * re-analyzing. Two snapshots are interchangeable only when every identity input
 * matches; any difference invalidates reuse, so a stale analysis can never be
 * silently served for changed source, providers, schema or config.
 */

import { joinKey } from "../shared-fact/serialization.js";

export interface AnalysisSnapshotIdentity {
  /** Content digest of the analyzed workspace. */
  readonly sourceIdentity: string;
  readonly codeGraphIdentity: string;
  /** The provider set and their versions. */
  readonly providerIdentity: string;
  /** The fact schema/contract version the snapshot was built under. */
  readonly schemaVersion: string;
  readonly configIdentity: string;
}

export function snapshotKey(identity: AnalysisSnapshotIdentity): string {
  return joinKey([
    identity.sourceIdentity,
    identity.codeGraphIdentity,
    identity.providerIdentity,
    identity.schemaVersion,
    identity.configIdentity,
  ]);
}

/** Whether one analysis may be reused for another — true only on full identity. */
export function canReuseSnapshot(a: AnalysisSnapshotIdentity, b: AnalysisSnapshotIdentity): boolean {
  return snapshotKey(a) === snapshotKey(b);
}
