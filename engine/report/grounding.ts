/**
 * The grounding validator (PI-21/22 step 2): the load-bearing, model-agnostic check
 * that authored prose rests strictly on a block's own cited facts, and cites them.
 *
 * The prose-authoring host injects a `ProseAuthor` (a model, in phase B) and hands
 * it a block's cited-fact digest; whatever prose comes back is checked here before
 * the block is accepted. This validator is purely lexical and deterministic — it
 * proves the prose CITES the facts and does not QUOTE a value the cited fact does
 * not carry. It does NOT attempt semantic entailment (whether the prose's meaning
 * follows from the facts) — that judgement is deferred to a human/LLM reviewer.
 *
 * Marker convention. The author cites each claim with a bracketed marker:
 *   - `[n]` — a 1-based index into the ordered digest, which is the resolver's
 *     stable fact-id order (the exact order `facts` is given in here);
 *   - `[factId]` — the raw fact id, also accepted.
 * A marker that resolves to no in-slice fact is a foreign citation.
 *
 * Hard fails (ok=false):
 *   (a) foreign-citation — a marker resolving to no in-slice fact;
 *   (b) value-mismatch — a token the prose quotes (guillemets/backticks/double
 *       quotes) inside a sentence that also carries a marker, whose text is absent
 *       from that sentence's cited fact(s) — matched against `stableStringify(value)`
 *       and the citation, normalized on whitespace and case, as a substring;
 *   (c) no-citation — a block with ≥1 fact whose prose carries no resolvable marker.
 *
 * Best-effort (reported; only fails when `requireEveryFactualSentenceCited`):
 *   uncited factual sentences — a sentence with no marker that nonetheless carries a
 *   backticked span, a path-like token, a code identifier, or a bare number.
 *
 * Pure, no I/O: the same prose and facts give the same result on every run, and
 * `groundedFactIds` is sorted so the grounded set is reproducible.
 */

import { stableStringify } from "../contracts/shared-fact/merge.js";
import type { CitedFact } from "./slice-resolve.js";
import { citationLabel } from "./author-prompt.js";

export type UngroundedKind = "no-citation" | "foreign-citation" | "value-mismatch" | "uncited-factual-sentence";

/** One reason the prose is not grounded — the rejection detail a retry/gap loop reads. */
export interface UngroundedClaim {
  readonly kind: UngroundedKind;
  readonly detail: string;
}

/** A quoted token that carries a citation marker but is absent from that fact's value/citation. */
export interface ValueMismatch {
  readonly quoted: string;
  readonly marker: string;
}

export interface GroundingResult {
  readonly ok: boolean;
  /** In-slice fact ids the prose actually cited, sorted — reproducible. */
  readonly groundedFactIds: readonly string[];
  /** Markers (`[...]`) resolving to no in-slice fact, sorted unique. */
  readonly foreignCitations: readonly string[];
  readonly valueMismatches: readonly ValueMismatch[];
  /** Sentences with a factual signal but no citation marker — best-effort. */
  readonly uncitedFactualSentences: readonly string[];
  /** Every claim that fails (or, for uncited sentences, would fail) grounding. */
  readonly ungrounded: readonly UngroundedClaim[];
}

