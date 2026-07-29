/**
 * Derives product features from the domain vocabulary a codebase already uses.
 *
 * Grouping entry points by their first path segment failed on real projects:
 * without framework route prefixes that segment is an action — `add`,
 * `approve`, `404` — so it produced hundreds of one-endpoint "features".
 * Falling back to one module per service was true but useless: a service is a
 * deployment unit, not something a reader recognises as a capability.
 *
 * The domain vocabulary is a better signal because a team names its tables,
 * routes and directories after the things the product actually does.
 * `wcp_leave`, `wcp_leave_detail` and `wcp_leave_change_log` are three tables
 * describing one feature, and the feature's name is sitting right there.
 *
 * A term has to appear in more than one kind of place to count. One table
 * whose name nobody else uses is a table, not a feature.
 */

import { createHash } from "node:crypto";

import type { RouteRecord, OutboundCallRecord, AuthAnnotationRecord, DataAccessRecord } from "../structural/boundaries.js";
import type { ValidationRuleRecord, TransactionBoundaryRecord, ErrorHandlingRecord } from "../structural/rules.js";

/**
 * The prefix a project puts on its own table names, derived from the names.
 *
 * A list of known prefixes would be a list of the projects we happened to test
 * on — `wcp_` means nothing anywhere else, and the next codebase names its
 * tables something we never guessed. A prefix is instead whatever leading
 * token most of a project's tables share: a word that appears at the front of
 * nearly every table is a namespace, not a domain term, whatever it spells.
 *
 * Requires a clear majority and more than a couple of tables, so a project
 * with two tables that happen to start alike keeps both terms.
 */
export function commonTablePrefix(entityNames: readonly string[]): string | null {
  if (entityNames.length < 4) return null;

  const leading = new Map<string, number>();
  for (const name of entityNames) {
    const match = /^([a-z0-9]+[_-])/i.exec(name);
    if (match === null) continue;
    const prefix = match[1]!.toLowerCase();
    leading.set(prefix, (leading.get(prefix) ?? 0) + 1);
  }

  for (const [prefix, count] of leading) {
    if (count / entityNames.length >= 0.6) return prefix;
  }
  return null;
}

/**
 * Words that appear everywhere and describe nothing.
 *
 * Without this the strongest "feature" in any project is `api`, `list` or
 * `id` — terms that group everything and therefore separate nothing.
 */
const STOPWORDS = new Set([
  "api", "apis", "v1", "v2", "v3", "internal", "public", "private", "src", "app", "apps",
  "index", "main", "common", "core", "shared", "util", "utils", "helper", "helpers",
  "lib", "libs", "pkg", "config", "configs", "test", "tests", "spec", "mock", "mocks",
  "get", "post", "put", "patch", "delete", "list", "add", "new", "edit", "update",
  "create", "remove", "save", "load", "fetch", "find", "search", "query", "detail",
  "details", "info", "data", "item", "items", "id", "ids", "all", "any", "one",
  "page", "pages", "view", "views", "component", "components", "handler", "handlers",
  "service", "services", "controller", "controllers", "model", "models", "route",
  "routes", "router", "store", "stores", "type", "types", "const", "constant",
  "error", "errors", "log", "logs", "debug", "response", "request", "req", "res",
  "table", "tables", "column", "record", "records", "entry", "entries", "well",
  "known", "swagger", "docs", "doc", "assets", "static", "public", "build", "dist",
  "node", "modules", "vendor", "deploy", "migrations", "seeders", "middleware",
  "middlewares", "auth", "login", "logout", "token", "session", "user", "users",
  // Interface vocabulary. A front end names hundreds of files after the widget
  // they draw, and every one of those words would otherwise outrank a feature
  // by sheer file count.
  "modal", "dialog", "button", "layout", "hook", "hooks", "form", "forms", "field",
  "fields", "input", "select", "picker", "wrapper", "provider", "providers",
  "context", "container", "widget", "icon", "icons", "style", "styles", "theme",
  "css", "img", "image", "images", "font", "fonts", "svg", "menu", "tab", "tabs",
  "modals", "popup", "tooltip", "banner", "card", "cards", "panel", "outlet",
  // Words that describe a shape of request rather than a capability.
  "self", "single", "batch", "bulk", "general", "summary", "information",
  "personal", "admin", "confirm", "setting", "settings", "result", "results",
  "return", "reset", "last", "first", "current", "default", "active", "count",
  "total", "status", "statuses", "date", "dates", "time", "code", "codes",
  "export", "import", "upload", "download", "file", "files", "name", "names",
]);

