/**
 * Where a structural fact came from, and how much weight it can carry.
 *
 * A fact with no provenance is one no report can honestly cite.
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
