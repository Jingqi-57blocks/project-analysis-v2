/**
 * The deterministic slice resolver (PI-21/22/23): the read-only content/host
 * layer that turns a block's bounded fact-slice (a query descriptor — allowed
 * kinds and a scope) into concrete CITED FACTS drawn from the populated knowledge
 * base, with each fact's canonical id, its verbatim payload and a SourceRef
 * citation. Nothing here calls a model; the engine stays model-agnostic. The
 * prose an authored block eventually carries is deferred to the LLM host — this
 * layer only grounds it in checkable facts.
 *
 * A slice declares its kinds in the report catalog's vocabulary; the KB stores
 * facts under three readers. This maps each catalog `FactKind` to the reader that
 * owns it — behaviour kinds through `queryBehaviorFacts`, structural kinds through
 * the structural records, diagnostics through the diagnostic store — and filters
 * every fact to the requested module's file membership (from the module model) by
 * its provenance path, so a module report never cites another module's code.
 *
 * Determinism is the contract: every reader queries in a stable order (behaviour
 * by fact id, structural by record key), the kinds are iterated sorted, and the
 * merged result is de-duplicated and re-sorted by fact id. The same frozen KB
 * yields byte-identical cited facts on every run, which is what makes the report
 * digests reproducible.
 */

import type { FactKind } from "../contracts/shared-fact/families.js";
import type { ResolutionClass, SourceRef } from "../contracts/shared-fact/provenance.js";
import type { CoverageInput } from "../contracts/shared-fact/applicability.js";
import type { Scope } from "../contracts/report/target.js";
import type { BehaviorFact } from "../contracts/behavior/schema.js";
import type { Store } from "../store/types.js";
import { queryBehaviorFacts } from "../kb/behavior-query.js";
import type { KnowledgeBase } from "../kb/query.js";

/** One fact a slice resolved: its identity, verbatim value, citation and how it resolved. */
export interface CitedFact {
  readonly factId: string;
  /** The catalog kind the slice declared — kept, so the fact stays inside the slice. */
  readonly kind: FactKind;
  /** The verbatim payload of the fact — what the citation is about. */
  readonly value: unknown;
  readonly citation: SourceRef;
  readonly resolutionClass: ResolutionClass;
}

/** Which store backs a catalog kind — the honest taxonomy of what this resolver can read. */
export type ReaderClass = "behavior" | "structural" | "diagnostic" | "identity" | "coverage" | "ledger" | "none";

/**
 * Catalog kind → the behaviour vocabulary kind(s) it reads. Most map one-to-one;
 * the catalog's `state-transition` reads the behaviour model's `transition` facts.
 * A kind absent here is not a behaviour kind.
 */
const BEHAVIOR_KIND_OF: Readonly<Record<string, readonly string[]>> = {
  condition: ["condition"],
  decision: ["decision"],
  guard: ["guard"],
  "discarded-error": ["discarded-error"],
  "error-handling": ["error-handling"],
  "value-set": ["value-set"],
  "business-rule": ["business-rule"],
  "validation-rule": ["validation-rule"],
  "auth-annotation": ["auth-annotation"],
  "data-access": ["data-access"],
  "notification-call": ["notification-call"],
  "outbound-call": ["outbound-call"],
  "transaction-boundary": ["transaction-boundary"],
  "test-relation": ["test-relation"],
  "state-transition": ["transition"],
  state: ["state"],
};

/** Catalog kinds served by the structural records table. */
const STRUCTURAL_KINDS: ReadonlySet<string> = new Set([
  "symbol",
  "entity",
  "entity-relation",
  "entity-field",
  "entity-constraint",
  "module-containment",
  "import",
  "route",
  "package-dependency",
  "source-file",
  "scheduled-task",
]);

/** Kinds the identity section renders from run/snapshot identity, not a KB fact slice. */
const IDENTITY_KINDS: ReadonlySet<string> = new Set(["run-identity", "scope-identity"]);
/** Kinds the coverage section renders from the coverage accounting, not a KB fact slice. */
const COVERAGE_KINDS: ReadonlySet<string> = new Set(["coverage", "gap"]);

/** Which reader owns a catalog kind. `none` is honest: this resolver cannot read it. */
export function readerClassOf(kind: FactKind): ReaderClass {
  if (kind === "*") return "ledger";
  if (kind === "diagnostic") return "diagnostic";
  if (IDENTITY_KINDS.has(kind)) return "identity";
  if (COVERAGE_KINDS.has(kind)) return "coverage";
  if (kind in BEHAVIOR_KIND_OF) return "behavior";
  if (STRUCTURAL_KINDS.has(kind)) return "structural";
  return "none";
}

