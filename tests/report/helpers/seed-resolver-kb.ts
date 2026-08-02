/**
 * A hermetic in-memory knowledge base for the slice-resolver tests. It seeds the
 * minimal parent chain (workspace → snapshot → source root) and inserts behaviour
 * and structural facts directly, so a test can prove the resolver reads, cites and
 * scopes them without a real analysis run.
 */

import { IN_MEMORY, openStore } from "../../../engine/store/open.js";
import type { Store } from "../../../engine/store/types.js";
import type { ResolutionClass } from "../../../engine/contracts/shared-fact/provenance.js";
import type { ModuleMembership } from "../../../engine/report/slice-resolve.js";

export const SNAPSHOT_ID = 1;
export const ROOT_NAME = "r1";
export const ROOT_ID = 1;

export function seedStore(): Store {
  const store = openStore(IN_MEMORY);
  store.run("INSERT INTO workspaces (id, path, created_at) VALUES (1, '/ws', '2026-01-01T00:00:00Z')");
  store.run("INSERT INTO snapshots (id, workspace_id, identity, created_at, published_at) VALUES (?, 1, 'ident', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", [SNAPSHOT_ID]);
  store.run("INSERT INTO source_roots (id, snapshot_id, name, path, content_digest) VALUES (?, ?, ?, '/ws/r1', 'digest')", [ROOT_ID, SNAPSHOT_ID, ROOT_NAME]);
  return store;
}

export interface BehaviorSeed {
  readonly factId: string;
  readonly kind: string;
  readonly relPath: string;
  readonly startLine: number;
  readonly resolutionClass?: ResolutionClass;
  readonly payload?: Record<string, unknown>;
}

export function insertBehaviorFact(store: Store, seed: BehaviorSeed): void {
  const resolutionClass = seed.resolutionClass ?? "declared";
  const source = { rootName: ROOT_NAME, relPath: seed.relPath, startLine: seed.startLine, endLine: seed.startLine, startColumn: null, endColumn: null };
  const provenance =
    resolutionClass === "declared"
      ? { resolutionClass, source }
      : resolutionClass === "unresolved"
        ? { resolutionClass, source, unresolvedReason: "unknown target" }
        : resolutionClass === "inferred"
          ? { resolutionClass, source, confidence: "medium" }
          : { resolutionClass, source, confidence: null };
  const envelope = {
    factId: seed.factId,
    family: "behavioral",
    kind: seed.kind,
    schemaVersion: "1.0.0",
    evidence: [{ attribution: { providerId: "test", providerVersion: "1.0.0" }, provenance }],
    rawIdentities: [],
    payload: seed.payload ?? { scope: "module", activation: "always" },
  };
  store.run(
    "INSERT INTO behavior_facts (snapshot_id, fact_id, kind, family, scope, activation, schema_version, payload, quarantined) VALUES (?, ?, ?, 'behavioral', 'module', 'always', '1.0.0', ?, 0)",
    [SNAPSHOT_ID, seed.factId, seed.kind, JSON.stringify(envelope)],
  );
}

export interface StructuralSeed {
  readonly recordKey: string;
  readonly kind: string;
  readonly relPath: string;
  readonly startLine: number;
  readonly resolutionClass?: ResolutionClass;
  readonly payload?: Record<string, unknown>;
}

export function insertStructuralRecord(store: Store, seed: StructuralSeed): void {
  const payload = seed.payload ?? { name: seed.recordKey };
  store.run(
    "INSERT INTO structural_records (snapshot_id, source_root_id, kind, record_key, payload, resolution_class, rel_path, start_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [SNAPSHOT_ID, ROOT_ID, seed.kind, seed.recordKey, JSON.stringify(payload), seed.resolutionClass ?? "declared", seed.relPath, seed.startLine],
  );
}

/** A membership over an explicit set of `root/relPath` files — no module model needed. */
export function membershipOf(moduleId: string, relPaths: readonly string[]): ModuleMembership {
  const files = new Set(relPaths.map((p) => `${ROOT_NAME}/${p}`));
  return { moduleId, kbModuleId: "m", kbModuleName: `${moduleId}s`, files, fileCount: files.size };
}
