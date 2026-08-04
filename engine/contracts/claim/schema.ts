/**
 * The Claim layer: language-independent conclusions between facts and prose.
 *
 * ```
 * Fact   deterministic, already identified in the store
 *   ↓
 * Claim  a readable conclusion the facts support — language-independent, persisted
 *   ↓
 * View   one claim expressed for one audience in one language
 * ```
 *
 * Introducing this once settles three problems at the same time: two reports
 * cannot contradict each other because they cite the same claim; a second language
 * is a second View over an unchanged claim set; and a code change invalidates
 * claims through their supporting facts, so regeneration can be incremental.
 *
 * **Identity is the predicate and the subject, and nothing else.** Not the
 * factIds: 39% of the store's structural records carry a file line inside their
 * `record_key`, so identity derived from them would change whenever unrelated
 * lines shift, and consistency and invalidation would both collapse. Not a
 * finished sentence either, or language independence does not hold. The full
 * verification is in docs/pi-110-claim-identity-verification.md.
 */

import { createHash } from "node:crypto";

export const CLAIM_CONTRACT_ID = "claim";
export const CLAIM_CONTRACT_VERSION = "1.0.0";

/**
 * What a claim is about. Never a line-anchored fact — those shift with unrelated
 * edits, which is exactly what identity must not do.
 */
export interface ClaimSubject {
  /** The kind of thing: `entity`, `route`, `module`, `role`, `workspace`, … */
  readonly type: string;
  /** Its stable reference within that type. */
  readonly ref: string;
}

/**
 * Variable content: counts, lists, verdicts. Deliberately outside the identity —
 * this is what lets two reports that disagree land on one claimId, so the
 * disagreement is detectable instead of invisible.
 */
export type ClaimQualifiers = Readonly<Record<string, unknown>>;

export interface Claim {
  readonly claimId: string;
  /** What is asserted, as a structured token — never a sentence. */
  readonly predicate: string;
  readonly subject: ClaimSubject;
  readonly qualifiers: ClaimQualifiers;
  /** Fact keys supporting it. A claim without these is invalid. */
  readonly factIds: readonly string[];
  /** Report targets that use it, as `audience:scope#section`. */
  readonly usedBy: readonly string[];
}

const TOKEN = /^[a-z][a-z0-9-]*$/;

/**
 * The identity of a claim.
 *
 * Deliberately total and deliberately narrow: the same conclusion about the same
 * thing gets the same id whatever else changed, in any language, from any report.
 */
export function claimId(predicate: string, subject: ClaimSubject): string {
  return `claim:${predicate}:${subject.type}:${subject.ref}`;
}

export function makeClaim(input: {
  readonly predicate: string;
  readonly subject: ClaimSubject;
  readonly qualifiers?: ClaimQualifiers;
  readonly factIds: readonly string[];
  readonly usedBy?: readonly string[];
}): Claim {
  return {
    claimId: claimId(input.predicate, input.subject),
    predicate: input.predicate,
    subject: input.subject,
    qualifiers: input.qualifiers ?? {},
    factIds: [...new Set(input.factIds)].sort(),
    usedBy: [...new Set(input.usedBy ?? [])].sort(),
  };
}

export type ClaimValidation = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

/** Words that mark an aggregate — a roll-up over a claim set, not a claim. */
const AGGREGATE_PREDICATE = /(^|-)(count|total|share|percentage|summary)(-|$)/;

export function validateClaim(claim: Claim): ClaimValidation {
  const reasons: string[] = [];
  if (!TOKEN.test(claim.predicate)) {
    reasons.push(`predicate must be a lowercase token, not a sentence: "${claim.predicate}"`);
  }
  if (AGGREGATE_PREDICATE.test(claim.predicate)) {
    reasons.push(
      `"${claim.predicate}" is an aggregate; a roll-up is computed from the claims sharing a predicate, never stored as its own claim`,
    );
  }
  if (!TOKEN.test(claim.subject.type)) reasons.push(`subject type must be a lowercase token: "${claim.subject.type}"`);
  if (claim.subject.ref.length === 0) reasons.push("subject ref is empty");
  if (claim.factIds.length === 0) {
    reasons.push("a claim with no factIds is invalid — that is the only thing separating it from a free sentence");
  }
  if (claim.claimId !== claimId(claim.predicate, claim.subject)) {
    reasons.push("claimId does not match its predicate and subject");
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/** A claim set indexed by identity, rejecting anything invalid. */
export function indexClaims(claims: readonly Claim[]): {
  readonly byId: ReadonlyMap<string, Claim>;
  readonly invalid: readonly { readonly claim: Claim; readonly reasons: readonly string[] }[];
} {
  const byId = new Map<string, Claim>();
  const invalid: { claim: Claim; reasons: readonly string[] }[] = [];
  for (const claim of claims) {
    const check = validateClaim(claim);
    if (!check.ok) {
      invalid.push({ claim, reasons: check.reasons });
      continue;
    }
    byId.set(claim.claimId, claim);
  }
  return { byId, invalid };
}

export interface QualifierConflict {
  readonly claimId: string;
  readonly key: string;
  readonly left: unknown;
  readonly right: unknown;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
      return Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return inner;
  });
}

