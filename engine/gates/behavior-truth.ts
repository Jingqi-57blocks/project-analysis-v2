/**
 * The WCP-V2 behaviour truth gate (PI-67).
 *
 * Grades the facet=M2 truth items against a derived behaviour model: for each
 * item, whether a behaviour fact of the kind its category implies was found at
 * the cited location, or is honestly not-found / unresolved / unsupported. The
 * behaviour lane covers PI-11's decision/rule/state/permission/validation/
 * exception/test facts and PI-12's side-effect facts (DB/transaction/HTTP/
 * message/notification); a `role` or `object` item belongs to the structural /
 * datamodel lanes and is marked unsupported with that attribution, not silently
 * failed. Every item lands in exactly one mutually-exclusive bucket and the total
 * is conserved. The golden-slice hard gate passes only when every behaviour-lane
 * must-find is found, no critical item is unfound, and PI-11/PI-12 ownership is
 * disjoint.
 *
 * It grades a model, not source: the integrated WCP-V2 behaviour model is PI-13's
 * to assemble and feed here.
 */

import type { TruthItem } from "../contracts/truth/schema.js";
import type { BehaviorFact, BehaviorModel } from "../contracts/behavior/schema.js";
import { ownerOf, validateOwnership } from "../contracts/behavior/schema.js";
import type { TestCoverage } from "../kb/test-derive.js";

export type TruthStatus = "found" | "not-found" | "unresolved" | "unsupported" | "failed" | "truncated";

/** Behaviour category → the fact kinds that would satisfy it. */
const BEHAVIOR_LANE: Readonly<Record<string, readonly string[]>> = {
  "state-set": ["state"],
  transition: ["transition"],
  rule: ["business-rule", "condition"],
  balance: ["business-rule", "condition"],
  "approval-routing": ["decision", "transition", "condition"],
  concurrency: ["transaction-boundary", "guard", "condition"],
  permission: ["auth-annotation"],
  validation: ["validation-rule"],
  exception: ["error-handling", "discarded-error"],
  activation: ["condition", "guard"],
  "test-relation": ["test-relation"],
  // PI-12 side effects
  notification: ["notification-call"],
  "side-effect": ["data-access", "outbound-call", "transaction-boundary"],
  integration: ["outbound-call"],
};

/** Categories another lane owns — graded where they live, not here. */
const OTHER_LANE: Readonly<Record<string, string>> = {
  role: "the structural role lane (PI-65)",
  object: "the datamodel/entity lane",
};

/** Every behaviour-lane kind — the set an absence assertion checks against. */
const ALL_BEHAVIOR_KINDS: readonly string[] = [...new Set(Object.values(BEHAVIOR_LANE).flat())];

export interface TruthItemResult {
  readonly truthId: string;
  readonly category: string;
  readonly criticality: string;
  readonly mustFind: boolean;
  /** Which side of the PI-11/PI-12 split the category sits on, when in-lane. */
  readonly lane: "behavior-semantics" | "side-effect" | "other";
  readonly status: TruthStatus;
  readonly detail: string;
}

export interface BehaviorGateReport {
  readonly indexedRoot: string;
  readonly total: number;
  readonly results: readonly TruthItemResult[];
  readonly counts: Readonly<Record<TruthStatus, number>>;
  readonly mustFindTotal: number;
  readonly mustFindFound: number;
  readonly criticalIssues: number;
  /** The in-scope behaviour denominator: items actually checked (found + not-found). */
  readonly denominator: number;
  /** False if the PI-11/PI-12 ownership partition is not disjoint — a hard fail. */
  readonly ownershipDisjoint: boolean;
  readonly passed: boolean;
}

/**
 * A cited file, or any file under a cited directory (a path ending in "/"), matches.
 * Matching is file-granular, like PI-65; narrowing an absence check to the cited
 * line range lands with PI-13's real model, where facts carry lines to compare.
 */
function pathMatches(cited: string, actual: string): boolean {
  if (cited === actual) return true;
  const prefix = cited.endsWith("/") ? cited : `${cited}/`;
  return actual.startsWith(prefix);
}

/** The (root, relPath) locations a fact is cited at, from its evidence. */
function locationsOf(fact: BehaviorFact): readonly { root: string; relPath: string }[] {
  return fact.evidence.map((e) => ({ root: e.provenance.source.rootName, relPath: e.provenance.source.relPath }));
}

function laneOf(category: string): "behavior-semantics" | "side-effect" | "other" {
  const kinds = BEHAVIOR_LANE[category];
  if (kinds === undefined) return "other";
  // A display tag only — it never feeds the pass. It follows the first mapped
  // kind's owner (a category may mix kinds; the found-check considers all of them).
  const owner = ownerOf(kinds[0]!);
  return owner === "side-effect" ? "side-effect" : "behavior-semantics";
}