/** Every catalog kind this resolver can turn into cited facts — the reach of the `*` ledger slice. */
const ALL_RESOLVABLE_KINDS: readonly FactKind[] = [
  ...Object.keys(BEHAVIOR_KIND_OF),
  ...STRUCTURAL_KINDS,
];

// ---------------------------------------------------------------------------
// Module membership — the file set that scopes a module report to its own code.
// ---------------------------------------------------------------------------

/**
 * The leave/module file membership, drawn from the module model rather than a
 * hard-coded path. A fact belongs to the module iff its provenance source file is
 * one the module's features own.
 */
export interface ModuleMembership {
  /** The report scope id requested (e.g. `leave`). */
  readonly moduleId: string;
  /** The resolved knowledge-base module id, or null when none matched. */
  readonly kbModuleId: string | null;
  readonly kbModuleName: string | null;
  /** Member files, qualified `root/relPath`, exactly as the module model states them. */
  readonly files: ReadonlySet<string>;
  readonly fileCount: number;
}

function normalizeModuleName(name: string): string {
  return name.toLowerCase().replace(/s$/, "");
}

function membershipIncludes(membership: ModuleMembership, source: { rootName: string; relPath: string }): boolean {
  return membership.files.has(`${source.rootName}/${source.relPath}`);
}

/**
 * Resolve a report module id to its knowledge-base module and file membership. The
 * report vocabulary and the KB module names differ (a `leave` report scopes the
 * KB's `leaves` module), so names are matched on a normalized singular form. The
 * member files are the union of the module's features' own files. Fails soft: an
 * unmatched id yields an empty membership, so a slice honestly resolves nothing
 * rather than leaking the whole root.
 */
export function resolveModuleMembership(kb: KnowledgeBase, moduleId: string): ModuleMembership {
  const target = normalizeModuleName(moduleId);
  const matches = kb
    .modules()
    .filter((m) => normalizeModuleName(m.name) === target)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const module = matches[0];
  if (module === undefined) {
    return { moduleId, kbModuleId: null, kbModuleName: null, files: new Set(), fileCount: 0 };
  }
  const detail = kb.moduleDetail(module.id);
  const files = new Set<string>();
  for (const feature of detail?.features ?? []) {
    for (const path of feature.filePaths) files.add(path);
  }
  return { moduleId, kbModuleId: module.id, kbModuleName: module.name, files, fileCount: files.size };
}

// ---------------------------------------------------------------------------
// The readers — store-backed, read-only, deterministically ordered.
// ---------------------------------------------------------------------------

export interface SliceReaders {
  readonly store: Store;
  readonly snapshotId: number;
  readonly membership: ModuleMembership;
}

export function createSliceReaders(store: Store, snapshotId: number, membership: ModuleMembership): SliceReaders {
  return { store, snapshotId, membership };
}

/** Behaviour facts of a catalog kind, scoped to the module by provenance path. */
function readBehavior(readers: SliceReaders, catalogKind: FactKind): CitedFact[] {
  const out: CitedFact[] = [];
  for (const behaviorKind of BEHAVIOR_KIND_OF[catalogKind] ?? []) {
    const result = queryBehaviorFacts(readers.store, readers.snapshotId, { kind: behaviorKind });
    for (const fact of result.facts) {
      const evidence = fact.evidence.find((e) => membershipIncludes(readers.membership, e.provenance.source));
      if (evidence === undefined) continue;
      out.push({
        factId: fact.factId,
        kind: catalogKind,
        value: fact.payload,
        citation: evidence.provenance.source,
        resolutionClass: evidence.provenance.resolutionClass,
      });
    }
  }
  return out;
}

interface StructuralRow {
  readonly record_key: string;
  readonly payload: string;
  readonly resolution_class: string;
  readonly rel_path: string | null;
  readonly start_line: number | null;
  readonly root_name: string;
}

/** A SourceRef carried inside a structural payload, when it has one — the precise citation. */
function payloadSource(payload: unknown): SourceRef | null {
  if (typeof payload !== "object" || payload === null) return null;
  const provenance = (payload as { provenance?: unknown }).provenance;
  if (typeof provenance !== "object" || provenance === null) return null;
  const source = (provenance as { source?: unknown }).source;
  if (typeof source !== "object" || source === null) return null;
  const s = source as Record<string, unknown>;
  if (typeof s.rootName !== "string" || typeof s.relPath !== "string") return null;
  return source as SourceRef;
}

