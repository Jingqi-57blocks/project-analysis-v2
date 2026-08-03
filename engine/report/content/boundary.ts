/**
 * The product-manager report's project boundary, module map, roles and entries —
 * the deterministic content and the authored-block contracts for those sections.
 *
 * These render the facts a reader needs to answer "what is the system made of,
 * and who enters it from where": a module map with up/downstream neighbours, and
 * an entry list with the access each entry declares. They are pure — facts in,
 * structured content out — so nothing here re-scans source or invents a second
 * fact set. Real route paths and labels are carried verbatim with their citation;
 * a permission is shown only where an access fact declares it, never guessed from
 * a name. Counts equal the input, so a rendered map or list can be reconciled
 * against the fact ledger.
 *
 * A section that is empty for lack of the capability versus one confirmed to have
 * none is not decided here — that is the applicability determiner's job (PI-41);
 * this renders what the facts say, and its counts feed that decision.
 */

import type { FactKind } from "../../contracts/shared-fact/families.js";
import type { SourceRef } from "../../contracts/shared-fact/provenance.js";

/** The block ids and output schemas these renderers satisfy (from the catalog). */
export const MODULE_MAP_SCHEMA = "module-map.v1";
export const ENTRY_LIST_SCHEMA = "entry-list.v1";
export const MODULE_NEIGHBOURS_SCHEMA = "module-neighbours.v1";

// ---------------------------------------------------------------------------
// Inputs — the bounded facts these blocks read.
// ---------------------------------------------------------------------------

export interface ModuleRecord {
  readonly moduleId: string;
  readonly name: string;
  readonly citation: SourceRef;
}

export interface ContainmentRecord {
  readonly parentModuleId: string;
  readonly childModuleId: string;
}

/** A module-level call/reference edge — who depends on whom. */
export interface ModuleEdgeRecord {
  readonly fromModuleId: string;
  readonly toModuleId: string;
}

export interface EntryRecord {
  readonly entryId: string;
  /** route, cli, job, event — how the entry is reached. */
  readonly kind: string;
  /** The real label/path, carried verbatim. */
  readonly label: string;
  readonly moduleId: string;
  readonly citation: SourceRef;
}

/** A declared access requirement on an entry — an auth annotation, never a guess. */
export interface AccessRecord {
  readonly entryId: string;
  readonly mechanism: string;
  readonly requirement: string;
  readonly citation: SourceRef;
}

// ---------------------------------------------------------------------------
// Module map (deterministic).
// ---------------------------------------------------------------------------

export interface ModuleMapNode {
  readonly moduleId: string;
  readonly name: string;
  readonly children: readonly string[];
  readonly upstream: readonly string[];
  readonly downstream: readonly string[];
  readonly citation: SourceRef;
}

export interface ModuleMap {
  readonly nodes: readonly ModuleMapNode[];
  readonly moduleCount: number;
  /** Edges/containment that reference a module not in the input — surfaced, not dropped silently. */
  readonly danglingRefs: readonly string[];
}

const sortStrings = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/**
 * The module map: every module, its child modules, and its up/downstream
 * neighbours from the call edges. Deterministic — nodes and neighbour lists are
 * sorted, de-duplicated, and reference only known modules. `moduleCount` equals
 * the number of module records, so it reconciles with the ledger; an edge to an
 * unknown module is reported in `danglingRefs`, never invented into a node.
 */
export function renderModuleMap(
  modules: readonly ModuleRecord[],
  containment: readonly ContainmentRecord[],
  edges: readonly ModuleEdgeRecord[],
): ModuleMap {
  const known = new Set(modules.map((m) => m.moduleId));
  const dangling = new Set<string>();

  const childrenOf = new Map<string, string[]>();
  for (const c of containment) {
    if (!known.has(c.parentModuleId)) dangling.add(c.parentModuleId);
    if (!known.has(c.childModuleId)) dangling.add(c.childModuleId);
    if (known.has(c.parentModuleId) && known.has(c.childModuleId)) {
      (childrenOf.get(c.parentModuleId) ?? childrenOf.set(c.parentModuleId, []).get(c.parentModuleId)!).push(c.childModuleId);
    }
  }

  const downstreamOf = new Map<string, string[]>();
  const upstreamOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!known.has(e.fromModuleId)) dangling.add(e.fromModuleId);
    if (!known.has(e.toModuleId)) dangling.add(e.toModuleId);
    if (known.has(e.fromModuleId) && known.has(e.toModuleId) && e.fromModuleId !== e.toModuleId) {
      (downstreamOf.get(e.fromModuleId) ?? downstreamOf.set(e.fromModuleId, []).get(e.fromModuleId)!).push(e.toModuleId);
      (upstreamOf.get(e.toModuleId) ?? upstreamOf.set(e.toModuleId, []).get(e.toModuleId)!).push(e.fromModuleId);
    }
  }

  const nodes = [...modules]
    .sort((a, b) => (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0))
    .map((m) => ({
      moduleId: m.moduleId,
      name: m.name,
      children: sortStrings(childrenOf.get(m.moduleId) ?? []),
      upstream: sortStrings(upstreamOf.get(m.moduleId) ?? []),
      downstream: sortStrings(downstreamOf.get(m.moduleId) ?? []),
      citation: m.citation,
    }));

  return { nodes, moduleCount: modules.length, danglingRefs: sortStrings(dangling) };
}

