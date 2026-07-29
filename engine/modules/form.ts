/**
 * Forms product modules from traces and technical components from structure.
 *
 * Two views over the same code, related many-to-many — not a partition where
 * one is the residue of the other. Consumes traces as data and never re-walks
 * the call graph.
 */

import { createHash } from "node:crypto";

import { joinKey } from "../structural/identity.js";

import type { ModuleContainmentRecord, PackageDependencyRecord } from "../structural/dependencies.js";
import type { SymbolRecord } from "../structural/code.js";
import type { SymbolId } from "../structural/identity.js";
import type { RouteRecord } from "../structural/boundaries.js";
import { singular } from "./features.js";
import type { Trace } from "./trace.js";

/**
 * Mutually exclusive, one per file. The only thing accounting sums.
 *
 * Kept separate from membership because overlapping sets cannot be added: a
 * file can serve two modules *and* belong to a component, so summing
 * memberships would count the codebase more than once.
 */
export type PrimaryDisposition =
  | "behavioral-source"
  | "technical-only"
  | "shared-infrastructure"
  | "unclassified";

export interface ProductModule {
  /** Opaque and stable. An entry-point path would mint a new module the day /orders became /v2/orders. */
  readonly id: string;
  readonly name: string;
  readonly entryKeys: readonly string[];
  readonly rootNames: readonly string[];
  readonly symbolIds: readonly SymbolId[];
  /** Which behavioural signal justified grouping these traces. */
  readonly groupingSignal: string;
}

export interface TechnicalComponent {
  readonly id: string;
  readonly name: string;
  readonly rootName: string;
  /** The structural evidence that identified it, independent of any trace. */
  readonly signals: readonly string[];
  readonly memberPaths: readonly string[];
}

export interface DispositionCounts {
  readonly behavioralSource: number;
  readonly technicalOnly: number;
  readonly sharedInfrastructure: number;
  readonly unclassified: number;
  readonly total: number;
}

/**
 * Modules, and the entry points that could not be in one.
 *
 * Kept together because the second is only meaningful beside the first: "eight
 * endpoints belong to no module" is an accounting statement, and dropping it
 * would silently shrink the total a reader is shown.
 */
export interface ModuleFormation {
  readonly modules: readonly ProductModule[];
  /** Entry keys whose every path segment names a way in rather than a thing. */
  readonly withoutResource: readonly string[];
}

export interface FormationResult {
  readonly modules: readonly ProductModule[];
  /** Entry keys that named no resource to group by. */
  readonly withoutResource: readonly string[];
  readonly components: readonly TechnicalComponent[];
  readonly dispositions: ReadonlyMap<string, PrimaryDisposition>;
  readonly counts: DispositionCounts;
}

/**
 * Names that must never, on their own, merge two traces into one module.
 *
 * Every authenticated route shares the auth middleware. If that counted as a
 * grouping signal the whole project would collapse into a single module —
 * technically true and completely useless. Shared infrastructure earns a
 * technical component instead, which is a first-class identity rather than a
 * consolation prize.
 */
const INFRASTRUCTURE_HINTS: readonly RegExp[] = [
  /\bauth(entication|orization)?\b/i,
  /\bmiddleware\b/i,
  /\blog(ger|ging)?\b/i,
  /\bconfig(uration)?\b/i,
  /\b(db|database|conn(ection)?|pool)\b/i,
  /\butil(s|ity|ities)?\b/i,
  /\bhelper(s)?\b/i,
  /\bcommon\b/i,
  /\bshared\b/i,
  /\bclient\b/i,
  /\berror(s|handler)?\b/i,
  /\bvalidat(e|or|ion)\b/i,
];

/**
 * Splits camelCase so word boundaries exist where a reader sees words.
 *
 * Without this, `\bmiddleware\b` never matches `authMiddleware` — there is no
 * non-word character between "auth" and "Middleware" for `\b` to anchor on, so
 * the single most common infrastructure naming style would slip through every
 * pattern here.
 */
