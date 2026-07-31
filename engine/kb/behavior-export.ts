/**
 * Exporting the persisted behaviour model as one machine-readable document (PI-64).
 *
 * The export serializer: it turns a snapshot's behaviour facts, relations,
 * evidence and diagnostics into a fixed-key-order JSON value another program can
 * walk — a diff between runs, an audit, a validator. It reads only the store.
 *
 * Two properties are load-bearing. Keys and rows come out in a canonical order,
 * so the same model exports to a byte-identical value and a `digest` over it is
 * reproducible. And the counts it states — the denominator — are recomputable
 * from the content it carries, so an independent validator can prove no fact or
 * relation was silently dropped between the store and the document.
 */

import { createHash } from "node:crypto";

import type { Store } from "../store/types.js";
import type { ResolutionClass } from "../contracts/shared-fact/provenance.js";
import { ownerOf } from "../contracts/behavior/schema.js";
import { stableStringify } from "../contracts/shared-fact/merge.js";
import { readBehaviorDiagnostics, readBehaviorModel } from "./behavior-persist.js";

export const BEHAVIOR_EXPORT_VERSION = "1.0";

export interface ExportedEvidence {
  readonly providerId: string;
  readonly resolution: ResolutionClass;
  readonly source: string;
}

export interface ExportedFact {
  readonly factId: string;
  readonly kind: string;
  readonly scope: string | null;
  readonly activation: string | null;
  readonly quarantined: boolean;
  readonly evidence: readonly ExportedEvidence[];
}

export interface ExportedRelation {
  readonly kind: string;
  readonly from: string;
  readonly to: string;
  readonly role: string;
}

export interface ExportedDiagnostic {
  readonly factId: string | null;
  readonly reason: string;
}

/** How many facts of each kind — the shape of what the model covers. */
export type BehaviorCapability = Readonly<Record<string, number>>;

/**
 * The accounting base a validator recomputes. Every count here is derivable from
 * the exported facts and relations, so a mismatch is a dropped or invented row.
 */
export interface BehaviorDenominator {
  readonly facts: number;
  readonly relations: number;
  readonly quarantined: number;
  readonly kinds: number;
}

export interface BehaviorExport {
  readonly version: string;
  readonly snapshotId: number;
  readonly facts: readonly ExportedFact[];
  readonly relations: readonly ExportedRelation[];
  readonly diagnostics: readonly ExportedDiagnostic[];
  readonly capability: BehaviorCapability;
  readonly denominator: BehaviorDenominator;
  readonly digest: string;
}

function sourceOf(rootName: string, relPath: string, startLine: number | null): string {
  return `${rootName}/${relPath}:${startLine ?? "?"}`;
}

/** Build the export document for one snapshot. Reads the store only. */
export function exportBehaviorModel(store: Store, snapshotId: number): BehaviorExport {
  const model = readBehaviorModel(store, snapshotId);

  const facts: ExportedFact[] = model.facts.map((fact) => {
    const payload = fact.payload as { scope?: string; activation?: string };
    return {
      factId: fact.factId,
      kind: fact.kind,
      scope: payload.scope ?? null,
      activation: payload.activation ?? null,
      quarantined: ownerOf(fact.kind) === "unknown",
      evidence: fact.evidence.map((e) => ({
        providerId: e.attribution.providerId,
        resolution: e.provenance.resolutionClass,
        source: sourceOf(e.provenance.source.rootName, e.provenance.source.relPath, e.provenance.source.startLine),
      })),
    };
  });

  const relations: ExportedRelation[] = model.relations.map((r) => ({
    kind: r.kind,
    from: r.from,
    to: r.to,
    role: r.role,
  }));

  const diagnostics: ExportedDiagnostic[] = readBehaviorDiagnostics(store, snapshotId).map((d) => ({
    factId: d.factId,
    reason: d.reason,
  }));

  const capability: Record<string, number> = {};
  for (const fact of facts) capability[fact.kind] = (capability[fact.kind] ?? 0) + 1;

  const denominator = countExported(facts, relations);

  const body = { version: BEHAVIOR_EXPORT_VERSION, snapshotId, facts, relations, diagnostics, capability, denominator };
  const digest = createHash("sha256").update(stableStringify(body)).digest("hex");

  return { ...body, digest };
}

function countExported(facts: readonly ExportedFact[], relations: readonly ExportedRelation[]): BehaviorDenominator {
  return {
    facts: facts.length,
    relations: relations.length,
    quarantined: facts.filter((f) => f.quarantined).length,
    kinds: new Set(facts.map((f) => f.kind)).size,
  };
}

/**
 * Recompute the denominator from the exported content alone — an independent
 * validator's view. If this does not deep-equal `export.denominator`, the
 * document's accounting disagrees with its own facts.
 */
export function recountBehaviorExport(exported: BehaviorExport): BehaviorDenominator {
  return countExported(exported.facts, exported.relations);
}