export interface ModuleNeighbours {
  readonly moduleId: string;
  readonly children: readonly string[];
  readonly upstream: readonly string[];
  readonly downstream: readonly string[];
}

/**
 * One module's sub-structure and up/downstream — the module-scope neighbours
 * block. Children come from containment, up/downstream from the call edges (the
 * two fact kinds the block declares); references to unknown modules are dropped,
 * self-edges excluded.
 */
export function renderModuleNeighbours(
  moduleId: string,
  modules: readonly ModuleRecord[],
  containment: readonly ContainmentRecord[],
  edges: readonly ModuleEdgeRecord[],
): ModuleNeighbours {
  const known = new Set(modules.map((m) => m.moduleId));
  const children = sortStrings(containment.filter((c) => c.parentModuleId === moduleId && known.has(c.childModuleId)).map((c) => c.childModuleId));
  const upstream = sortStrings(edges.filter((e) => e.toModuleId === moduleId && known.has(e.fromModuleId) && e.fromModuleId !== moduleId).map((e) => e.fromModuleId));
  const downstream = sortStrings(edges.filter((e) => e.fromModuleId === moduleId && known.has(e.toModuleId) && e.toModuleId !== moduleId).map((e) => e.toModuleId));
  return { moduleId, children, upstream, downstream };
}

// ---------------------------------------------------------------------------
// Entry / role list (deterministic).
// ---------------------------------------------------------------------------

export interface EntryAccess {
  readonly mechanism: string;
  readonly requirement: string;
  readonly citation: SourceRef;
}

export interface EntryView {
  readonly entryId: string;
  readonly kind: string;
  readonly label: string;
  readonly moduleId: string;
  /** The declared access on this entry — empty when none is declared (not a guess of "public"). */
  readonly access: readonly EntryAccess[];
  readonly citation: SourceRef;
}

export interface EntryList {
  readonly entries: readonly EntryView[];
  readonly entryCount: number;
  readonly byModule: Readonly<Record<string, number>>;
  /** Total access/role facts read — reconciles with the ledger: rendered access + danglingAccess. */
  readonly accessCount: number;
  /** Entry ids named by an access fact but matching no entry — surfaced, not dropped. */
  readonly danglingAccess: readonly string[];
}

/** A stable citation key for tie-breaking, so equal-shape access facts still order. */
function citationKey(ref: SourceRef): string {
  return `${ref.rootName} ${ref.relPath} ${ref.startLine ?? -1} ${ref.startColumn ?? -1}`;
}

/**
 * The entry list: every entry, its module, and the access it declares. Labels and
 * paths are carried verbatim; access comes only from access facts, so an entry
 * with none is shown with none rather than assumed public. Deterministic — entries
 * sorted by id, access sorted, `entryCount` equals the input.
 */
export function renderEntryList(entries: readonly EntryRecord[], access: readonly AccessRecord[]): EntryList {
  const accessByEntry = new Map<string, EntryAccess[]>();
  for (const a of access) {
    (accessByEntry.get(a.entryId) ?? accessByEntry.set(a.entryId, []).get(a.entryId)!).push({
      mechanism: a.mechanism,
      requirement: a.requirement,
      citation: a.citation,
    });
  }

  const accessKey = (a: EntryAccess): string => `${a.mechanism} ${a.requirement} ${citationKey(a.citation)}`;
  const views = [...entries]
    .sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0))
    .map((e) => ({
      entryId: e.entryId,
      kind: e.kind,
      label: e.label,
      moduleId: e.moduleId,
      access: (accessByEntry.get(e.entryId) ?? []).sort((x, y) => (accessKey(x) < accessKey(y) ? -1 : accessKey(x) > accessKey(y) ? 1 : 0)),
      citation: e.citation,
    }));

  // A plain object would let a moduleId of "constructor"/"__proto__"/etc. corrupt
  // the tally — legal directory/package names — so count in a Map.
  const counts = new Map<string, number>();
  for (const v of views) counts.set(v.moduleId, (counts.get(v.moduleId) ?? 0) + 1);
  const byModule: Record<string, number> = Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  const entryIds = new Set(entries.map((e) => e.entryId));
  const danglingAccess = sortStrings(access.filter((a) => !entryIds.has(a.entryId)).map((a) => a.entryId));

  return { entries: views, entryCount: entries.length, byModule, accessCount: access.length, danglingAccess };
}

