import { describe, expect, it } from "vitest";

import { lineRef, type SourceRef } from "../../../engine/contracts/shared-fact/provenance.js";
import { SECTION_CATALOG } from "../../../engine/contracts/report/catalog.js";
import type { ProblemRecord } from "../../../engine/contracts/report/pipeline.js";
import {
  CHANGE_IMPACT_BLOCK,
  DEV_IMPL_AUTHORED_BLOCKS,
  IMPL_SCHEMA_BLOCKS,
  MODULE_CHANGE_IMPACT_BLOCK,
  type FragilityFinding,
  type GapFinding,
  type ImpactEdge,
  type TestRelationRecord,
  renderChangeImpact,
  renderFragility,
  renderGaps,
  renderProblemLedger,
  renderTestEvidence,
  validateChangeImpact,
  validateFragility,
  validateGaps,
  validateTestEvidence,
} from "../../../engine/report/content/impl-issues.js";

const ROOT = "wcp-service-v2";
const cite = (path: string, line = 1): SourceRef => lineRef(ROOT, path, line);

describe("renderTestEvidence — repository coverage, not a correctness proof", () => {
  it("measures coverage over the in-scope target denominator", () => {
    const relations: TestRelationRecord[] = [
      { id: "t:1", testSymbolId: "s:TestApprove", targetSymbolId: "s:Approve", relation: "covers", citation: cite("h_test.go", 8) },
    ];
    const evidence = renderTestEvidence(relations, ["s:Approve", "s:Submit", "s:Cancel"]);
    expect(evidence.targetCount).toBe(3);
    expect(evidence.coveredCount).toBe(1);
    expect(evidence.covered).toEqual(["s:Approve"]);
    expect(evidence.uncovered).toEqual(["s:Cancel", "s:Submit"]);
    expect(validateTestEvidence(evidence)).toEqual({ ok: true });
  });
});

describe("renderChangeImpact — bounded to the resolved graph", () => {
  const changed = ["s:A"];
  const edges: ImpactEdge[] = [
    { from: "s:A", to: "s:B", resolution: "resolved" },
    { from: "s:B", to: "s:C", resolution: "resolved" },
    { from: "s:C", to: "s:D", resolution: "unresolved" }, // boundary — not crossed
  ];

  it("reaches only over resolved edges and counts the unresolved boundary", () => {
    const impact = renderChangeImpact(changed, edges, true);
    expect(impact.reachable).toEqual(["s:B", "s:C"]); // D is behind an unresolved edge
    expect(impact.reachableCount).toBe(2);
    expect(impact.unresolvedBoundary).toBe(1); // counted separately, not followed
    expect(impact.truncated).toBe(true);
    expect(impact.reachable).not.toContain("s:D");
    expect(impact.reachable).not.toContain("s:A"); // the seed is not its own downstream
    expect(validateChangeImpact(impact)).toEqual({ ok: true });
  });
});

describe("renderFragility — evidenced, typed, no subjective ranking", () => {
  const findings: FragilityFinding[] = [
    { id: "f:1", kind: "weak-test-association", findingType: "observed", subject: "s:Approve", evidenceIds: ["diag:1"], scope: "module:leave", nonInferableBoundary: "does not imply the code is incorrect", citation: cite("h.go", 1) },
    { id: "f:2", kind: "unresolved-relation", findingType: "unknown", subject: "s:Notify", evidenceIds: ["edge:9"], scope: "module:leave", nonInferableBoundary: "the target may or may not exist", citation: cite("n.go", 2) },
  ];

  it("counts by kind and finding type, and cites evidence per finding", () => {
    const set = renderFragility(findings);
    expect(set.total).toBe(2);
    expect(set.byFindingType).toEqual({ observed: 1, "bounded-inference": 0, unknown: 1 });
    expect(validateFragility(set)).toEqual({ ok: true });
  });

  it("rejects a finding that cites no fact or states no boundary", () => {
    const noEvidence = renderFragility([{ ...findings[0]!, evidenceIds: [] }]);
    expect(validateFragility(noEvidence).ok).toBe(false);
    const noBoundary = renderFragility([{ ...findings[0]!, nonInferableBoundary: "" }]);
    expect(validateFragility(noBoundary).ok).toBe(false);
  });

  it("has no subjective severity, priority or remediation field", () => {
    const f = renderFragility(findings).findings[0]!;
    expect(f).not.toHaveProperty("severity");
    expect(f).not.toHaveProperty("priority");
    expect(f).not.toHaveProperty("remediation");
    // finding type is a claim class, never a ranking
    expect(["observed", "bounded-inference", "unknown"]).toContain(f.findingType);
  });
});

describe("renderGaps — scope, missing capability, next step", () => {
  it("requires each gap to name its scope, capability and next investigation step", () => {
    const gaps: GapFinding[] = [
      { id: "g:1", affectedScope: "module:payroll", missingCapability: "no route reader for this framework", nextStep: "add a provider or confirm no HTTP surface", citation: null },
    ];
    const set = renderGaps(gaps);
    expect(set.count).toBe(1);
    expect(validateGaps(set)).toEqual({ ok: true });
    const bad = renderGaps([{ ...gaps[0]!, nextStep: "" }]);
    expect(validateGaps(bad).ok).toBe(false);
  });
});

describe("problem ledger projection is the shared one, reused for the dev audience", () => {
  it("carries the same problem id as the product report (no re-mint)", () => {
    const problems: ProblemRecord[] = [
      { problemId: "p:abc123", scope: { kind: "project" }, category: "state-leak", resolution: "observed", confidence: "high", evidenceIds: ["diag:1"], citations: ["diag:1"], impactBoundary: "the leave flow" },
    ];
    const view = renderProblemLedger(problems);
    expect(view.problems[0]!.problemId).toBe("p:abc123"); // same id, same projection function as PI-45
  });
});

describe("blocks agree with the section catalog", () => {
  const catalogBlocks = new Map(SECTION_CATALOG.flatMap((s) => s.blocks).map((b) => [b.id, b.outputSchemaId]));

  it("every authored block matches its catalog block", () => {
    for (const block of DEV_IMPL_AUTHORED_BLOCKS) {
      expect(catalogBlocks.get(block.blockId)).toBe(block.outputSchemaId);
      expect(block.citationRule).toBe("required");
    }
    expect(CHANGE_IMPACT_BLOCK.blockId).toBe("project-impl-issues.impact");
    expect(MODULE_CHANGE_IMPACT_BLOCK.blockId).toBe("module-impl-issues.impact");
  });

  it("every deterministic renderer schema matches its catalog block", () => {
    for (const { blockId, outputSchemaId } of IMPL_SCHEMA_BLOCKS) {
      expect(catalogBlocks.get(blockId), blockId).toBe(outputSchemaId);
    }
  });
});
