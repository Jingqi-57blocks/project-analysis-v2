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
import { DERIVED_KINDS } from "../kb/kinds.js";
import { STRUCTURAL_KINDS as ALL_STRUCTURAL_KINDS } from "../structural/kinds.js";

/** One fact a slice resolved: its identity, verbatim value, citation and how it resolved. */
export interface CitedFact {
  readonly factId: string;
  /** The catalog kind the slice declared — kept, so the fact stays inside the slice. */
  readonly kind: FactKind;
  /** The verbatim payload of the fact — what the citation is about. */
  readonly value: unknown;
  readonly citation: SourceRef;
  readonly resolutionClass: ResolutionClass;
  /** Ownership inside a resolved module report; absent at project scope. */
  readonly scopeRole?: "core" | "supporting" | undefined;
}

/** Which store backs a catalog kind — the honest taxonomy of what this resolver can read. */
export type ReaderClass =
  | "behavior"
  | "structural"
  | "derived"
  | "semantic"
  | "diagnostic"
  | "identity"
  | "coverage"
  | "ledger"
  | "none";

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
const STRUCTURAL_KINDS: ReadonlySet<string> = new Set(ALL_STRUCTURAL_KINDS);
const DERIVED_FACT_KINDS: ReadonlySet<string> = new Set(DERIVED_KINDS);
const SEMANTIC_KINDS: ReadonlySet<string> = new Set([
  "project-title",
  "project-description",
  "readme-section",
  "doc-comment",
  "inline-comment",
  "test-name",
  "ui-label",
  "route-description",
  "type-name",
  "config-key",
  "source-excerpt",
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
  if (DERIVED_FACT_KINDS.has(kind)) return "derived";
  if (SEMANTIC_KINDS.has(kind)) return "semantic";
  return "none";
}

/** Every catalog kind this resolver can turn into cited facts — the reach of the `*` ledger slice. */
const ALL_RESOLVABLE_KINDS: readonly FactKind[] = [
  ...Object.keys(BEHAVIOR_KIND_OF),
  ...STRUCTURAL_KINDS,
  ...DERIVED_FACT_KINDS,
  ...SEMANTIC_KINDS,
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
  /** Raw formed-module ids folded into this canonical report module. */
  readonly rawModuleIds: ReadonlySet<string>;
  /** Exact formed entry identities. Shared router files alone must not widen scope. */
  readonly entryKeys: ReadonlySet<string>;
  /** Entries owned by the classified module itself, before linked supporting surfaces. */
  readonly coreEntryKeys: ReadonlySet<string>;
  /** Files whose path belongs to one of the canonical raw module identities. */
  readonly coreFiles: ReadonlySet<string>;
  /** Features linked by module formation; used for derived feature identity. */
  readonly featureIds: ReadonlySet<string>;
  /** Member files, qualified `root/relPath`, exactly as the module model states them. */
  readonly files: ReadonlySet<string>;
  readonly fileCount: number;
}

function normalizeModuleName(name: string): string {
  return name.toLowerCase().replace(/(?:ies|s)$/, (suffix) => (suffix === "ies" ? "y" : ""));
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
function pathMentionsModule(path: string, moduleName: string): boolean {
  const tokenize = (value: string) => value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(normalizeModuleName);
  const expected = tokenize(moduleName);
  const tokens = tokenize(path);
  if (expected.length === 0 || expected.length > tokens.length) return false;
  return tokens.some((_, index) => expected.every((token, offset) => tokens[index + offset] === token));
}

/**
 * Extra feature files are useful for UI labels and local helpers, but a generic
 * filename such as `ApplicationState` is not sufficient ownership evidence.
 * Requiring the module identity in the directory portion prevents a formed
 * `application` feature from absorbing a sibling `promotion/application_*`
 * implementation. Files reached by an allowed flow are still admitted below,
 * including legitimate filename-only helpers such as `worklogServices.js`.
 */
function directoryMentionsModule(path: string, moduleName: string): boolean {
  const slash = path.lastIndexOf("/");
  return slash >= 0 && pathMentionsModule(path.slice(0, slash), moduleName);
}

/**
 * Resolve the files owned by a module from the module's own entry points.
 *
 * The earlier implementation unioned every file of every linked feature. That
 * leaked unrelated code when one broad feature (for example "Application")
 * happened to own routes from several route modules. Entry keys are the module
 * formation evidence, so they are the authoritative boundary here: flow-step
 * sources are kept only for those entries. Feature files are admitted only when
 * their path also names the module, which brings in UI pages and helpers without
 * pulling a sibling route family into the slice.
 */
export function resolveModuleMembership(kb: KnowledgeBase, moduleId: string): ModuleMembership {
  const target = normalizeModuleName(moduleId);
  const matches = kb
    .modules()
    .filter((m) => normalizeModuleName(m.name) === target)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const module = matches[0];
  if (module === undefined) {
    return { moduleId, kbModuleId: null, kbModuleName: null, rawModuleIds: new Set(), entryKeys: new Set(), coreEntryKeys: new Set(), coreFiles: new Set(), featureIds: new Set(), files: new Set(), fileCount: 0 };
  }
  return resolveModuleMembershipForModules(kb, moduleId, [module.id]);
}

/** Build one report scope from one or more classified raw module candidates. */
export function resolveModuleMembershipForModules(
  kb: KnowledgeBase,
  moduleId: string,
  kbModuleIds: readonly string[],
  options: {
    readonly expandObservedSurface?: boolean;
    readonly excludedEntryKeys?: ReadonlySet<string>;
    /**
     * When a module contains both caller-observed and caller-unresolved entry
     * families, keep only the observed family in the reader-facing scope. The
     * unresolved implementation remains in the KB for later audit/report modes.
     */
    readonly preferObservedEntries?: boolean;
  } = {},
): ModuleMembership {
  const selected = kb.modules().filter((module) => kbModuleIds.includes(module.id));
  if (selected.length === 0) {
    return { moduleId, kbModuleId: null, kbModuleName: null, rawModuleIds: new Set(), entryKeys: new Set(), coreEntryKeys: new Set(), coreFiles: new Set(), featureIds: new Set(), files: new Set(), fileCount: 0 };
  }
  const files = new Set<string>();
  const coreFiles = new Set<string>();
  const entryKeys = new Set<string>();
  const coreEntryKeys = new Set<string>();
  const featureIds = new Set<string>();
  const excludedEntryKeys = options.excludedEntryKeys ?? new Set<string>();
  for (const module of selected) {
    const detail = kb.moduleDetail(module.id);
    const featureFlows = new Map((detail?.features ?? []).map((feature) => [
      feature.id,
      kb.flowsForFeature(feature.id),
    ] as const));
    const observedFlows = [...featureFlows.values()].flat().filter((flow) =>
      flow.steps[0]?.provenance !== null && flow.steps[0]?.provenance !== undefined,
    );
    const observedEntryKeys = new Set(observedFlows.map((flow) => flow.entryKey));
    const observedRoots = new Set(observedFlows.flatMap((flow) =>
      flow.steps
        .map((step) => step.provenance?.source.rootName)
        .filter((rootName): rootName is string => rootName !== undefined),
    ));
    const preferObserved = options.preferObservedEntries === true && observedEntryKeys.size > 0;
    // An entry independently owned by another classified report boundary wins
    // over an ambiguous raw module name. This is especially important for
    // generic identities such as `application`, `report`, or `service` that can
    // occur inside several unrelated capabilities.
    const moduleEntryKeys = new Set(module.entryKeys.filter((entryKey) =>
      !excludedEntryKeys.has(entryKey) && (!preferObserved || observedEntryKeys.has(entryKey)),
    ));
    for (const entryKey of moduleEntryKeys) {
      entryKeys.add(entryKey);
      coreEntryKeys.add(entryKey);
    }
    for (const feature of detail?.features ?? []) {
      featureIds.add(feature.id);
      for (const flow of featureFlows.get(feature.id) ?? []) {
        if (!moduleEntryKeys.has(flow.entryKey)) continue;
        for (const step of flow.steps) {
          const source = step.provenance?.source;
          if (source !== undefined) {
            const path = `${source.rootName}/${source.relPath}`;
            files.add(path);
            if (pathMentionsModule(source.relPath, module.name)) coreFiles.add(path);
          }
        }
      }
      for (const path of feature.filePaths) {
        const rootName = path.includes("/") ? path.slice(0, path.indexOf("/")) : path;
        if (directoryMentionsModule(path, module.name) && (!preferObserved || observedRoots.has(rootName))) {
          files.add(path);
          coreFiles.add(path);
        }
      }
    }
  }

  /*
   * A product surface can call a small API helper whose path does not repeat
   * the product name. If that helper has an already-resolved cross-root link,
   * carry the exact destination entry into this scope. This is deliberately
   * narrower than generic dependency closure: only a resolved call from an
   * owned file to a helper that itself owns a resolved boundary call qualifies,
   * and only that link's concrete destination entry and flow are admitted.
   */
  if (options.expandObservedSurface === true) {
    const links = kb.crossRootLinks();
    const boundaryFiles = new Set(links.map((link) => {
      const source = link.provenance.source;
      return `${source.rootName}/${source.relPath}`;
    }));
    const symbolsById = new Map(kb.symbols().map((symbol) => [symbol.id, symbol] as const));
    for (let round = 0; round < 2; round += 1) {
      let changed = false;
      for (const edge of kb.callEdges()) {
        const source = edge.provenance.source;
        if (!files.has(`${source.rootName}/${source.relPath}`) || edge.calleeId === null) continue;
        const callee = symbolsById.get(edge.calleeId);
        if (callee === undefined) continue;
        const calleeSource = callee.provenance.source;
        // A helper call is a source-language edge inside one analyzed root. A
        // same-named symbol in another service/root is not a valid way to jump
        // into that root; real cross-root expansion happens only through the
        // resolved HTTP boundary links below.
        if (source.rootName !== calleeSource.rootName) continue;
        const calleeFile = `${calleeSource.rootName}/${calleeSource.relPath}`;
        if (!boundaryFiles.has(calleeFile) || files.has(calleeFile)) continue;
        files.add(calleeFile);
        changed = true;
      }
      if (!changed) break;
    }

    const reachedEntries = new Set<string>();
    for (const link of links) {
      const source = link.provenance.source;
      if (!files.has(`${source.rootName}/${source.relPath}`)) continue;
      reachedEntries.add(`${link.toRoot}:${link.toMethod ?? "ANY"} ${link.toPath}`);
    }
    if (reachedEntries.size > 0) {
      const flows = kb.features().flatMap((feature) =>
        kb.flowsForFeature(feature.id).map((flow) => ({ featureId: feature.id, flow })),
      );
      for (const entryKey of reachedEntries) {
        if (excludedEntryKeys.has(entryKey)) continue;
        entryKeys.add(entryKey);
        for (const { featureId, flow } of flows) {
          if (flow.entryKey !== entryKey) continue;
          featureIds.add(featureId);
          for (const step of flow.steps) {
            const source = step.provenance?.source;
            if (source !== undefined) files.add(`${source.rootName}/${source.relPath}`);
          }
        }
        const separator = entryKey.indexOf(":");
        const methodEnd = entryKey.indexOf(" ", separator + 1);
        const rootName = separator < 0 ? "" : entryKey.slice(0, separator);
        const method = methodEnd < 0 ? "" : entryKey.slice(separator + 1, methodEnd);
        const path = methodEnd < 0 ? "" : entryKey.slice(methodEnd + 1);
        for (const route of kb.endpoints()) {
          if (route.rootName !== rootName || route.path !== path || (route.method ?? "ANY") !== method) continue;
          const source = route.provenance.source;
          files.add(`${source.rootName}/${source.relPath}`);
        }
      }
    }

    /*
     * Scheduled work can advance a module lifecycle without being reachable
     * from an HTTP entry. Admit only a scheduler file that accesses a table
     * already owned by the module and whose table name carries the module
     * identity. Sharing a generic user table therefore cannot pull every cron
     * job into every report.
     */
    const dataAccess = typeof kb.dataAccess === "function" ? kb.dataAccess() : [];
    const scheduled = typeof kb.scheduledTasks === "function" ? kb.scheduledTasks() : [];
    const coreEntities = new Set(
      dataAccess
        .filter((access) => {
          const source = access.provenance.source;
          return access.entity !== null &&
            coreFiles.has(`${source.rootName}/${source.relPath}`) &&
            selected.some((module) => pathMentionsModule(access.entity!, module.name));
        })
        .map((access) => access.entity!),
    );
    if (coreEntities.size > 0 && scheduled.length > 0) {
      const scheduledFiles = new Set(scheduled.map((task) => `${task.rootName}/${task.source.relPath}`));
      for (const access of dataAccess) {
        if (access.entity === null || !coreEntities.has(access.entity)) continue;
        const source = access.provenance.source;
        const path = `${source.rootName}/${source.relPath}`;
        if (scheduledFiles.has(path)) files.add(path);
      }
    }
  }
  return {
    moduleId,
    kbModuleId: selected.map((module) => module.id).sort().join("+"),
    kbModuleName: selected.map((module) => module.name).sort().join(" + "),
    rawModuleIds: new Set(selected.map((module) => module.id)),
    entryKeys,
    coreEntryKeys,
    coreFiles,
    featureIds,
    files,
    fileCount: files.size,
  };
}

// ---------------------------------------------------------------------------
// The readers — store-backed, read-only, deterministically ordered.
// ---------------------------------------------------------------------------

export interface SliceReaders {
  readonly store: Store;
  readonly snapshotId: number;
  readonly memberships: ReadonlyMap<string, ModuleMembership>;
}

export function createSliceReaders(
  store: Store,
  snapshotId: number,
  membership: ModuleMembership | readonly ModuleMembership[],
): SliceReaders {
  const list = Array.isArray(membership) ? membership : [membership];
  return { store, snapshotId, memberships: new Map(list.map((entry) => [entry.moduleId, entry] as const)) };
}

function membershipForScope(readers: SliceReaders, scope: Scope): ModuleMembership | null {
  return scope.kind === "project" ? null : (readers.memberships.get(scope.moduleId) ?? null);
}

function scopeRoleFor(
  membership: ModuleMembership | null,
  source: { rootName: string; relPath: string },
): "core" | "supporting" | undefined {
  if (membership === null) return undefined;
  return membership.coreFiles.has(`${source.rootName}/${source.relPath}`) ? "core" : "supporting";
}

function sourceIsInScope(readers: SliceReaders, scope: Scope, source: SourceRef): boolean {
  if (scope.kind === "project") return true;
  const membership = membershipForScope(readers, scope);
  return membership !== null && membershipIncludes(membership, source);
}

/** Behaviour facts of a catalog kind, scoped to the module by provenance path. */
function readBehavior(readers: SliceReaders, scope: Scope, catalogKind: FactKind): CitedFact[] {
  const out: CitedFact[] = [];
  const membership = membershipForScope(readers, scope);
  const transitionEndpoints = catalogKind === "state-transition"
    ? (() => {
        const rows = readers.store.all<{ from_id: string; to_id: string; role: string; payload: string }>(
          `SELECT r.from_id, r.to_id, r.role, f.payload
             FROM behavior_relations r
             JOIN behavior_facts f
               ON f.snapshot_id = r.snapshot_id AND f.fact_id = r.to_id
            WHERE r.snapshot_id = ? AND r.kind = 'transition-endpoint'
            ORDER BY r.from_id, r.role, r.to_id`,
          [readers.snapshotId],
        );
        const byTransition = new Map<string, { from?: unknown; to?: unknown; fromFactId?: string; toFactId?: string }>();
        for (const row of rows) {
          const endpointFact = JSON.parse(row.payload) as BehaviorFact;
          const endpoint = endpointFact.payload as unknown as Readonly<Record<string, unknown>>;
          const state = {
            label: endpoint.label ?? null,
            value: endpoint.value ?? null,
            valueSet: endpoint.valueSet ?? null,
          };
          const current = byTransition.get(row.from_id) ?? {};
          if (row.role === "from-state") {
            current.from = state;
            current.fromFactId = row.to_id;
          } else if (row.role === "to-state") {
            current.to = state;
            current.toFactId = row.to_id;
          }
          byTransition.set(row.from_id, current);
        }
        return byTransition;
      })()
    : new Map<string, { from?: unknown; to?: unknown; fromFactId?: string; toFactId?: string }>();
  for (const behaviorKind of BEHAVIOR_KIND_OF[catalogKind] ?? []) {
    const result = queryBehaviorFacts(readers.store, readers.snapshotId, { kind: behaviorKind });
    for (const fact of result.facts) {
      const evidence = fact.evidence.find((e) => sourceIsInScope(readers, scope, e.provenance.source));
      if (evidence === undefined) continue;
      const endpoints = transitionEndpoints.get(fact.factId);
      out.push({
        factId: fact.factId,
        kind: catalogKind,
        value: endpoints === undefined ? fact.payload : { ...fact.payload, ...endpoints },
        citation: evidence.provenance.source,
        resolutionClass: evidence.provenance.resolutionClass,
        scopeRole: scopeRoleFor(membership, evidence.provenance.source),
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

function routeIsInMembership(payload: unknown, membership: ModuleMembership): boolean {
  if (membership.entryKeys.size === 0) return true;
  if (typeof payload !== "object" || payload === null) return false;
  const route = payload as Record<string, unknown>;
  if (typeof route.rootName !== "string" || typeof route.path !== "string") return false;
  const method = typeof route.method === "string" ? route.method : "ANY";
  return membership.entryKeys.has(`${route.rootName}:${method} ${route.path}`);
}

/** Structural records of a catalog kind, scoped to the module by rel path. */
function readStructural(readers: SliceReaders, scope: Scope, catalogKind: FactKind): CitedFact[] {
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
    if (!sourceIsInScope(readers, scope, {
      rootName: row.root_name,
      relPath: row.rel_path,
      startLine: row.start_line,
      endLine: row.start_line,
      startColumn: null,
      endColumn: null,
    })) continue;
    const payload = JSON.parse(row.payload) as unknown;
    const membership = membershipForScope(readers, scope);
    if (catalogKind === "route" && membership !== null && !routeIsInMembership(payload, membership)) continue;
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
      scopeRole: scopeRoleFor(membership, citation),
    });
  }
  return out;
}

function derivedIsInMembership(kind: FactKind, payload: unknown, membership: ModuleMembership): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const value = payload as Record<string, unknown>;
  if (kind === "module") {
    return typeof value.id === "string" && membership.rawModuleIds.has(value.id);
  }
  if (kind === "feature-flow") {
    return typeof value.entryKey === "string" && membership.entryKeys.has(value.entryKey);
  }
  if (kind === "feature") {
    return typeof value.id === "string" && membership.featureIds.has(value.id);
  }
  if (kind === "feature-finding") {
    return typeof value.featureId === "string" && membership.featureIds.has(value.featureId);
  }
  return true;
}

interface DerivedRow {
  readonly record_key: string;
  readonly payload: string;
  readonly root_name: string | null;
  readonly rel_path: string | null;
  readonly start_line: number | null;
}

function endpointSource(readers: SliceReaders, endpoint: unknown): SourceRef | null {
  if (typeof endpoint !== "object" || endpoint === null) return null;
  const value = endpoint as Record<string, unknown>;
  if (typeof value.rootName !== "string" || typeof value.path !== "string") return null;
  const method = typeof value.method === "string" ? value.method : null;
  const rows = readers.store.all<{
    rel_path: string | null;
    start_line: number | null;
    root_name: string;
    payload: string;
  }>(
    `SELECT sr.rel_path, sr.start_line, src.name AS root_name, sr.payload
       FROM structural_records sr
       JOIN source_roots src ON src.id = sr.source_root_id
      WHERE sr.snapshot_id = ? AND sr.kind = 'route' AND src.name = ?
      ORDER BY sr.record_key`,
    [readers.snapshotId, value.rootName],
  );
  for (const row of rows) {
    const route = JSON.parse(row.payload) as { path?: unknown; method?: unknown };
    if (route.path !== value.path || (method !== null && route.method !== method)) continue;
    if (row.rel_path === null) continue;
    return {
      rootName: row.root_name,
      relPath: row.rel_path,
      startLine: row.start_line,
      endLine: row.start_line,
      startColumn: null,
      endColumn: null,
    };
  }
  return null;
}

/** A directly citable source carried by a derived record. */
function derivedSource(readers: SliceReaders, payload: unknown, row: DerivedRow): SourceRef | null {
  const direct = payloadSource(payload);
  if (direct !== null) return direct;
  if (row.root_name !== null && row.rel_path !== null) {
    return {
      rootName: row.root_name,
      relPath: row.rel_path,
      startLine: row.start_line,
      endLine: row.start_line,
      startColumn: null,
      endColumn: null,
    };
  }
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as Record<string, unknown>;
  if (Array.isArray(value.steps)) {
    for (const step of value.steps) {
      const source = payloadSource(step);
      if (source !== null) return source;
    }
  }
  if (Array.isArray(value.filePaths)) {
    const first = value.filePaths.find((path): path is string => typeof path === "string" && path.includes("/"));
    if (first !== undefined) {
      const slash = first.indexOf("/");
      return {
        rootName: first.slice(0, slash),
        relPath: first.slice(slash + 1),
        startLine: null,
        endLine: null,
        startColumn: null,
        endColumn: null,
      };
    }
  }
  if (Array.isArray(value.endpoints)) {
    for (const endpoint of value.endpoints) {
      const source = endpointSource(readers, endpoint);
      if (source !== null) return source;
    }
  }
  if (Array.isArray(value.evidence)) {
    for (const entry of value.evidence) {
      if (typeof entry !== "string") continue;
      const location = entry.split(" — ")[0] ?? entry;
      const match = /^(.*?):(\d+)(?::\d+)?$/.exec(location.trim());
      if (match === null) continue;
      const path = match[1]!;
      const line = Number(match[2]);
      const rows = readers.store.all<{ root_name: string; rel_path: string }>(
        `SELECT src.name AS root_name, f.rel_path
           FROM files f JOIN source_roots src ON src.id = f.source_root_id
          WHERE src.snapshot_id = ? AND (f.rel_path = ? OR (? LIKE src.name || '/%' AND ? = src.name || '/' || f.rel_path))
          ORDER BY src.name, f.rel_path LIMIT 1`,
        [readers.snapshotId, path, path, path],
      );
      const found = rows[0];
      if (found !== undefined) {
        return {
          rootName: found.root_name,
          relPath: found.rel_path,
          startLine: line,
          endLine: line,
          startColumn: null,
          endColumn: null,
        };
      }
    }
  }
  return null;
}

/** Derived conclusions such as modules, features, flows and rules. */
function readDerivedFacts(readers: SliceReaders, scope: Scope, kind: FactKind): CitedFact[] {
  const rows = readers.store.all<DerivedRow>(
    `SELECT record_key, payload, root_name, rel_path, start_line
       FROM derived_records
      WHERE snapshot_id = ? AND kind = ?
      ORDER BY record_key`,
    [readers.snapshotId, kind],
  );
  const out: CitedFact[] = [];
  for (const row of rows) {
    const value = JSON.parse(row.payload) as unknown;
    const membership = membershipForScope(readers, scope);
    if (membership !== null && !derivedIsInMembership(kind, value, membership)) continue;
    const citation = derivedSource(readers, value, row);
    if (citation === null || !sourceIsInScope(readers, scope, citation)) continue;
    const reportValue = kind === "feature-flow" && membership !== null && typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).entryKey === "string"
      ? {
          ...(value as Record<string, unknown>),
          reportScopeRole: membership.coreEntryKeys.has((value as Record<string, unknown>).entryKey as string) ? "core" : "supporting",
          steps: Array.isArray((value as Record<string, unknown>).steps)
            ? ((value as Record<string, unknown>).steps as unknown[]).map((step) => {
                if (typeof step !== "object" || step === null) return step;
                const stepValue = step as Record<string, unknown>;
                const source = payloadSource(stepValue);
                return source === null
                  ? stepValue
                  : { ...stepValue, reportScopeRole: scopeRoleFor(membership, source) ?? "supporting" };
              })
            : (value as Record<string, unknown>).steps,
        }
      : value;
    out.push({
      factId: `derived|${kind}|${row.record_key}`,
      kind,
      value: reportValue,
      citation,
      resolutionClass: "inferred",
      scopeRole: scopeRoleFor(membership, citation),
    });
  }
  return out;
}

interface SemanticRow {
  readonly item_key: string;
  readonly kind: string;
  readonly text: string;
  readonly label: string | null;
  readonly rel_path: string;
  readonly start_line: number | null;
  readonly end_line: number | null;
  readonly start_column: number | null;
  readonly resolution_class: string;
  readonly root_name: string;
}

/** Developer-written labels and comments, kept verbatim and source-cited. */
function readSemantic(readers: SliceReaders, scope: Scope, kind: FactKind): CitedFact[] {
  const rows = readers.store.all<SemanticRow>(
    `SELECT e.item_key, e.kind, e.text, e.label, e.rel_path, e.start_line, e.end_line,
            e.start_column, e.resolution_class, src.name AS root_name
       FROM evidence_items e
       JOIN source_roots src ON src.id = e.source_root_id
      WHERE e.snapshot_id = ? AND e.kind = ?
      ORDER BY e.item_key`,
    [readers.snapshotId, kind],
  );
  const out: CitedFact[] = [];
  for (const row of rows) {
    // Snapshots created before semantic-evidence-ranges have no persisted end
    // line.  A source excerpt is a contiguous verbatim chunk, so its exact
    // fallback range is recoverable from the stored text without reopening the
    // analyzed source.  Other evidence remains a single located line.
    const derivedEndLine = row.start_line === null
      ? null
      : row.kind === "source-excerpt"
        ? row.start_line + Math.max(0, row.text.split("\n").length - 1)
        : row.start_line;
    const citation: SourceRef = {
      rootName: row.root_name,
      relPath: row.rel_path,
      startLine: row.start_line,
      endLine: row.end_line ?? derivedEndLine,
      startColumn: row.start_column,
      endColumn: null,
    };
    if (!sourceIsInScope(readers, scope, citation)) continue;
    out.push({
      factId: `semantic|${row.kind}|${row.item_key}`,
      kind,
      value: { text: row.text, label: row.label },
      citation,
      resolutionClass: row.resolution_class as ResolutionClass,
      scopeRole: scopeRoleFor(membershipForScope(readers, scope), citation),
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
function readDiagnostic(readers: SliceReaders, scope: Scope): CitedFact[] {
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
    const evidence = fact.evidence.find((e) => sourceIsInScope(readers, scope, e.provenance.source));
    if (evidence === undefined) continue;
    out.push({
      factId: row.fact_id,
      kind: "diagnostic",
      value: { reason: row.reason },
      citation: evidence.provenance.source,
      resolutionClass: "inferred",
      scopeRole: scopeRoleFor(membershipForScope(readers, scope), evidence.provenance.source),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The resolver — a bounded slice of cited facts.
// ---------------------------------------------------------------------------

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
  // A requested module must have a resolved membership. Project scope deliberately
  // has no membership filter: it spans the frozen workspace once.
  if (scope.kind === "module" && !readers.memberships.has(scope.moduleId)) return [];

  const collected: CitedFact[] = [];
  for (const kind of [...new Set(expandKinds(factKinds))].sort()) {
    switch (readerClassOf(kind)) {
      case "behavior":
        collected.push(...readBehavior(readers, scope, kind));
        break;
      case "structural":
        collected.push(...readStructural(readers, scope, kind));
        break;
      case "derived":
        collected.push(...readDerivedFacts(readers, scope, kind));
        break;
      case "semantic":
        collected.push(...readSemantic(readers, scope, kind));
        break;
      case "diagnostic":
        collected.push(...readDiagnostic(readers, scope));
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
  const membership = readers.memberships.get(scope.moduleId);
  return membership !== undefined && membership.kbModuleId !== null && membership.fileCount > 0;
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
    case "derived":
    case "semantic":
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