/**
 * How much evidence a term needs before it names a feature.
 *
 * Two kinds of evidence keep out a term that is only a table or only a
 * directory, but they let through a word that happens to appear twice — `last`
 * names two endpoints and two files and is not a capability. Weighting an
 * entity above an endpoint reflects that a team creates a table when a thing
 * is real, while an endpoint can be one action on someone else's thing.
 */
const ENTITY_WEIGHT = 3;
const MINIMUM_WEIGHT = 8;

/** Roughly singular, enough to make `leaves` and `leave` the same term. */
function singular(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("hes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

/** Splits an identifier into lowercase words, whatever convention it uses. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 2 && !/^\d+$/.test(part));
}

/** The domain term an entity name points at, with its table prefix removed. */
export function entityTerm(entityName: string, prefix: string | null = null): string | null {
  let name = entityName.toLowerCase();
  if (prefix !== null && name.startsWith(prefix)) name = name.slice(prefix.length);
  const parts = words(name).map(singular).filter((word) => !STOPWORDS.has(word));
  return parts[0] ?? null;
}

export interface FeatureEvidence {
  readonly entities: readonly string[];
  readonly routePaths: readonly string[];
  readonly directories: readonly string[];
}

export interface DomainFeature {
  readonly id: string;
  /** entities × 3 + endpoints — how much of the product this accounts for. */
  readonly weight: number;
  readonly term: string;
  /** Human-facing name — the term, capitalized. */
  readonly name: string;
  readonly entities: readonly string[];
  readonly routes: readonly RouteRecord[];
  readonly filePaths: readonly string[];
  readonly rootNames: readonly string[];
  /** Which kinds of evidence named this term. A feature needs at least two. */
  readonly signals: readonly string[];
}

export interface FeatureDetection {
  readonly features: readonly DomainFeature[];
  /**
   * Terms that named something in two places but not enough of it. Reported
   * rather than dropped: "nothing else was found" and "more was found and set
   * aside" are different statements about a project.
   */
  readonly setAside: readonly { readonly term: string; readonly signals: readonly string[] }[];
}

export interface FeatureInput {
  readonly entityNames: readonly string[];
  readonly routes: readonly RouteRecord[];
  /** Analyzed file paths, qualified as `root/relPath`. */
  readonly files: readonly { readonly rootName: string; readonly relPath: string }[];
}

function stableId(term: string): string {
  return `feat_${createHash("sha256").update(term).digest("hex").slice(0, 12)}`;
}

/**
 * Finds the terms worth calling features.
 *
 * Scored by where a term appears rather than how often: a term naming a table
 * *and* a route is a capability, while a term appearing fifty times in one
 * directory is a folder.
 */
export function detectFeatures(input: FeatureInput): FeatureDetection {
  const prefix = commonTablePrefix(input.entityNames);
  const entityTerms = new Map<string, Set<string>>();
  for (const name of input.entityNames) {
    const term = entityTerm(name, prefix);
    if (!term) continue;
    const existing = entityTerms.get(term) ?? new Set<string>();
    existing.add(name);
    entityTerms.set(term, existing);
  }

  const routeTerms = new Map<string, RouteRecord[]>();
  for (const route of input.routes) {
    const seen = new Set<string>();
    for (const word of words(route.path).map(singular)) {
      if (STOPWORDS.has(word) || seen.has(word)) continue;
      seen.add(word);
      const existing = routeTerms.get(word) ?? [];
      existing.push(route);
      routeTerms.set(word, existing);
    }
  }

  const directoryTerms = new Map<string, Set<string>>();
  for (const file of input.files) {
    const segments = file.relPath.split("/").slice(0, -1);
    for (const word of segments.flatMap(words).map(singular)) {
      if (STOPWORDS.has(word)) continue;
      const existing = directoryTerms.get(word) ?? new Set<string>();
      existing.add(`${file.rootName}/${file.relPath}`);
      directoryTerms.set(word, existing);
    }
  }

  const candidates = new Set([...entityTerms.keys(), ...routeTerms.keys(), ...directoryTerms.keys()]);
  const features: DomainFeature[] = [];
  const setAside: { term: string; signals: readonly string[] }[] = [];

  for (const term of candidates) {
    const entities = [...(entityTerms.get(term) ?? [])].sort();
    const routes = routeTerms.get(term) ?? [];
    const filePaths = [...(directoryTerms.get(term) ?? [])].sort();

    const signals: string[] = [];
    if (entities.length > 0) signals.push(`${entities.length} data entities`);
    if (routes.length > 0) signals.push(`${routes.length} endpoints`);
    if (filePaths.length > 0) signals.push(`${filePaths.length} files`);

    // Two independent kinds of evidence. A term naming only a table is a
    // table; a term naming only a directory is a directory.
    if (signals.length < 2) continue;

    const weight = entities.length * ENTITY_WEIGHT + routes.length;
    if (weight < MINIMUM_WEIGHT) {
      setAside.push({ term, signals });
      continue;
    }

    const rootNames = [
      ...new Set([...routes.map((r) => r.rootName), ...filePaths.map((p) => p.split("/")[0]!)]),
    ].sort();

    features.push({
      id: stableId(term),
      weight,
      term,
      name: term.charAt(0).toUpperCase() + term.slice(1).replace(/_/g, " "),
      entities,
      routes,
      filePaths,
      rootNames,
      signals,
    });
  }

  // Ranked by how much of the product they account for, so a reader meets the
  // substantial features first rather than alphabetically.
  return {
    features: features.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term)),
    setAside: setAside.sort((a, b) => a.term.localeCompare(b.term)),
  };
}

