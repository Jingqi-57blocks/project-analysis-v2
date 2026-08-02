import { describe, expect, it } from "vitest";

import type { CitedFact } from "../../engine/report/slice-resolve.js";
import { validateGrounding } from "../../engine/report/grounding.js";

/** A cited fact with a value and a real citation, in the resolver's shape. */
function fact(factId: string, value: unknown, relPath = "handlers/leave/service.go", startLine = 1): CitedFact {
  return {
    factId,
    kind: "data-access",
    value,
    citation: { rootName: "r1", relPath, startLine, endLine: startLine, startColumn: null, endColumn: null },
    resolutionClass: "declared",
  };
}

const FACTS: readonly CitedFact[] = [
  fact("behavioral|data-access|r1|handlers/leave/service.go:42|d1", { table: "wcp_leave" }, "handlers/leave/service.go", 42),
  fact("behavioral|condition|r1|handlers/leave/service.go:7|c1", { branch: "if balance < requested" }, "handlers/leave/service.go", 7),
];

describe("validateGrounding — grounded prose passes, its grounded set is sorted and in-slice", () => {
  it("accepts prose that cites each fact by its [n] index", () => {
    const prose = "The leave table is read [1]. A balance branch guards the request [2].";
    const result = validateGrounding(prose, FACTS);
    expect(result.ok).toBe(true);
    expect(result.groundedFactIds).toEqual(
      [...FACTS.map((f) => f.factId)].sort(),
    );
    expect(result.foreignCitations).toEqual([]);
    expect(result.valueMismatches).toEqual([]);
    expect(result.ungrounded).toEqual([]);
  });

  it("accepts a raw [factId] marker", () => {
    const prose = `The leave table is read [${FACTS[0]!.factId}].`;
    const result = validateGrounding(prose, FACTS);
    expect(result.ok).toBe(true);
    expect(result.groundedFactIds).toEqual([FACTS[0]!.factId]);
  });

  it("accepts a quoted value that the cited fact carries verbatim", () => {
    const prose = "The table `wcp_leave` is read [1].";
    const result = validateGrounding(prose, FACTS);
    expect(result.ok).toBe(true);
    expect(result.valueMismatches).toEqual([]);
  });
});

describe("validateGrounding — hard fails", () => {
  it("(a) foreign citation: a marker resolving to no in-slice fact", () => {
    const out = validateGrounding("A claim cites nothing real [99].", FACTS);
    expect(out.ok).toBe(false);
    expect(out.foreignCitations).toEqual(["[99]"]);
    expect(out.ungrounded.some((c) => c.kind === "foreign-citation")).toBe(true);
  });

  it("(a) foreign citation: an unknown raw factId", () => {
    const out = validateGrounding("A claim [not-a-real-fact-id].", FACTS);
    expect(out.ok).toBe(false);
    expect(out.foreignCitations).toEqual(["[not-a-real-fact-id]"]);
  });

  it("(b) value-mismatch: a quoted token under a marker absent from the cited fact", () => {
    const out = validateGrounding("The table `wcp_payroll` is read [1].", FACTS);
    expect(out.ok).toBe(false);
    expect(out.valueMismatches).toEqual([{ quoted: "wcp_payroll", marker: "[1]" }]);
    expect(out.ungrounded.some((c) => c.kind === "value-mismatch")).toBe(true);
  });

  it("(c) no-citation: a block with facts whose prose carries no resolvable marker", () => {
    const out = validateGrounding("The module reads and writes things, generally.", FACTS);
    expect(out.ok).toBe(false);
    expect(out.groundedFactIds).toEqual([]);
    expect(out.ungrounded.some((c) => c.kind === "no-citation")).toBe(true);
  });
});

describe("validateGrounding — best-effort uncited factual sentences", () => {
  it("reports an uncited factual sentence but does not fail by default", () => {
    // First sentence is cited; the second names a path with no marker.
    const prose = "The leave table is read [1]. The file handlers/leave/service.go is central.";
    const out = validateGrounding(prose, FACTS);
    expect(out.ok).toBe(true); // best-effort: reported, not failed
    expect(out.uncitedFactualSentences.length).toBe(1);
    expect(out.uncitedFactualSentences[0]).toContain("handlers/leave/service.go");
  });

  it("fails on an uncited factual sentence when requireEveryFactualSentenceCited", () => {
    const prose = "The leave table is read [1]. The file handlers/leave/service.go is central.";
    const out = validateGrounding(prose, FACTS, { requireEveryFactualSentenceCited: true });
    expect(out.ok).toBe(false);
    expect(out.ungrounded.some((c) => c.kind === "uncited-factual-sentence")).toBe(true);
  });

  it("does not flag a plain, marker-free, signal-free sentence", () => {
    const prose = "The leave table is read [1]. This section describes the observed behaviour.";
    const out = validateGrounding(prose, FACTS, { requireEveryFactualSentenceCited: true });
    expect(out.ok).toBe(true);
    expect(out.uncitedFactualSentences).toEqual([]);
  });
});

describe("validateGrounding — determinism and edge cases", () => {
  it("is deterministic and returns a sorted grounded set regardless of citation order", () => {
    const prose = "Second [2]. First [1]. Second again [2].";
    const a = validateGrounding(prose, FACTS);
    const b = validateGrounding(prose, FACTS);
    expect(a).toEqual(b);
    expect(a.groundedFactIds).toEqual([...a.groundedFactIds].sort());
    expect(a.groundedFactIds.length).toBe(2); // deduped
  });

  it("an empty-fact slice with marker-free prose is trivially ok", () => {
    const out = validateGrounding("Nothing to ground here.", []);
    expect(out.ok).toBe(true);
    expect(out.groundedFactIds).toEqual([]);
  });
});
