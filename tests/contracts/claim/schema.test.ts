import { describe, expect, it } from "vitest";

import {
  INVALID_CLAIM_EXAMPLES,
  VALID_CLAIM_EXAMPLES,
  claimId,
  claimSetDigest,
  claimSetOverlap,
  indexClaims,
  invalidatedClaims,
  makeClaim,
  qualifierConflicts,
  rollUp,
  validateClaim,
} from "../../../engine/contracts/claim/schema.js";

const multiWriter = (table: string, writers: readonly string[], factIds: readonly string[]) =>
  makeClaim({
    predicate: "table-written-by-multiple-services",
    subject: { type: "entity", ref: table },
    qualifiers: { writers },
    factIds,
  });

describe("claim identity", () => {
  it("is the predicate and the subject", () => {
    expect(claimId("table-written-by-multiple-services", { type: "entity", ref: "leave" })).toBe(
      "claim:table-written-by-multiple-services:entity:leave",
    );
  });

  it("does not change when the qualifiers change", () => {
    const a = multiWriter("leave", ["svc"], ["f1"]);
    const b = multiWriter("leave", ["svc", "svc-v2"], ["f1"]);
    expect(a.claimId).toBe(b.claimId);
  });

  it("does not change when the supporting facts change", () => {
    // The decisive property: 39% of structural record_keys embed a file line,
    // so identity taken from factIds would move on any unrelated edit.
    const a = multiWriter("leave", ["svc"], ["svc|cond|file.go|10|2"]);
    const b = multiWriter("leave", ["svc"], ["svc|cond|file.go|11|2"]);
    expect(a.claimId).toBe(b.claimId);
  });

  it("differs when the subject differs", () => {
    expect(multiWriter("leave", [], ["f"]).claimId).not.toBe(multiWriter("approve", [], ["f"]).claimId);
  });
});

describe("claim validity", () => {
  it("accepts the contract's own examples", () => {
    for (const example of VALID_CLAIM_EXAMPLES) {
      const result = validateClaim(example.claim);
      expect({ name: example.name, reasons: result.ok ? [] : result.reasons }).toEqual({
        name: example.name,
        reasons: [],
      });
    }
  });

  it("refuses each of the contract's counter-examples", () => {
    for (const example of INVALID_CLAIM_EXAMPLES) {
      expect({ why: example.why, ok: validateClaim(example.claim).ok }).toEqual({ why: example.why, ok: false });
    }
  });

  it("rejects a claim with no supporting facts", () => {
    const result = validateClaim(makeClaim({ predicate: "p", subject: { type: "entity", ref: "t" }, factIds: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toContain("no factIds");
  });

  it("rejects an aggregate dressed up as a claim", () => {
    const result = validateClaim(
      makeClaim({ predicate: "multi-writer-total", subject: { type: "workspace", ref: "." }, factIds: ["f"] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toContain("roll-up");
  });

  it("keeps invalid claims out of the index and reports why", () => {
    const good = multiWriter("leave", [], ["f"]);
    const bad = makeClaim({ predicate: "p", subject: { type: "entity", ref: "t" }, factIds: [] });
    const { byId, invalid } = indexClaims([good, bad]);
    expect([...byId.keys()]).toEqual([good.claimId]);
    expect(invalid).toHaveLength(1);
  });
});

describe("disagreement between reports", () => {
  it("lands two contradicting statements on one claim, where it can be seen", () => {
    // The archived trial's real disagreement: one report found the guard, the
    // other did not. Same predicate, same subject, opposite verdict.
    const overview = makeClaim({
      predicate: "rule-present",
      subject: { type: "rule-subject", ref: "client-delete-guard" },
      qualifiers: { verdict: "unconfirmed" },
      factIds: ["f1"],
    });
    const module = makeClaim({
      predicate: "rule-present",
      subject: { type: "rule-subject", ref: "client-delete-guard" },
      qualifiers: { verdict: "hit", at: "clientProj/service.go:526" },
      factIds: ["f2"],
    });
    expect(overview.claimId).toBe(module.claimId);
    const conflicts = qualifierConflicts([overview], [module]);
    expect(conflicts.map((c) => c.key)).toEqual(["at", "verdict"]);
  });

  it("reports nothing when the two agree", () => {
    const a = multiWriter("leave", ["svc", "svc-v2"], ["f1"]);
    const b = multiWriter("leave", ["svc-v2", "svc"].reverse(), ["f2"]);
    expect(qualifierConflicts([a], [b])).toEqual([]);
  });
});

describe("aggregates are roll-ups, not claims", () => {
  it("computes the count from the claim set", () => {
    const claims = [multiWriter("a", [], ["f1"]), multiWriter("b", [], ["f2"]), multiWriter("c", [], ["f3"])];
    const summary = rollUp(claims, "table-written-by-multiple-services");
    expect(summary.count).toBe(3);
    expect(summary.subjects.map((s) => s.ref)).toEqual(["a", "b", "c"]);
    expect(summary.factIds).toEqual(["f1", "f2", "f3"]);
  });

  it("cannot disagree with the module-level claims it is computed from", () => {
    const claims = [multiWriter("a", [], ["f1"]), multiWriter("b", [], ["f2"])];
    expect(rollUp(claims, "table-written-by-multiple-services").count).toBe(claims.length);
  });
});

describe("stability and invalidation", () => {
  it("measures overlap between two runs", () => {
    const a = [multiWriter("a", [], ["f"]), multiWriter("b", [], ["f"])];
    const b = [multiWriter("a", [], ["f"]), multiWriter("c", [], ["f"])];
    expect(claimSetOverlap(a, a)).toBe(1);
    expect(claimSetOverlap(a, b)).toBeCloseTo(1 / 3);
  });

  it("invalidates only the claims whose support disappeared", () => {
    const claims = [multiWriter("a", [], ["f1"]), multiWriter("b", [], ["f2"])];
    const before = new Set(["f1", "f2"]);
    const after = new Set(["f2"]);
    expect(invalidatedClaims(claims, before, after)).toEqual(["claim:table-written-by-multiple-services:entity:a"]);
  });

  it("digests a claim set independently of order", () => {
    const a = multiWriter("a", [], ["f"]);
    const b = multiWriter("b", [], ["f"]);
    expect(claimSetDigest([a, b])).toBe(claimSetDigest([b, a]));
  });

  it("changes the digest when a qualifier changes, though the identity does not", () => {
    const a = multiWriter("a", ["one"], ["f"]);
    const b = multiWriter("a", ["one", "two"], ["f"]);
    expect(a.claimId).toBe(b.claimId);
    expect(claimSetDigest([a])).not.toBe(claimSetDigest([b]));
  });
});
