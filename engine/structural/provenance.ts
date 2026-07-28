/**
 * Where a structural fact came from, and how much weight it can carry.
 *
 * Every record in the model points back at source and says how it was arrived
 * at. A fact with no provenance is a fact no report can honestly cite: the
 * difference between "this route is declared at line 40" and "something that
 * looked like a route was inferred" is the difference between a claim a reader
 * can check and one they have to trust.
 */

/**
 * A location in analyzed source.
 *
 * `rootName` rather than an absolute path: paths are machine-specific, and a
 * knowledge base that only makes sense on the machine that built it cannot be
 * shared or compared across runs.
 *
 * The line/column range is null for facts about a whole file — a language, a
 * manifest-level dependency — rather than being faked as line 1, which would
 * send a reader to a line that says nothing.
 */
export interface SourceRef {
  readonly rootName: string;
  readonly relPath: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly startColumn: number | null;
  readonly endColumn: number | null;
}

/**
 * How a fact was established. Closed on purpose: unlike symbol kinds or
 * package ecosystems, this describes *our* epistemology rather than any
 * language's vocabulary, so a new language never adds a case here.
 *
 * - `declared`   read verbatim from source or a manifest. Nothing was judged.
 * - `resolved`   followed a reference to a definite target — an import to the
 *                file it names, a call to the symbol it binds.
 * - `inferred`   arrived at heuristically. Requires a confidence, because a
 *                heuristic that cannot say how sure it is cannot be filtered.
 * - `unresolved` known to exist, target unknown. A dynamic URL, a reflective
 *                call, runtime dependency injection.
 *
 * `unresolved` is the load-bearing one. A call whose target cannot be
 * determined is a *fact about the codebase*, not missing data, and dropping it
 * would silently shrink the graph exactly where the code is hardest to reason
 * about — leaving the report most confident where it should be least.
 */
export type ResolutionClass = "declared" | "resolved" | "inferred" | "unresolved";

/**
 * Coarse on purpose. A float invites false precision: no provider can
 * calibrate 0.72 against 0.68 in a way that survives comparison between
 * providers, and a number reads as more authoritative than the judgement
 * behind it. Three levels are what a heuristic can actually justify, and are
 * enough to filter or rank on.
 */
export type Confidence = "high" | "medium" | "low";

/**
 * Provenance as a discriminated union, so invalid combinations cannot be
 * represented at all rather than being validated after the fact.
 *
 * Two invariants the shape enforces:
 *
 * A `declared` fact carries no confidence. Attaching "high" to something read
 * verbatim would blur the line between *read* and *guessed well*, which is the
 * distinction the whole model exists to keep.
 *
 * An `unresolved` fact must say why. "Unknown" without a reason is
 * indistinguishable from "not attempted", and the two need different responses
 * — one is a property of the code, the other a gap in the tool.
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

/** A location with no known line range — a whole-file or manifest-level fact. */
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
 * Whether a fact was established without judgement.
 *
 * Consumers that must not repeat a guess as fact — a report asserting a system
 * has exactly N endpoints — filter on this rather than on confidence, since
 * even a high-confidence inference is still an inference.
 */
export function isDirectlyObserved(provenance: Provenance): boolean {
  return provenance.resolutionClass === "declared" || provenance.resolutionClass === "resolved";
}
