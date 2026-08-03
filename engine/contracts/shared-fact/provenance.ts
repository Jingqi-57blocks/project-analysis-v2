/**
 * How a fact was established, where it was seen, and how much weight it carries.
 *
 * This is the shared-fact contract's canonical provenance: structural,
 * behavioural, diagnostic and coverage facts all cite evidence the same way, so
 * the vocabulary is defined once here and re-exported to the layers that
 * already used it. A fact with no provenance is one no report can honestly cite.
 */

/**
 * A location in analyzed source. Identified by root name rather than absolute
 * path, so a knowledge base stays comparable across machines and runs.
 */
export interface SourceRef {
  readonly rootName: string;
  readonly relPath: string;
  /** Null for whole-file facts, rather than faked as line 1. */
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly startColumn: number | null;
  readonly endColumn: number | null;
}

/**
 * How a fact was established. Closed, unlike the language-facing vocabularies
 * elsewhere: this describes our epistemology, so a new language never adds a
 * case.
 *
 * `unresolved` is load-bearing — a call whose target cannot be determined is a
 * fact about the codebase, not missing data. Dropping those would shrink the
 * graph exactly where the code is hardest to reason about.
 */
export type ResolutionClass = "declared" | "resolved" | "inferred" | "unresolved";

/**
 * Coarse deliberately. No provider can calibrate 0.72 against 0.68 in a way
 * that survives comparison between providers, and a number reads as more
 * authoritative than the judgement behind it.
 */
export type Confidence = "high" | "medium" | "low";

/**
 * A union rather than optional fields, so two invariants hold by construction:
 * a `declared` fact carries no confidence (which would blur *read* into
 * *guessed well*), and an `unresolved` one must give a reason (without which
 * it is indistinguishable from "not attempted").
 */
export type Provenance =
  | { readonly resolutionClass: "declared"; readonly source: SourceRef }
  | {
      readonly resolutionClass: "resolved";
      readonly source: SourceRef;
      readonly confidence: Confidence | null;
    }
  | {
      readonly resolutionClass: "inferred";
      readonly source: SourceRef;
      readonly confidence: Confidence;
    }
  | {
      readonly resolutionClass: "unresolved";
      readonly source: SourceRef;
      readonly unresolvedReason: string;
    };

export function fileRef(rootName: string, relPath: string): SourceRef {
  return { rootName, relPath, startLine: null, endLine: null, startColumn: null, endColumn: null };
}

export function lineRef(
  rootName: string,
  relPath: string,
  startLine: number,
  endLine: number = startLine,
): SourceRef {
  return { rootName, relPath, startLine, endLine, startColumn: null, endColumn: null };
}

/**
 * A location including its column, derived from a match offset.
 *
 * Text-scanning collectors must use this rather than `lineRef`: two facts on
 * one line are two facts, and a line-only reference makes them collide in any
 * identity built from location. That collision silently drops the second, with
 * no gap and no conflict recorded.
 */
export function offsetRef(
  rootName: string,
  relPath: string,
  content: string,
  index: number,
): SourceRef {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return {
    rootName,
    relPath,
    startLine: line,
    endLine: line,
    startColumn: index - lineStart + 1,
    endColumn: null,
  };
}

export function declared(source: SourceRef): Provenance {
  return { resolutionClass: "declared", source };
}

export function resolved(source: SourceRef, confidence: Confidence | null = null): Provenance {
  return { resolutionClass: "resolved", source, confidence };
}

export function inferred(source: SourceRef, confidence: Confidence): Provenance {
  return { resolutionClass: "inferred", source, confidence };
}

export function unresolved(source: SourceRef, unresolvedReason: string): Provenance {
  return { resolutionClass: "unresolved", source, unresolvedReason };
}

/**
 * Filter for consumers that must not repeat a guess as fact. Deliberately not
 * a confidence threshold: a high-confidence inference is still an inference.
 */
export function isDirectlyObserved(provenance: Provenance): boolean {
  return provenance.resolutionClass === "declared" || provenance.resolutionClass === "resolved";
}

/** Ordered weakest → strongest, the order a resolution may only move along. */
export const RESOLUTION_CLASSES: readonly ResolutionClass[] = [
  "unresolved",
  "inferred",
  "resolved",
  "declared",
];

const RESOLUTION_RANK: { readonly [K in ResolutionClass]: number } = {
  unresolved: 0,
  inferred: 1,
  resolved: 2,
  declared: 3,
};

/**
 * A fact may only keep or strengthen its resolution as more evidence arrives;
 * a direct observation is never downgraded back to a guess or to unresolved.
 * Same-class transitions are legal so re-observation is idempotent.
 */
export function isLegalResolutionTransition(from: ResolutionClass, to: ResolutionClass): boolean {
  return RESOLUTION_RANK[to] >= RESOLUTION_RANK[from];
}

export type ProvenanceValidation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function isSourceRef(value: unknown): value is SourceRef {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const nullableInt = (x: unknown) => x === null || (typeof x === "number" && Number.isInteger(x));
  return (
    typeof v.rootName === "string" &&
    typeof v.relPath === "string" &&
    nullableInt(v.startLine) &&
    nullableInt(v.endLine) &&
    nullableInt(v.startColumn) &&
    nullableInt(v.endColumn)
  );
}

const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low"];

/**
 * Runtime guard for deserialized provenance. Enforces at the boundary what the
 * union enforces at compile time, so confidence can never stand in for
 * resolution: a `declared` fact carrying a confidence, an `inferred` one
 * without, an `unresolved` one without a reason, and an object that supplies a
 * confidence but no resolution class are all rejected rather than coerced.
 */
export function validateProvenance(value: unknown): ProvenanceValidation {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "provenance must be an object" };
  }
  const v = value as Record<string, unknown>;
  const cls = v.resolutionClass;
  if (typeof cls !== "string" || !RESOLUTION_CLASSES.includes(cls as ResolutionClass)) {
    return { ok: false, reason: `resolutionClass must be one of ${RESOLUTION_CLASSES.join(", ")}` };
  }
  if (!isSourceRef(v.source)) {
    return { ok: false, reason: "provenance.source must be a SourceRef" };
  }
  const hasConfidence = "confidence" in v;
  const hasReason = "unresolvedReason" in v;
  switch (cls as ResolutionClass) {
    case "declared":
      if (hasConfidence) return { ok: false, reason: "a declared fact carries no confidence" };
      if (hasReason) return { ok: false, reason: "a declared fact carries no unresolvedReason" };
      return { ok: true };
    case "resolved":
      if (hasReason) return { ok: false, reason: "a resolved fact carries no unresolvedReason" };
      if (!(v.confidence === null || CONFIDENCES.includes(v.confidence as Confidence))) {
        return { ok: false, reason: "resolved confidence must be a Confidence or null" };
      }
      return { ok: true };
    case "inferred":
      if (hasReason) return { ok: false, reason: "an inferred fact carries no unresolvedReason" };
      if (!CONFIDENCES.includes(v.confidence as Confidence)) {
        return { ok: false, reason: "an inferred fact must state a confidence" };
      }
      return { ok: true };
    case "unresolved":
      if (hasConfidence) return { ok: false, reason: "an unresolved fact carries no confidence" };
      if (typeof v.unresolvedReason !== "string" || v.unresolvedReason.length === 0) {
        return { ok: false, reason: "an unresolved fact must give a reason" };
      }
      return { ok: true };
  }
}