/**
 * Grade the M2 truth items against a behaviour model for one indexed root. An item
 * whose category is out of the behaviour lane is unsupported (attributed); one with
 * no evidence in this root is unresolved; otherwise it is found when a fact of an
 * expected kind sits at a cited path — inverted for an item that asserts absence.
 */
export function gradeBehaviorTruth(
  items: readonly TruthItem[],
  model: BehaviorModel,
  indexedRoot: string,
  testCoverage: TestCoverage = "not-run",
): BehaviorGateReport {
  // Index every fact's (kind → locations) once.
  const locsByKind = new Map<string, { root: string; relPath: string }[]>();
  for (const fact of model.facts) {
    const list = locsByKind.get(fact.kind) ?? [];
    for (const loc of locationsOf(fact)) list.push(loc);
    locsByKind.set(fact.kind, list);
  }

  const factAt = (kinds: readonly string[], citedRoot: string, citedPath: string): boolean =>
    kinds.some((kind) =>
      (locsByKind.get(kind) ?? []).some((loc) => loc.root === citedRoot && pathMatches(citedPath, loc.relPath)),
    );

  const results: TruthItemResult[] = items.map((item) => {
    const lane = laneOf(item.category);
    const base = { truthId: item.id, category: item.category, criticality: item.criticality, mustFind: item.mustFind, lane };

    const other = OTHER_LANE[item.category];
    if (other !== undefined) return { ...base, status: "unsupported" as const, detail: `owned by ${other}` };

    const inRoot = item.evidence.filter((e) => e.root === indexedRoot);
    if (inRoot.length === 0) {
      return { ...base, status: "unresolved" as const, detail: `no evidence in the indexed root ${indexedRoot}` };
    }
    const cited = inRoot.map((e) => e.path).join(", ");

    // An absence assertion checks that no behaviour fact of the relevant kind sits
    // at the cited path; found means it is honestly absent. Handled before the
    // category lane so a category whose only point is the absence (e.g. `absent`) is
    // graded rather than dropped as "outside the lane". Kind-scoped when the category
    // is in-lane (a test-relation absence checks only for test-relation facts); the
    // broad `absent` category falls back to every behaviour kind, as before.
    if (item.expectedStatus === "absent") {
      const laneKinds = BEHAVIOR_LANE[item.category];
      const kinds = laneKinds ?? ALL_BEHAVIOR_KINDS;
      const present = inRoot.some((e) => factAt(kinds, e.root, e.path));
      // A test-relation absence is only trustworthy when the reader actually ran:
      // an empty result it never produced would otherwise read as honest absence.
      // Every other absence is confirmable from the model alone (the broad `absent`
      // fallback included), so it keeps grading exactly as before.
      const confirmable =
        laneKinds !== undefined && laneKinds.includes("test-relation") ? testCoverage === "covered" : true;
      const status = !present && confirmable ? ("found" as const) : ("not-found" as const);
      const detail = !confirmable
        ? `reader not-run — absence not confirmable at ${cited}`
        : `${present ? "unexpectedly present at" : "honestly absent at"} ${cited}`;
      return { ...base, status, detail };
    }

    const kinds = BEHAVIOR_LANE[item.category];
    if (kinds === undefined) {
      return { ...base, status: "unsupported" as const, detail: `category ${item.category} is outside the behaviour lane` };
    }
    const hit = inRoot.some((e) => factAt(kinds, e.root, e.path));
    return { ...base, status: hit ? "found" : "not-found", detail: `${hit ? `${kinds.join("/")} at` : `no ${kinds.join("/")} at`} ${cited}` };
  });

  const counts: Record<TruthStatus, number> = { found: 0, "not-found": 0, unresolved: 0, unsupported: 0, failed: 0, truncated: 0 };
  for (const r of results) counts[r.status] += 1;

  const inScope = results.filter((r) => r.status === "found" || r.status === "not-found");
  const mustFind = inScope.filter((r) => r.mustFind);
  const mustFindFound = mustFind.filter((r) => r.status === "found").length;
  const criticalIssues = inScope.filter((r) => r.criticality === "critical" && r.status !== "found").length;
  const ownershipDisjoint = validateOwnership().ok;

  return {
    indexedRoot,
    total: results.length,
    results,
    counts,
    mustFindTotal: mustFind.length,
    mustFindFound,
    criticalIssues,
    denominator: inScope.length,
    ownershipDisjoint,
    passed: ownershipDisjoint && mustFindFound === mustFind.length && criticalIssues === 0,
  };
}
