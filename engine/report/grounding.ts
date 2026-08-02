/**
 * The grounding validator (PI-21/22 step 2): the load-bearing, model-agnostic check
 * that authored prose rests strictly on a block's own cited facts, and cites them.
 *
 * The prose-authoring host injects a `ProseAuthor` (a model, in phase B) and hands
 * it a block's cited-fact digest; whatever prose comes back is checked here before
 * the block is accepted. This validator is purely lexical and deterministic. What it
 * guarantees is CITATION INTEGRITY and SENTENCE-LOCAL QUOTE INTEGRITY: every citation
 * resolves to an in-slice fact, and a value the prose quotes VERBATIM inside a
 * sentence that also cites a fact is actually carried by that cited fact. It does NOT
 * guarantee that every quoted value anywhere is correct — a quote moved into a
 * marker-free sentence is not hard-checked (it surfaces through the best-effort
 * uncited-sentence signal instead) — and it does NOT attempt semantic entailment
 * (whether the prose's meaning follows from the facts). Those are deferred to a
 * human/LLM reviewer, which is what the best-effort channel is for.
 *
 * Marker convention. The author cites each claim with a bracketed marker:
 *   - `[n]` — a 1-based index into the ordered digest, which is the resolver's
 *     stable fact-id order (the exact order `facts` is given in here);
 *   - `[factId]` — the raw fact id, also accepted;
 *   - a composite bracket — `[1, 2]`, `[1;2]`, `[1 2]` — is split on commas,
 *     semicolons and whitespace into its elements and each is resolved on its own.
 * An element that resolves to no in-slice fact is a foreign citation.
 *
 * Hard fails (ok=false):
 *   (a) foreign-citation — a citation element resolving to no in-slice fact;
 *   (b) value-mismatch — a token the prose quotes with a VERBATIM delimiter
 *       (guillemets «…», the digest's own value delimiter, or backticks `code`)
 *       inside a sentence that also carries a marker, whose text is absent from that
 *       sentence's cited fact(s) — matched against `stableStringify(value)` and the
 *       citation, normalized on whitespace and case, as a substring. Double- and
 *       single-quoted spans are ADVISORY, not hard-checked: a model uses those for
 *       emphasis or a term of art, not only for a claimed verbatim value;
 *   (c) no-citation — a block with ≥1 fact whose prose carries no resolvable marker.
 *
 * Best-effort (reported; only fails when `requireEveryFactualSentenceCited`):
 *   uncited factual sentences — a sentence with no marker that nonetheless carries a
 *   backticked span, a path-like token, a code identifier, or a bare number. This is
 *   the channel a reviewer reads; the host and the step-2 audit surface it.
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

function extractMarkers(sentence: string, knownFactIds: ReadonlySet<string>): Marker[] {
  const out: Marker[] = [];
  const re = /\[([^[\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence)) !== null) {
    const inner = m[1]!.trim();
    // Brackets are also ordinary source syntax (`rows[id]`, `[req.ID]`) and
    // Markdown link text. Only accept the citation grammar here: a known raw
    // id, numeric indexes/composites, or a raw-id-shaped token. Canonical fact
    // ids carry `|`; the hyphenated form keeps a hallucinated legacy id
    // detectable without treating a source indexing expression as a citation.
    const isKnown = knownFactIds.has(inner);
    const isNumeric = /^\d+(?:\s*[,;\s]\s*\d+)*$/.test(inner);
    const isRawId = inner.includes("|") || /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/i.test(inner);
    if (isKnown || isNumeric || isRawId) out.push({ token: m[0], inner });
  }
  return out;
}

/**
 * Verbatim-quoted spans — the only ones the value-mismatch HARD check reads:
 * guillemets («…», the digest's own value delimiter) and backticks (`code`). Double-
 * and single-quoted spans are deliberately excluded: a model uses them for emphasis
 * or a term of art, not only for a claimed verbatim value, so treating them as a
 * verbatim claim yields false hard fails. They remain advisory (best-effort only).
 */
function extractQuoted(sentence: string): string[] {
  const out: string[] = [];
  const patterns: readonly RegExp[] = [/«([^»]+)»/g, /`([^`]+)`/g];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(sentence)) !== null) out.push(m[1]!);
  }
  return out;
}

/** One in-slice fact for a citation element: a pure-digit 1-based digest index, or a raw fact id. */
function resolveElement(element: string, facts: readonly CitedFact[], byFactId: ReadonlyMap<string, CitedFact>): CitedFact | null {
  if (/^\d+$/.test(element)) {
    const n = Number(element);
    return n >= 1 && n <= facts.length ? facts[n - 1]! : null;
  }
  return byFactId.get(element) ?? null;
}

/**
 * Resolve one bracket to its grounded facts and its foreign elements. A raw fact id
 * is tried whole first (a fact id may itself contain separators), then the bracket is
 * split on commas/semicolons/whitespace so a composite citation like `[1, 2]` grounds
 * each element on its own; any element resolving to no in-slice fact is foreign.
 */
function resolveBracket(
  inner: string,
  facts: readonly CitedFact[],
  byFactId: ReadonlyMap<string, CitedFact>,
): { readonly grounded: readonly CitedFact[]; readonly foreign: readonly string[] } {
  const trimmed = inner.trim();
  // Whole-inner raw fact id first — never split a fact id that carries separators.
  const whole = byFactId.get(trimmed);
  if (whole !== undefined) return { grounded: [whole], foreign: [] };

  const elements = trimmed.split(/[,;\s]+/).filter((e) => e.length > 0);
  const grounded: CitedFact[] = [];
  const foreign: string[] = [];
  for (const element of elements) {
    const fact = resolveElement(element, facts, byFactId);
    if (fact !== null) grounded.push(fact);
    else foreign.push(`[${element}]`);
  }
  // A bracket that split to nothing (only separators) is itself a foreign citation.
  if (grounded.length === 0 && foreign.length === 0) return { grounded: [], foreign: [`[${trimmed}]`] };
  return { grounded, foreign };
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
  const knownFactIds = new Set(byFactId.keys());
  const haystackByFactId = new Map(facts.map((f) => [f.factId, factHaystack(f)] as const));

  const groundedFactIds = new Set<string>();
  const foreignCitations = new Set<string>();
  const valueMismatches: ValueMismatch[] = [];
  const uncitedFactualSentences: string[] = [];
  let anyResolvableMarker = false;

  for (const sentence of splitSentences(prose)) {
    const markers = extractMarkers(sentence, knownFactIds);
    const sentenceFacts: CitedFact[] = [];
    const markerTokens: string[] = [];

    for (const marker of markers) {
      markerTokens.push(marker.token);
      const { grounded, foreign } = resolveBracket(marker.inner, facts, byFactId);
      for (const fact of grounded) {
        groundedFactIds.add(fact.factId);
        sentenceFacts.push(fact);
        anyResolvableMarker = true;
      }
      for (const token of foreign) foreignCitations.add(token);
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