/** Structural records of a catalog kind, scoped to the module by rel path. */
function readStructural(readers: SliceReaders, catalogKind: FactKind): CitedFact[] {
  const rows = readers.store.all<StructuralRow>(
    `SELECT sr.record_key, sr.payload, sr.resolution_class, sr.rel_path, sr.start_line, src.name AS root_name
       FROM structural_records sr
       JOIN source_roots src ON src.id = sr.source_root_id
      WHERE sr.snapshot_id = ? AND sr.kind = ?
      ORDER BY sr.record_key`,
    [readers.snapshotId, catalogKind],
  );
  const out: CitedFact[] = [];
  for (const row of rows) {
    if (row.rel_path === null) continue;
    if (!membershipIncludes(readers.membership, { rootName: row.root_name, relPath: row.rel_path })) continue;
    const payload = JSON.parse(row.payload) as unknown;
    const citation: SourceRef = payloadSource(payload) ?? {
      rootName: row.root_name,
      relPath: row.rel_path,
      startLine: row.start_line,
      endLine: row.start_line,
      startColumn: null,
      endColumn: null,
    };
    out.push({
      factId: row.record_key,
      kind: catalogKind,
      value: payload,
      citation,
      resolutionClass: row.resolution_class as ResolutionClass,
    });
  }
  return out;
}

interface DiagnosticRow {
  readonly id: number;
  readonly fact_id: string | null;
  readonly reason: string;
}

/**
 * Diagnostics attributed to the module through the fact they concern. Diagnostics
 * are recorded against the fact base, not a module; this attributes one to the
 * module only when the fact it references is in the module's files. A diagnostic
 * with no such fact is left unattributed — the caller reads that as `unknown` at
 * module scope, never as a confirmed clean.
 */
