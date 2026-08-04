/**
 * The pre-generation gate.
 *
 * Runs before any model is called. When the pack cannot support the report the
 * spec asks for, generation is refused and the gap is named. It is a pass-or-stop
 * decision, never a choice of degraded path: a report that quietly omits a chapter
 * reads exactly like one that had nothing to say about it, and the reader has no
 * way to tell which happened.
 */

import { isLineAnchored } from "../contracts/kb/read-contract.js";
import { emptyKinds, type FactPack } from "./fact-pack.js";

export type BlockerCode =
  | "scope-unclear"
  | "indistinguishable-products"
  | "conflicting-facts"
  | "module-unresolved"
  | "coverage-insufficient"
  | "subject-not-addressable";

export interface Blocker {
  readonly code: BlockerCode;
  /** What is missing, in terms the caller can act on. */
  readonly detail: string;
}

export type GateVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly blockers: readonly Blocker[] };

export interface GateInput {
  readonly pack: FactPack;
  /**
   * Kinds without which the spec's mandatory chapters cannot be written. A
   * subset of the spec's `requires`; the rest may legitimately be empty.
   */
  readonly mandatoryKinds: readonly string[];
  /** Distinct products the analysis could not tell apart, if any. */
  readonly indistinguishableProducts?: readonly string[];
  /** Facts the store recorded in conflict with each other. */
  readonly conflicts?: readonly string[];
}

/**
 * Kinds that can only ever anchor supporting evidence, never a claim's subject.
 * A spec whose mandatory chapter rests solely on these has nothing stable to
 * attach its conclusions to — see docs/pi-110-claim-identity-verification.md.
 */
function mandatoryKindsWithNoStableSubject(input: GateInput): readonly string[] {
  const nonEmpty = new Set(input.pack.rows.map((row) => row.kind));
  return input.mandatoryKinds
    .filter((kind) => nonEmpty.has(kind))
    .filter((kind) => isLineAnchored(kind))
    .filter((kind) => !input.pack.subjects.some((subject) => subject.type === kind))
    .sort();
}

export function evaluateGate(input: GateInput): GateVerdict {
  const blockers: Blocker[] = [];
  const { pack } = input;

  if (pack.scope.length === 0) {
    blockers.push({ code: "scope-unclear", detail: "the request names no scope" });
  }
  if (pack.scope !== "project" && pack.kbModuleId === null) {
    blockers.push({
      code: "module-unresolved",
      detail: `module "${pack.moduleId ?? ""}" did not resolve to a knowledge-base module; generation stops rather than widening to the whole project`,
    });
  }
  for (const product of input.indistinguishableProducts ?? []) {
    blockers.push({
      code: "indistinguishable-products",
      detail: `the analysis could not separate "${product}" from the rest of the workspace`,
    });
  }
  for (const conflict of input.conflicts ?? []) {
    blockers.push({ code: "conflicting-facts", detail: conflict });
  }

  const missing = emptyKinds(pack).filter((kind) => input.mandatoryKinds.includes(kind));
  for (const kind of missing) {
    blockers.push({
      code: "coverage-insufficient",
      detail: `no "${kind}" facts in scope, and the spec's mandatory chapters need them`,
    });
  }
  for (const kind of mandatoryKindsWithNoStableSubject(input)) {
    blockers.push({
      code: "subject-not-addressable",
      detail: `"${kind}" facts are line-anchored and none carry a stable subject, so their conclusions cannot be given a claim identity`,
    });
  }

  return blockers.length === 0 ? { ok: true } : { ok: false, blockers };
}

/** A one-screen explanation of why generation stopped. */
export function explainVerdict(verdict: GateVerdict): string {
  if (verdict.ok) return "gate passed";
  const lines = verdict.blockers.map((blocker) => `  - [${blocker.code}] ${blocker.detail}`);
  return [`generation refused; ${verdict.blockers.length} blocker(s):`, ...lines].join("\n");
}