/**
 * Where two reports say different things about the same claim.
 *
 * This is the whole point of keeping variable content out of the identity: a
 * disagreement lands on one id and shows up here, rather than becoming two
 * unrelated claims nobody can compare.
 */
export function qualifierConflicts(left: readonly Claim[], right: readonly Claim[]): readonly QualifierConflict[] {
  const conflicts: QualifierConflict[] = [];
  const rightById = new Map(right.map((claim) => [claim.claimId, claim]));
  for (const claim of left) {
    const other = rightById.get(claim.claimId);
    if (other === undefined) continue;
    const keys = new Set([...Object.keys(claim.qualifiers), ...Object.keys(other.qualifiers)]);
    for (const key of [...keys].sort()) {
      const a = claim.qualifiers[key];
      const b = other.qualifiers[key];
      if (stable(a) !== stable(b)) conflicts.push({ claimId: claim.claimId, key, left: a, right: b });
    }
  }
  return conflicts;
}

/**
 * The roll-up a report prints instead of an aggregate claim.
 *
 * The number is the cardinality of the claim set, so an overview stating "7" and
 * a module report naming one of the seven are structurally incapable of
 * disagreeing — the audit never has to decide whether they contradict.
 */
export function rollUp(claims: readonly Claim[], predicate: string): {
  readonly predicate: string;
  readonly count: number;
  readonly subjects: readonly ClaimSubject[];
  readonly factIds: readonly string[];
} {
  const matching = claims.filter((claim) => claim.predicate === predicate);
  return {
    predicate,
    count: matching.length,
    subjects: matching.map((claim) => claim.subject),
    factIds: [...new Set(matching.flatMap((claim) => claim.factIds))].sort(),
  };
}

/** Jaccard overlap of two claim sets — the stability measure replacing byte reproducibility. */
export function claimSetOverlap(left: readonly Claim[], right: readonly Claim[]): number {
  const a = new Set(left.map((claim) => claim.claimId));
  const b = new Set(right.map((claim) => claim.claimId));
  if (a.size === 0 && b.size === 0) return 1;
  const union = new Set([...a, ...b]);
  let shared = 0;
  for (const id of a) if (b.has(id)) shared += 1;
  return shared / union.size;
}

/**
 * Claims whose support changed between two snapshots.
 *
 * Because identity excludes factIds, a shifted line updates a claim's support
 * without changing what the claim is — so the result is genuinely "what changed",
 * not "everything below an edit".
 */
export function invalidatedClaims(
  claims: readonly Claim[],
  factIdsBefore: ReadonlySet<string>,
  factIdsAfter: ReadonlySet<string>,
): readonly string[] {
  const changed: string[] = [];
  for (const claim of claims) {
    const lost = claim.factIds.filter((id) => factIdsBefore.has(id) && !factIdsAfter.has(id));
    if (lost.length > 0) changed.push(claim.claimId);
  }
  return changed.sort();
}

/** Digest of a claim set, for recording what a run produced. */
export function claimSetDigest(claims: readonly Claim[]): string {
  const hash = createHash("sha256");
  for (const claim of [...claims].sort((a, b) => (a.claimId < b.claimId ? -1 : 1))) {
    hash.update(claim.claimId);
    hash.update("\0");
    hash.update(stable(claim.qualifiers));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Machine-checkable examples of what the contract accepts. */
export const VALID_CLAIM_EXAMPLES: readonly { readonly name: string; readonly claim: Claim }[] = [
  {
    name: "entity subject",
    claim: makeClaim({
      predicate: "table-written-by-multiple-services",
      subject: { type: "entity", ref: "example_table" },
      qualifiers: { writers: ["service-a", "service-b"] },
      factIds: ["derived:structural-finding:tables-written-by-several-services"],
    }),
  },
  {
    name: "workspace subject",
    claim: makeClaim({
      predicate: "no-inter-service-calls",
      subject: { type: "workspace", ref: "." },
      factIds: ["derived:health-signal:root-cycles"],
    }),
  },
];

/** …and of what it must refuse. */
export const INVALID_CLAIM_EXAMPLES: readonly { readonly why: string; readonly claim: Claim }[] = [
  {
    why: "no factIds",
    claim: makeClaim({ predicate: "table-shared", subject: { type: "entity", ref: "t" }, factIds: [] }),
  },
  {
    why: "predicate is a sentence",
    claim: makeClaim({
      predicate: "This table is written by two services",
      subject: { type: "entity", ref: "t" },
      factIds: ["f1"],
    }),
  },
  {
    why: "aggregate stored as a claim",
    claim: makeClaim({ predicate: "multi-writer-count", subject: { type: "workspace", ref: "." }, factIds: ["f1"] }),
  },
  {
    why: "claimId does not match its predicate and subject",
    claim: {
      claimId: "claim:something-else:entity:t",
      predicate: "table-shared",
      subject: { type: "entity", ref: "t" },
      qualifiers: {},
      factIds: ["f1"],
      usedBy: [],
    },
  },
];