function readDiagnostic(readers: SliceReaders): CitedFact[] {
  const rows = readers.store.all<DiagnosticRow>(
    "SELECT id, fact_id, reason FROM behavior_diagnostics WHERE snapshot_id = ? ORDER BY id",
    [readers.snapshotId],
  );
  const out: CitedFact[] = [];
  for (const row of rows) {
    if (row.fact_id === null) continue;
    const factRow = readers.store.get<{ payload: string }>(
      "SELECT payload FROM behavior_facts WHERE snapshot_id = ? AND fact_id = ?",
      [readers.snapshotId, row.fact_id],
    );
    if (factRow === undefined) continue;
    const fact = JSON.parse(factRow.payload) as BehaviorFact;
    const evidence = fact.evidence.find((e) => membershipIncludes(readers.membership, e.provenance.source));
    if (evidence === undefined) continue;
    out.push({
      factId: row.fact_id,
      kind: "diagnostic",
      value: { reason: row.reason },
      citation: evidence.provenance.source,
      resolutionClass: "inferred",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The resolver — a bounded slice of cited facts.
// ---------------------------------------------------------------------------

/** Whether a scope is the module this membership is for — the guard on path filtering. */
function scopeMatchesMembership(scope: Scope, membership: ModuleMembership): boolean {
  return scope.kind === "module" && scope.moduleId === membership.moduleId;
}

/** Expand the declared kinds, turning the `*` ledger slice into every readable kind. */
function expandKinds(factKinds: readonly FactKind[]): readonly FactKind[] {
  if (factKinds.includes("*")) return ALL_RESOLVABLE_KINDS;
  return factKinds;
}

/**
 * Resolve a block's bounded slice into cited facts. Each declared kind is read
 * from its owning store and filtered to the module's files (when the scope is that
 * module); the results are de-duplicated by fact id and returned in a stable
 * fact-id order. A kind this resolver cannot read contributes nothing — honestly
 * empty, never a fabricated fact.
 */
export function resolveSliceFacts(
  readers: SliceReaders,
  scope: Scope,
  factKinds: readonly FactKind[],
): readonly CitedFact[] {
  // Only filter to the module's files when this slice is that module's scope; a
  // slice compiled for a different scope resolves nothing here rather than leaking.
  if (scope.kind === "module" && !scopeMatchesMembership(scope, readers.membership)) return [];

  const collected: CitedFact[] = [];
  for (const kind of [...new Set(expandKinds(factKinds))].sort()) {
    switch (readerClassOf(kind)) {
      case "behavior":
        collected.push(...readBehavior(readers, kind));
        break;
      case "structural":
        collected.push(...readStructural(readers, kind));
        break;
      case "diagnostic":
        collected.push(...readDiagnostic(readers));
        break;
      // identity / coverage / ledger-with-no-behaviour-or-structural / none read no
      // KB fact slice — the deterministic renderer discloses them structurally.
      default:
        break;
    }
  }

  const seen = new Set<string>();
  const deduped = collected.filter((fact) => {
    if (seen.has(fact.factId)) return false;
    seen.add(fact.factId);
    return true;
  });
  return deduped.sort((a, b) => (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Per-kind coverage — the honest input the applicability compiler reads (PI-15).
// ---------------------------------------------------------------------------

export interface KindCoverageResult {
  readonly kind: FactKind;
  readonly reader: ReaderClass;
  readonly count: number;
  readonly factIds: readonly string[];
  /**
   * Whether the scope this coverage is for actually resolved to something the
   * denominator can be defined over. False only when the report is scoped to a
   * module the module model never surfaced (an unresolved module id): there is no
   * module to have found none IN, so its kinds must read `unknown`, not `not-found`.
   */
  readonly scopeResolved: boolean;
}

/**
 * Whether a scope resolved to a defined denominator. A module scope is undefined
 * when the module model never surfaced its id (kbModuleId is null), and equally
 * when it surfaced the module but bound it to no analyzed file (fileCount is 0) —
 * an endpoint-only module whose handlers never resolved to a file. Either way
 * there is no code to scan, so a "found none" over it would be a false empty; its
 * kinds must read `unknown` rather than `not-found`.
 */
function scopeIsResolved(readers: SliceReaders, scope: Scope): boolean {
  if (scope.kind !== "module") return true;
  if (scope.moduleId !== readers.membership.moduleId) return true;
  return readers.membership.kbModuleId !== null && readers.membership.fileCount > 0;
}

/** Resolve one declared kind's coverage in a scope — its reader, count and fact ids. */
export function resolveKindCoverage(readers: SliceReaders, scope: Scope, kind: FactKind): KindCoverageResult {
  const facts = resolveSliceFacts(readers, scope, [kind]);
  return {
    kind,
    reader: readerClassOf(kind),
    count: facts.length,
    factIds: facts.map((f) => f.factId),
    scopeResolved: scopeIsResolved(readers, scope),
  };
}

/**
 * Turn a resolved kind's coverage into a `CoverageInput` the applicability
 * classifier reads — strictly from the facts this deterministic pass actually
 * resolved, never a fiat "present":
 *
 * - a behaviour or structural kind, and the `*` fact ledger, are `found` when the
 *   slice resolved ≥1 cited fact and `not-found` when the module's files were
 *   scanned and genuinely hold none — but `unknown` (scope undefined) when the
 *   module itself never resolved, since there is nothing to have found none in;
 * - every other reader (`diagnostic`, `identity`, `coverage`, `none`) is `found`
 *   only if it actually resolved a cited fact; with none it is `unknown` via an
 *   undefined scope — an honest "this deterministic pass established nothing here",
 *   never a confirmed clean and never a claim of evidence a rendered section does
 *   not carry. Identity and coverage tables are rendered elsewhere (from run
 *   identity / coverage accounting), so their emptiness here is a deferred gap the
 *   caller lists, not a covered success.
 */
export function coverageInputForKind(result: KindCoverageResult): CoverageInput {
  const base = {
    capable: true,
    providerRan: true,
    scopeDefined: true,
    evidencePresent: false,
    notApplicableConfirmed: false,
    failed: false,
    truncated: false,
    conflict: false,
  };
  switch (result.reader) {
    case "behavior":
    case "structural":
    case "ledger":
      // An unresolved module scope has no defined denominator: report unknown
      // (scopeDefined:false) rather than a false "found none".
      return { ...base, scopeDefined: result.scopeResolved, evidencePresent: result.count > 0 && result.scopeResolved };
    case "diagnostic":
    case "identity":
    case "coverage":
    case "none":
      // Nothing was resolved for these in this deterministic fact-grounded pass —
      // an honest `unknown` (undefined scope), never a fabricated "evidence present".
      return result.count > 0 ? { ...base, evidencePresent: true } : { ...base, scopeDefined: false };
  }
}