// ---------------------------------------------------------------------------
// Validators — the rendered content reconciles with the input.
// ---------------------------------------------------------------------------

export type ContentValidation = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

function hasCitation(ref: SourceRef): boolean {
  return ref.rootName.length > 0 && ref.relPath.length > 0;
}

export function validateModuleMap(map: ModuleMap, modules: readonly ModuleRecord[]): ContentValidation {
  const reasons: string[] = [];
  if (map.moduleCount !== modules.length) reasons.push(`module count ${map.moduleCount} ≠ ${modules.length} in the ledger`);
  if (map.nodes.length !== new Set(map.nodes.map((n) => n.moduleId)).size) reasons.push("duplicate module in the map");
  for (const node of map.nodes) if (!hasCitation(node.citation)) reasons.push(`module ${node.moduleId} has no citation`);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function validateEntryList(
  list: EntryList,
  entries: readonly EntryRecord[],
  access: readonly AccessRecord[],
): ContentValidation {
  const reasons: string[] = [];
  if (list.entryCount !== entries.length) reasons.push(`entry count ${list.entryCount} ≠ ${entries.length} in the ledger`);
  if (list.accessCount !== access.length) reasons.push(`access count ${list.accessCount} ≠ ${access.length} in the ledger`);
  const summed = Object.values(list.byModule).reduce((a, b) => a + b, 0);
  if (summed !== list.entryCount) reasons.push(`byModule sums to ${summed}, not ${list.entryCount}`);
  // Every access fact is either rendered on its entry or accounted as dangling.
  const entryIds = new Set(entries.map((e) => e.entryId));
  const rendered = list.entries.reduce((n, e) => n + e.access.length, 0);
  const danglingFacts = access.filter((a) => !entryIds.has(a.entryId)).length;
  if (rendered + danglingFacts !== list.accessCount) {
    reasons.push(`access ${rendered} rendered + ${danglingFacts} dangling ≠ ${list.accessCount}`);
  }
  for (const e of list.entries) {
    if (e.label.length === 0) reasons.push(`entry ${e.entryId} has an empty label`);
    if (!hasCitation(e.citation)) reasons.push(`entry ${e.entryId} has no citation`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// Authored-block contracts — prose the Host Agent writes and must cite.
// ---------------------------------------------------------------------------

export interface AuthoredBlockContract {
  readonly blockId: string;
  readonly outputSchemaId: string;
  readonly promptId: string;
  readonly citationRule: "required";
  readonly validatorId: string;
  readonly inputFactKinds: readonly FactKind[];
  /** The engine-owned prompt: audience framing plus the invariant rules. */
  readonly prompt: string;
}

const AUDIENCE_RULES = [
  "Write for a product manager: explain the current, observable behaviour in business language.",
  "State only what the cited facts support. Never invent a capability, name, path or number.",
  "Cite every claim by its fact id. Where evidence is missing, say so plainly rather than filling the gap.",
  "Use a technical term only when it is needed to name a product boundary or an external dependency.",
].join("\n");

/** project-boundary.capabilities — the product capabilities the module map implies. */
export const CAPABILITIES_BLOCK: AuthoredBlockContract = {
  blockId: "project-boundary.capabilities",
  outputSchemaId: "capabilities.v1",
  promptId: "capabilities.v1",
  citationRule: "required",
  validatorId: "capabilities.v1",
  inputFactKinds: ["module", "feature", "route", "ui-label", "readme-section"],
  prompt: `Summarise the product capabilities this project offers, grouped by the module map you are given.\n\n${AUDIENCE_RULES}`,
};

/** module-responsibility.summary — what the module is responsible for. */
export const MODULE_RESPONSIBILITY_BLOCK: AuthoredBlockContract = {
  blockId: "module-responsibility.summary",
  outputSchemaId: "module-responsibility.v1",
  promptId: "module-responsibility.v1",
  citationRule: "required",
  validatorId: "module-responsibility.v1",
  inputFactKinds: ["module", "feature", "feature-flow", "ui-label", "doc-comment"],
  prompt: `Describe this module's responsibility and boundary, and its up/downstream, from the neighbours you are given.\n\n${AUDIENCE_RULES}`,
};

export const PM_STRUCTURE_AUTHORED_BLOCKS: readonly AuthoredBlockContract[] = [
  CAPABILITIES_BLOCK,
  MODULE_RESPONSIBILITY_BLOCK,
];
