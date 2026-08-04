import { describe, expect, it } from "vitest";

import { makeClaim, type Claim } from "../../engine/contracts/claim/index.js";
import {
  CLAIM_OVERLAP_THRESHOLD,
  FIRST_PROOFREAD_CHECKLIST,
  MINIMUM_TIER,
  TIER_EVIDENCE,
  measureStability,
  needsFirstProofread,
  validateProofread,
  type ProofreadRecord,
} from "../../engine/report/stability.js";

const claim = (ref: string): Claim =>
  makeClaim({ predicate: "table-written-by-multiple-services", subject: { type: "entity", ref }, factIds: ["f"] });

const run = (refs: readonly string[]) => refs.map(claim);

describe("the tier floor", () => {
  it("is a floor, with the evidence that makes it one", () => {
    expect(MINIMUM_TIER).toBe("sonnet");
    // The lowest tier did not produce a worse report; it produced an untrue one.
    expect(TIER_EVIDENCE.join(" ")).toContain("fabricated");
    expect(TIER_EVIDENCE).toHaveLength(3);
  });
});

describe("stability across runs", () => {
  it("is total when every run agrees", () => {
    const measurement = measureStability([run(["a", "b"]), run(["a", "b"]), run(["a", "b"])]);
    expect(measurement.lowest).toBe(1);
    expect(measurement.meets).toBe(true);
    expect(measurement.pairwise).toHaveLength(3);
  });

  it("reports the lowest pair, not only the mean", () => {
    // Two runs agreeing closely and a third going its own way is exactly the
    // case worth seeing, and a mean hides it.
    const measurement = measureStability([run(["a", "b", "c", "d"]), run(["a", "b", "c", "d"]), run(["x", "y"])]);
    expect(measurement.lowest).toBeLessThan(measurement.mean);
    expect(measurement.meets).toBe(false);
  });

  it("fails below the threshold", () => {
    const measurement = measureStability([run(["a", "b", "c", "d", "e"]), run(["a", "b", "c", "z", "y"])]);
    expect(measurement.lowest).toBeLessThan(CLAIM_OVERLAP_THRESHOLD);
    expect(measurement.meets).toBe(false);
  });

  it("passes when the margins move but the core does not", () => {
    const core = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const measurement = measureStability([run([...core, "x"]), run([...core, "x"]), run([...core, "x"])]);
    expect(measurement.meets).toBe(true);
  });

  it("treats a single run as trivially stable", () => {
    expect(measureStability([run(["a"])]).meets).toBe(true);
  });
});

describe("the first human reading", () => {
  const answers = FIRST_PROOFREAD_CHECKLIST.map((item) => ({ item, accepted: true }));
  const record: ProofreadRecord = {
    snapshotIdentity: "run-1",
    runId: "08-03_14-22_p",
    reviewer: "someone",
    at: "2026-08-03T06:22:00.000Z",
    answers,
  };

  it("asks about meaning, which is the part no audit reaches", () => {
    // The engine proves a citation exists and that the arithmetic holds. It
    // cannot tell whether the sentence built on those facts says something true
    // about the business, so that is what the reading has to cover.
    const text = FIRST_PROOFREAD_CHECKLIST.join(" ").toLowerCase();
    expect(FIRST_PROOFREAD_CHECKLIST.length).toBeGreaterThanOrEqual(6);
    expect(text).toContain("support that wording");
    expect(text).toContain("filler");
    // And not the mechanical checks the audit already owns.
    expect(text).not.toContain("factid");
    expect(text).not.toContain("denominator");
  });

  it("accepts a complete record", () => {
    const result = validateProofread(record);
    expect(result.ok ? [] : result.reasons).toEqual([]);
  });

  it("refuses a record that skips items", () => {
    expect(validateProofread({ ...record, answers: answers.slice(0, 3) }).ok).toBe(false);
  });

  it("refuses a rejection with no explanation", () => {
    const withSilentRejection = answers.map((answer, index) => (index === 2 ? { ...answer, accepted: false } : answer));
    const result = validateProofread({ ...record, answers: withSilentRejection });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toContain("no note");
  });

  it("accepts a rejection that says what was wrong", () => {
    const withNote = answers.map((answer, index) =>
      index === 2 ? { ...answer, accepted: false, note: "module names follow directories, not the business" } : answer,
    );
    expect(validateProofread({ ...record, answers: withNote }).ok).toBe(true);
  });

  it("requires the reading once per project, then relies on the audit", () => {
    expect(needsFirstProofread("run-1", [])).toBe(true);
    expect(needsFirstProofread("run-1", [record])).toBe(false);
    expect(needsFirstProofread("run-2", [record])).toBe(true);
  });
});