function splitWords(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

export function looksInfrastructural(name: string): boolean {
  const words = splitWords(name);
  return INFRASTRUCTURE_HINTS.some((pattern) => pattern.test(words));
}

/** Stable, opaque, and derived from content rather than position. */
function stableId(prefix: string, parts: readonly string[]): string {
  const digest = createHash("sha256").update(joinKey([...parts].sort())).digest("hex");
  return `${prefix}_${digest.slice(0, 16)}`;
}

function pathSegments(trace: Trace): string[] {
  return trace.entryPath
    .split("/")
    .filter((segment) => segment !== "" && !segment.startsWith(":") && !segment.startsWith("*"));
}

/**
 * How many leading segments every entry point shares.
 *
 * Most APIs prefix every route — `/api`, `/api/v1`, `/internal`. Anchoring on
 * the first segment would then give every feature the same anchor and collapse
 * the whole project into one module, which is the same useless outcome the
 * shared-middleware rule exists to prevent, arriving by a different route.
 *
 * Computed from the data rather than from a list of known prefixes, so a
 * project using a convention nobody anticipated is handled the same way.
 */
export function sharedPrefixLength(traces: readonly Trace[]): number {
  const all = traces.map(pathSegments).filter((segments) => segments.length > 0);
  if (all.length < 2) return 0;

  let shared = 0;
  while (true) {
    const candidate = all[0]![shared];
    // Never consume the last segment of any entry: a module needs something
    // left to be named after.
    if (candidate === undefined) return shared;
    if (all.some((segments) => segments.length <= shared + 1 || segments[shared] !== candidate)) {
      return shared;
    }
    shared += 1;
  }
}

/**
 * Segments that say how to reach something rather than what it is.
 *
 * `sharedPrefixLength` removes a prefix every entry point has; it cannot
 * remove one that only half of them have. On a project mid-migration `/v2`
 * prefixes exactly the half that moved, so `v2` survived as an anchor and
 * became the largest module in the project — 401 of 721 endpoints across three
 * services, named after a version.
 *
 * An excluded segment never removes the route. `/v2/leaves` still groups under
 * `leaves`; only the segment stops being a candidate name.
 */
function namesAResource(segment: string): boolean {
  const name = segment.toLowerCase();
  if (/^v\d+$/.test(name)) return false;
  return !NOT_A_RESOURCE.has(name);
}

const NOT_A_RESOURCE = new Set(["api", "apis", "rest", "graphql", "public", "internal"]);

/**
 * The segment a trace is anchored on, past whatever prefix everything shares.
 *
 * Weak evidence on its own — used only to *name* a grouping, never to justify
 * one. Null where every segment names a way in rather than a thing: such an
 * entry point belongs to no module, which is a fact worth stating rather than
 * a reason to invent one.
 */
function anchorOf(trace: Trace, skip: number): string | null {
  const segments = pathSegments(trace);
  const candidates = segments.slice(skip).length > 0 ? segments.slice(skip) : segments;
  return candidates.find(namesAResource) ?? null;
}

/** The spelling most of the entry points actually use, ties broken by name. */
function commonest(spellings: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const spelling of spellings) counts.set(spelling, (counts.get(spelling) ?? 0) + 1);
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]![0];
}

/**
 * Groups traces that share a behavioural signal.
 *
 * The signal here is a shared entry-path anchor — traces reached through the
 * same top-level resource. Infrastructure symbols appearing in both traces are
 * explicitly not a signal, which is what stops every authenticated route from
 * merging into one module.
 */