/**
 * The feature a route belongs to: the one whose term its path names, most
 * substantial first.
 *
 * A path can name two features — `/v2/leaves/:id/approve` is Leave, not
 * Approval — so the heaviest match wins, and a path naming none returns null
 * rather than being forced somewhere.
 */
export function featureForRoute(
  route: RouteRecord,
  features: readonly DomainFeature[],
): DomainFeature | null {
  const terms = new Set(words(route.path).map(singular));
  let best: DomainFeature | null = null;
  for (const feature of features) {
    if (!terms.has(feature.term)) continue;
    if (best === null || feature.weight > best.weight) best = feature;
  }
  return best;
}

export interface FeatureConditions {
  readonly validations: readonly ValidationRuleRecord[];
  readonly authChecks: readonly AuthAnnotationRecord[];
  readonly transactions: readonly TransactionBoundaryRecord[];
  readonly errorHandling: readonly ErrorHandlingRecord[];
  readonly dataAccess: readonly DataAccessRecord[];
  readonly outbound: readonly OutboundCallRecord[];
}

/**
 * The rules and effects recorded in a feature's own files.
 *
 * Matched by file rather than by symbol, because no provider links a route to
 * its handler yet. That is coarser than following the call graph and is the
 * honest maximum available — a condition in a feature's file is evidence about
 * that feature, even when the exact path to it is unknown.
 */
export function conditionsFor(
  feature: DomainFeature,
  all: FeatureConditions,
): FeatureConditions {
  const owned = new Set(feature.filePaths);
  const inFeature = (rootName: string, relPath: string): boolean =>
    owned.has(`${rootName}/${relPath}`);

  return {
    validations: all.validations.filter((r) => inFeature(r.rootName, r.source.relPath)),
    authChecks: all.authChecks.filter((r) => inFeature(r.rootName, r.source.relPath)),
    transactions: all.transactions.filter((r) => inFeature(r.rootName, r.source.relPath)),
    errorHandling: all.errorHandling.filter((r) => inFeature(r.rootName, r.source.relPath)),
    dataAccess: all.dataAccess.filter((r) =>
      inFeature(r.rootName, r.provenance.source.relPath),
    ),
    outbound: all.outbound.filter((r) => inFeature(r.rootName, r.provenance.source.relPath)),
  };
}