export interface GroundingOptions {
  /** Promote uncited factual sentences from best-effort to a hard fail. Default false. */
  readonly requireEveryFactualSentenceCited?: boolean;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The admissible evidence for a fact: its stringified value, its citation label and
 * path, and its own id. A quoted token grounds if it is a normalized substring of
 * this haystack — deliberately lenient, so a value-mismatch hard-fail fires only on
 * a token the cited fact genuinely does not carry.
 */
function factHaystack(fact: CitedFact): string {
  const path = `${fact.citation.rootName}/${fact.citation.relPath}`;
  return normalize([stableStringify(fact.value), citationLabel(fact.citation), path, fact.factId].join("  "));
}

/** Split prose into sentences: newlines are boundaries, then `.!?` followed by space. */
function splitSentences(prose: string): string[] {
  return prose
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface Marker {
  /** The whole bracket, e.g. `[3]` or `[behavioral|…]` — what a foreign citation reports. */
  readonly token: string;
  readonly inner: string;
}

function extractMarkers(sentence: string): Marker[] {
  const out: Marker[] = [];
  const re = /\[([^[\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence)) !== null) out.push({ token: m[0], inner: m[1]! });
  return out;
}

/** Quoted spans: guillemets, backticks, and straight/curly double quotes. Single quotes are
 *  excluded — an apostrophe would make them unreliable, and value-mismatch is a hard fail. */
function extractQuoted(sentence: string): string[] {
  const out: string[] = [];
  const patterns: readonly RegExp[] = [/«([^»]+)»/g, /`([^`]+)`/g, /"([^"]+)"/g, /“([^”]+)”/g];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(sentence)) !== null) out.push(m[1]!);
  }
  return out;
}

/** Resolve a marker to an in-slice fact: `[n]` by 1-based digest index, else by raw fact id. */
function resolveMarker(inner: string, facts: readonly CitedFact[], byFactId: ReadonlyMap<string, CitedFact>): CitedFact | null {
  const trimmed = inner.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n >= 1 && n <= facts.length ? facts[n - 1]! : null;
  }
  return byFactId.get(trimmed) ?? null;
}

/**
 * Whether a sentence carries a factual signal a citation would be expected to back —
 * a backticked span, a path-like or file token, a code identifier, a bare number, or
 * a mid-sentence capitalized identifier. Heuristic and deliberately best-effort.
 */
function hasFactualSignal(sentence: string): boolean {
  if (/`[^`]+`/.test(sentence)) return true;
  if (/[\w.-]+\/[\w.-]+/.test(sentence)) return true;
  if (/\b[\w-]+\.(?:go|ts|tsx|js|jsx|py|java|rb|sql|json|ya?ml|kt|cs|php|rs|c|cpp|h)\b/.test(sentence)) return true;
  if (/\b\d+\b/.test(sentence)) return true;
  if (/[A-Za-z]_[A-Za-z]/.test(sentence)) return true; // snake_case
  if (/\b[a-z]+[A-Z][A-Za-z]*\b/.test(sentence)) return true; // camelCase
  if (/\b[A-Z]{2,}\b/.test(sentence)) return true; // ALL_CAPS / acronym
  const words = sentence.split(/\s+/);
  for (let i = 1; i < words.length; i += 1) {
    if (/^[A-Z][A-Za-z0-9]{2,}/.test(words[i]!)) return true; // proper-noun-ish, not sentence-initial
  }
  return false;
}

/**
 * Validate that `prose` is grounded in `facts` (the block's own ordered slice). Hard
 * fails on a foreign citation, a value-mismatch, or a citeable block with no
 * resolvable marker; reports uncited factual sentences, failing on them only when
 * asked. Deterministic; `groundedFactIds` is sorted.
 */
export function validateGrounding(
  prose: string,
  facts: readonly CitedFact[],
  options: GroundingOptions = {},
): GroundingResult {
  const byFactId = new Map(facts.map((f) => [f.factId, f] as const));
  const haystackByFactId = new Map(facts.map((f) => [f.factId, factHaystack(f)] as const));

  const groundedFactIds = new Set<string>();
  const foreignCitations = new Set<string>();
  const valueMismatches: ValueMismatch[] = [];
  const uncitedFactualSentences: string[] = [];
  let anyResolvableMarker = false;

  for (const sentence of splitSentences(prose)) {
    const markers = extractMarkers(sentence);
    const sentenceFacts: CitedFact[] = [];
    const markerTokens: string[] = [];

    for (const marker of markers) {
      markerTokens.push(marker.token);
      const fact = resolveMarker(marker.inner, facts, byFactId);
      if (fact === null) {
        foreignCitations.add(marker.token);
      } else {
        groundedFactIds.add(fact.factId);
        sentenceFacts.push(fact);
        anyResolvableMarker = true;
      }
    }

    // A quoted token only draws a value-mismatch when its sentence actually cites a
    // fact — the author claimed grounding, so the quote must be in the cited fact.
    if (sentenceFacts.length > 0) {
      for (const quoted of extractQuoted(sentence)) {
        const needle = normalize(quoted);
        const grounded = needle.length === 0 || sentenceFacts.some((f) => haystackByFactId.get(f.factId)!.includes(needle));
        if (!grounded) valueMismatches.push({ quoted, marker: markerTokens[0]! });
      }
    }

    // A sentence with no marker at all but a factual signal is an uncited claim.
    if (markers.length === 0 && hasFactualSignal(sentence)) uncitedFactualSentences.push(sentence);
  }

  const ungrounded: UngroundedClaim[] = [];
  if (facts.length > 0 && !anyResolvableMarker) {
    ungrounded.push({
      kind: "no-citation",
      detail: `block has ${facts.length} cited fact(s) but the prose carries no resolvable citation marker`,
    });
  }
  for (const token of [...foreignCitations].sort()) {
    ungrounded.push({ kind: "foreign-citation", detail: `citation ${token} resolves to no in-slice fact` });
  }
  for (const vm of valueMismatches) {
    ungrounded.push({
      kind: "value-mismatch",
      detail: `quoted «${vm.quoted}» under ${vm.marker} is absent from the cited fact's value/citation`,
    });
  }
  if (options.requireEveryFactualSentenceCited) {
    for (const sentence of uncitedFactualSentences) {
      ungrounded.push({ kind: "uncited-factual-sentence", detail: `factual sentence carries no citation: ${sentence}` });
    }
  }

  return {
    ok: ungrounded.length === 0,
    groundedFactIds: [...groundedFactIds].sort(),
    foreignCitations: [...foreignCitations].sort(),
    valueMismatches,
    uncitedFactualSentences,
    ungrounded,
  };
}