export function formModules(traces: readonly Trace[]): ModuleFormation {
  const groups = new Map<string, { spellings: string[]; traces: Trace[] }>();
  const withoutResource: string[] = [];
  const skip = sharedPrefixLength(traces);

  for (const trace of traces) {
    const anchor = anchorOf(trace, skip);
    if (anchor === null) {
      withoutResource.push(trace.entryKey);
      continue;
    }
    // One service writes `/project/:id`, another `/projects` — the same
    // resource, and two modules of seventeen endpoints each unless the
    // spelling is set aside for grouping.
    const key = singular(anchor.toLowerCase());
    const existing = groups.get(key) ?? { spellings: [], traces: [] };
    existing.spellings.push(anchor);
    existing.traces.push(trace);
    groups.set(key, existing);
  }

  const modules = [...groups.values()]
    .map(({ spellings, traces: grouped }) => {
      const anchor = commonest(spellings);
      const entryKeys = grouped.map((trace) => trace.entryKey).sort();
      const symbolIds = [
        ...new Set(
          grouped.flatMap((trace) =>
            trace.steps.filter((step) => !looksInfrastructural(step.name)).map((step) => step.symbolId),
          ),
        ),
      ];

      return {
        id: stableId("mod", entryKeys),
        name: anchor,
        entryKeys,
        rootNames: [...new Set(grouped.map((trace) => trace.entryRoot))].sort(),
        symbolIds,
        groupingSignal: `entry points sharing the "${anchor}" resource`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { modules, withoutResource: withoutResource.sort() };
}

/**
 * Forms modules from entry points alone, for when nothing could be traced.
 *
 * Traces are the richer signal, but they need routes linked to handler
 * symbols, which no current provider supplies. Requiring them would mean a
 * report with no features at all on every real project — technically faithful
 * and useless to read.
 *
 * The grouping signal is the same one traces use: entry points sharing a
 * resource, past whatever prefix they all share.
 */
export function formModulesFromRoutes(routes: readonly RouteRecord[]): ModuleFormation {
  const asTraces: Trace[] = routes.map((route) => ({
    entryKey: `${route.rootName}:${route.method ?? "ANY"} ${route.path}`,
    entryRoot: route.rootName,
    entryMethod: route.method,
    entryPath: route.path,
    steps: [],
    truncation: "completed",
    truncationDetail: null,
    partial: false,
  }));

  const byResource = formModules(asTraces);

  // When route paths lack their framework group prefixes, the first segment is
  // an action rather than a resource — "add", "approve", "404" — and grouping
  // on it yields hundreds of one-endpoint modules. That is technically a
  // grouping and useless to read.
  //
  // Falling back to the service each entry point belongs to is coarser but
  // real: a root is a deployable unit with a purpose. The grouping signal
  // records which was used, so a reader is never left guessing what a module
  // represents.
  const grouping = byResource.modules;
  const averageEntries = grouping.length === 0 ? 0 : routes.length / grouping.length;
  if (grouping.length <= MAX_RESOURCE_MODULES || averageEntries >= MIN_ENTRIES_PER_MODULE) {
    return byResource;
  }

  // Grouping by service instead reaches every entry point, including the ones
  // that named no resource — a version-prefixed route still belongs to the
  // service that serves it.
  const byRoot = new Map<string, Trace[]>();
  for (const trace of asTraces) {
    const existing = byRoot.get(trace.entryRoot) ?? [];
    existing.push(trace);
    byRoot.set(trace.entryRoot, existing);
  }

  const modules = [...byRoot.entries()]
    .map(([rootName, grouped]) => {
      const entryKeys = grouped.map((trace) => trace.entryKey).sort();
      return {
        id: stableId("mod", entryKeys),
        name: rootName,
        entryKeys,
        rootNames: [rootName],
        symbolIds: [],
        groupingSignal:
          "grouped by service, because route paths were too fragmented to identify resources — " +
          "the framework's route prefixes are not resolved",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { modules, withoutResource: [] };
}

/** Above this many resource groups, the anchor is probably not a resource. */
const MAX_RESOURCE_MODULES = 25;
/** Below this many entry points per group, likewise. */
const MIN_ENTRIES_PER_MODULE = 3;

export interface ComponentInput {
  readonly containment: readonly ModuleContainmentRecord[];
  readonly dependencies: readonly PackageDependencyRecord[];
  readonly symbols: readonly SymbolRecord[];
}

/**
 * Identifies technical components from structure alone.
 *
 * Positively identified — from containment shape, declared dependencies and
 * fan-in — so a component exists whether or not any trace reaches it. Defining
 * components as whatever failed to join a trace would make every unrecognized
 * area look like a gap and leave shared infrastructure with no identity.
 */
export function formComponents(input: ComponentInput): readonly TechnicalComponent[] {
  const byContainer = new Map<string, { rootName: string; members: string[] }>();

  for (const record of input.containment) {
    // Only immediate directories under a root: recursing would make every
    // nested folder a component and drown the real boundaries.
    if (record.containerPath === "." && record.memberPath.includes(".") === false) {
      byContainer.set(`${record.rootName}/${record.memberPath}`, {
        rootName: record.rootName,
        members: [],
      });
    }
  }

  for (const record of input.containment) {
    for (const [key, entry] of byContainer) {
      const prefix = key.slice(entry.rootName.length + 1);
      if (record.rootName === entry.rootName && record.memberPath.startsWith(`${prefix}/`)) {
        entry.members.push(record.memberPath);
      }
    }
  }

  const dependencyNames = new Set(input.dependencies.map((dependency) => dependency.name));

  return [...byContainer.entries()]
    .map(([key, entry]) => {
      const name = key.slice(entry.rootName.length + 1);
      const signals: string[] = ["folder containment"];

      if (looksInfrastructural(name)) signals.push("name indicates shared infrastructure");
      if (dependencyNames.has(name)) signals.push("declared as a package dependency");
      if (entry.members.length >= 5) signals.push(`contains ${entry.members.length} members`);

      return {
        id: stableId("cmp", [key]),
        name,
        rootName: entry.rootName,
        signals,
        memberPaths: entry.members.sort(),
      };
    })
    .filter((component) => component.memberPaths.length > 0)
    .sort((a, b) => a.rootName.localeCompare(b.rootName) || a.name.localeCompare(b.name));
}

/**
 * Assigns each file exactly one disposition.
 *
 * A file reached by a trace is behavioural source; one that only ever appears
 * through infrastructure-named symbols is shared infrastructure; one belonging
 * to a component but no trace is technical-only; anything else is
 * unclassified, which is a state rather than a failure.
 */
/**
 * Files are identified by root *and* path.
 *
 * Two roots in one workspace routinely share a relative path — every Go
 * service has `main.go`, every template-generated one has
 * `internal/config/config.go`. Keying on the path alone lets the second
 * silently overwrite the first, so a file vanishes and the total it is counted
 * in comes out short. The accounting is supposed to hold by construction; a
 * shared key is exactly what breaks that.
 */
export function qualifiedFile(rootName: string, relPath: string): string {
  return joinKey([rootName, relPath]);
}

export function assignDispositions(
  allFiles: readonly string[],
  traces: readonly Trace[],
  symbolsById: ReadonlyMap<SymbolId, SymbolRecord>,
  components: readonly TechnicalComponent[],
): { dispositions: Map<string, PrimaryDisposition>; counts: DispositionCounts } {
  const behavioural = new Set<string>();
  const infrastructural = new Set<string>();

  for (const trace of traces) {
    for (const step of trace.steps) {
      const symbol = symbolsById.get(step.symbolId);
      if (!symbol) continue;
      const source = symbol.provenance.source;
      const path = qualifiedFile(source.rootName, source.relPath);
      if (looksInfrastructural(step.name)) infrastructural.add(path);
      else behavioural.add(path);
    }
  }

  const componentPaths = new Set(
    components.flatMap((component) =>
      component.memberPaths.map((member) => qualifiedFile(component.rootName, member)),
    ),
  );
  const dispositions = new Map<string, PrimaryDisposition>();

  for (const file of allFiles) {
    // Order matters and is the whole point: each file lands in exactly one
    // bucket, so the counts can be summed without double-counting.
    if (behavioural.has(file)) dispositions.set(file, "behavioral-source");
    else if (infrastructural.has(file)) dispositions.set(file, "shared-infrastructure");
    else if (componentPaths.has(file)) dispositions.set(file, "technical-only");
    else dispositions.set(file, "unclassified");
  }

  const counts = {
    behavioralSource: 0,
    technicalOnly: 0,
    sharedInfrastructure: 0,
    unclassified: 0,
    total: dispositions.size,
  };
  for (const disposition of dispositions.values()) {
    if (disposition === "behavioral-source") counts.behavioralSource += 1;
    else if (disposition === "technical-only") counts.technicalOnly += 1;
    else if (disposition === "shared-infrastructure") counts.sharedInfrastructure += 1;
    else counts.unclassified += 1;
  }

  return { dispositions, counts };
}

export function formModel(
  traces: readonly Trace[],
  componentInput: ComponentInput,
  allFiles: readonly string[],
): FormationResult {
  const symbolsById = new Map(componentInput.symbols.map((symbol) => [symbol.id, symbol] as const));
  const components = formComponents(componentInput);
  const { modules, withoutResource } = formModules(traces);
  const { dispositions, counts } = assignDispositions(allFiles, traces, symbolsById, components);

  return { modules, withoutResource, components, dispositions, counts };
}
