/**
 * Turns formed modules, technical components and observed external systems into a
 * bounded, evidence-bearing candidate list for classification (PI-79).
 *
 * This extends the existing module-formation path — it consumes a `FormationResult`
 * and boundary observations, it does not re-discover modules or mint a second id.
 * A candidate carries only what a bounded classifier needs to tell a product
 * module from a technical component from an external system: display-name options,
 * a member/entry/relation summary, the citable evidence refs, and why the
 * candidate was formed. Nothing here branches on a vendor, domain or target name;
 * an external system is a candidate because the code was seen to call out of the
 * project, whatever the callee is named.
 */

import { createHash } from "node:crypto";

import { joinKey } from "../structural/identity.js";
import type { ProductModule, TechnicalComponent } from "./form.js";
import type { ModuleCandidate } from "../contracts/module-classification/schema.js";

/** Keeps a candidate payload bounded: the count stays exact, the refs are capped. */
const MAX_REFS = 50;

/**
 * An external interaction the project was seen to make, aligned to a boundary
 * entity (PI-60). Supplied by the caller from shared KB/CodeGraph evidence — this
 * module does not reach into the graph, and it never decides externality from a
 * name.
 */
export interface ExternalSystemObservation {
  /** Stable key for the boundary entity — a host, a service id, a base identifier. */
  readonly key: string;
  readonly displayNameCandidates: readonly string[];
  /** The call targets/endpoints observed against it. */
  readonly targets: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly reason: string;
}

export interface CandidateInput {
  readonly modules: readonly ProductModule[];
  readonly components: readonly TechnicalComponent[];
  readonly externalSystems: readonly ExternalSystemObservation[];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Bounds the ref list while always keeping the candidate's own primary ref (the
 * module/component/boundary it *is*), which alphabetical capping could otherwise
 * slice off in favour of member refs. The primary leads; the rest are sorted.
 */
function capped(primary: string, rest: readonly string[]): readonly string[] {
  const others = sortedUnique(rest).filter((ref) => ref !== primary);
  return [primary, ...others].slice(0, MAX_REFS);
}

function externalCandidateId(key: string): string {
  return `ext_${createHash("sha256").update(joinKey(["external", key])).digest("hex").slice(0, 16)}`;
}

function moduleCandidate(module: ProductModule): ModuleCandidate {
  const entryRefs = module.entryKeys.map((k) => `fact:entry:${k}`);
  return {
    candidateId: module.id,
    displayNameCandidates: sortedUnique([module.name]),
    memberSummary: `${module.symbolIds.length} symbols across ${module.rootNames.length} root(s)`,
    entrySummary: sortedUnique([...module.entryKeys]),
    relationSummary: sortedUnique([...module.rootNames]),
    evidenceRefs: capped(`fact:module:${module.id}`, entryRefs),
    reason: `product traces grouped by ${module.groupingSignal}`,
  };
}

function componentCandidate(component: TechnicalComponent): ModuleCandidate {
  const memberRefs = component.memberPaths.map((p) => `fact:file:${joinKey([component.rootName, p])}`);
  return {
    candidateId: component.id,
    displayNameCandidates: sortedUnique([component.name]),
    memberSummary: `${component.memberPaths.length} file(s) in ${component.rootName}`,
    entrySummary: [],
    relationSummary: sortedUnique([component.rootName]),
    evidenceRefs: capped(`fact:component:${component.id}`, memberRefs),
    reason: `technical component identified by ${sortedUnique([...component.signals]).join(", ")}`,
  };
}

function externalCandidate(obs: ExternalSystemObservation): ModuleCandidate {
  return {
    candidateId: externalCandidateId(obs.key),
    displayNameCandidates: sortedUnique([...obs.displayNameCandidates]),
    memberSummary: `${obs.targets.length} outbound target(s)`,
    entrySummary: sortedUnique([...obs.targets]),
    relationSummary: [`boundary:${obs.key}`],
    evidenceRefs: capped(`fact:boundary:${obs.key}`, obs.evidenceRefs),
    reason: obs.reason,
  };
}

/**
 * The candidate list, deterministic and stable-ordered by id so the same snapshot
 * always digests to the same set. Every candidate carries at least its own primary
 * ref (the module/component/boundary it is), so a classifier can always ground it.
 */
export function generateModuleCandidates(input: CandidateInput): readonly ModuleCandidate[] {
  const candidates: ModuleCandidate[] = [
    ...input.modules.map(moduleCandidate),
    ...input.components.map(componentCandidate),
    ...input.externalSystems.map(externalCandidate),
  ];

  return candidates.sort((a, b) =>
    a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0,
  );
}
