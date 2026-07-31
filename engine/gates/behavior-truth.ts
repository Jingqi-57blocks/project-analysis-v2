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

/** A cited file, or any file under a cited directory (a path ending in "/"), matches. */
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
  // The category's lane follows its first kind's owner; behaviour categories are
  // homogeneous (a side-effect category maps only to side-effect kinds).
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

    const kinds = BEHAVIOR_LANE[item.category];
    if (kinds === undefined) {
      return { ...base, status: "unsupported" as const, detail: `category ${item.category} is outside the behaviour lane` };
    }

    const inRoot = item.evidence.filter((e) => e.root === indexedRoot);
    if (inRoot.length === 0) {
      return { ...base, status: "unresolved" as const, detail: `no evidence in the indexed root ${indexedRoot}` };
    }

    const hit = inRoot.some((e) => factAt(kinds, e.root, e.path));
    const cited = inRoot.map((e) => e.path).join(", ");
    if (item.expectedStatus === "absent") {
      // The item asserts the behaviour is NOT there; found means it is honestly absent.
      return { ...base, status: hit ? "not-found" : "found", detail: `${hit ? "unexpectedly present at" : "honestly absent at"} ${cited}` };
    }
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
