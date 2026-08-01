import { describe, expect, it } from "vitest";

import { lineRef, type SourceRef } from "../../../engine/contracts/shared-fact/provenance.js";
import { SECTION_CATALOG } from "../../../engine/contracts/report/catalog.js";
import type { ProblemRecord } from "../../../engine/contracts/report/pipeline.js";
import {
  KNOWN_ISSUES_IMPACT_BLOCK,
  MODULE_EFFECTS_NOTES_BLOCK,
  PM_EFFECTS_AUTHORED_BLOCKS,
  type CoverageInputRow,
  type EffectRecord,
  type OpenQuestion,
  renderCoverage,
  renderEffects,
  renderOpenQuestions,
  renderProblemLedger,
  validateCoverage,
  validateEffects,
  validateOpenQuestions,
  validateProblemLedger,
} from "../../../engine/report/content/effects.js";

const ROOT = "wcp-service-v2";
const cite = (path: string, line = 1): SourceRef => lineRef(ROOT, path, line);

const effects: EffectRecord[] = [
  { id: "e2", kind: "notification", target: "email", operation: "send", activation: "reachable", external: true, citation: cite("svc/notify.go", 10) },
  { id: "e1", kind: "outbound-call", target: "payments-api", operation: "POST /charge", activation: "declared-config", external: true, citation: cite("svc/pay.go", 5) },
  { id: "e3", kind: "data-access", target: "leaves", operation: "write", activation: "unconfirmed-production", external: false, citation: cite("svc/repo.go", 20) },
];

describe("renderEffects — declared config vs reachable vs unconfirmed", () => {
  it("counts by kind and activation, and marks external dependencies", () => {
    const set = renderEffects(effects);
    expect(set.total).toBe(3);
    expect(set.effects.map((e) => e.id)).toEqual(["e1", "e2", "e3"]); // sorted
    expect(set.counts).toEqual({ notification: 1, "outbound-call": 1, "data-access": 1 });
    expect(set.byActivation).toEqual({ "declared-config": 1, reachable: 1, "unconfirmed-production": 1 });
    expect(set.externalCount).toBe(2);
    expect(validateEffects(set)).toEqual({ ok: true });
  });

  it("keeps a declared-config integration distinct from an observed call", () => {
    const set = renderEffects(effects);
    const declared = set.effects.find((e) => e.id === "e1")!;
    const reachable = set.effects.find((e) => e.id === "e2")!;
    expect(declared.activation).toBe("declared-config"); // not claimed to actually fire
    expect(reachable.activation).toBe("reachable");
  });
});

describe("renderCoverage — every number traces to the denominator", () => {
  const rows: CoverageInputRow[] = [
    { dimension: "notifications", state: "found", reason: "" },
    { dimension: "integrations", state: "not-found", reason: "" },
    { dimension: "ui", state: "not-applicable", reason: "this is a backend service with no UI" },
    { dimension: "scheduler", state: "unknown", reason: "the scheduler provider did not run" },
    { dimension: "webhooks", state: "unsupported", reason: "no capability to detect webhooks here" },
  ];

  it("buckets each dimension exhaustively and excludes only not-applicable from the denominator", () => {
    const report = renderCoverage(rows);
    expect(report.denominator).toBe(4); // all but not-applicable
    expect(report.covered).toBe(1); // found
    expect(report.empty).toBe(1); // not-found
    expect(report.gaps).toBe(2); // unsupported (capability) + unknown (evidence)
    expect(report.failed).toBe(0);
    expect(report.truncated).toBe(0);
    expect(report.notApplicable).toBe(1);
    // exhaustive: every row counted once
    expect(report.covered + report.empty + report.gaps + report.failed + report.truncated + report.notApplicable).toBe(report.rows.length);
    expect(validateCoverage(report)).toEqual({ ok: true });
  });

  it("surfaces a broken or cut-off provider instead of a clean gaps:0", () => {
    const report = renderCoverage([
      { dimension: "found", state: "found", reason: "" },
      { dimension: "broke", state: "failed", reason: "the provider crashed" },
      { dimension: "cut", state: "truncated", reason: "the result was cut off" },
    ]);
    // the two broken rows are NOT rolled into a clean report
    expect(report.gaps).toBe(0);
    expect(report.failed).toBe(1);
    expect(report.truncated).toBe(1);
    expect(report.covered).toBe(1);
    // and they are in the denominator, so the headline is honest
    expect(report.denominator).toBe(3);
    expect(validateCoverage(report)).toEqual({ ok: true });
  });

  it("rejects an unknown/not-applicable row with no reason", () => {
    const report = renderCoverage([{ dimension: "x", state: "unknown", reason: "" }]);
    expect(validateCoverage(report).ok).toBe(false);
  });

  it("rejects a report whose headline count drifts from its rows", () => {
    const report = renderCoverage(rows);
    const tampered = { ...report, covered: report.covered + 5 };
    expect(validateCoverage(tampered).ok).toBe(false);
  });
});

const problems: ProblemRecord[] = [
  {
    problemId: "abc123def456",
    scope: { kind: "project" },
    category: "state-leak",
    resolution: "observed",
    confidence: "high",
    evidenceIds: ["diag:1", "diag:2"],
    citations: ["diag:1"],
    impactBoundary: "the leave approval flow",
  },
];

describe("renderProblemLedger — the shared ledger, reused not re-minted", () => {
  it("passes through the same problem id and required fields", () => {
    const view = renderProblemLedger(problems);
    expect(view.count).toBe(1);
    const p = view.problems[0]!;
    expect(p.problemId).toBe("abc123def456"); // same id, not a new one
    expect(p.scope).toBe("project");
    expect(p.resolution).toBe("observed");
    expect(p.evidenceIds).toEqual(["diag:1", "diag:2"]);
    expect(p.impactBoundary).toBe("the leave approval flow");
    expect(validateProblemLedger(view, problems)).toEqual({ ok: true });
  });

  it("rejects a problem id that is not from the shared ledger", () => {
    const foreign = { ...renderProblemLedger(problems).problems[0]!, problemId: "not-a-real-id" };
    const view = { problems: [foreign], count: 1 };
    expect(validateProblemLedger(view, problems).ok).toBe(false);
  });

  it("rejects a view that keeps the id but alters a field from the ledger", () => {
    // a real id but a fabricated impact boundary must not pass
    const tampered = { ...renderProblemLedger(problems).problems[0]!, impactBoundary: "FABRICATED wider impact" };
    expect(validateProblemLedger({ problems: [tampered], count: 1 }, problems).ok).toBe(false);
  });

  it("carries no priority, remediation or roadmap field", () => {
    const p = renderProblemLedger(problems).problems[0]!;
    expect(p).not.toHaveProperty("priority");
    expect(p).not.toHaveProperty("remediation");
    expect(p).not.toHaveProperty("roadmap");
  });
});

describe("renderOpenQuestions — surfaced, not rewritten as requirements", () => {
  it("gives each question a code, affected scope and next investigation step", () => {
    const items: OpenQuestion[] = [
      { id: "q1", code: "unknown", affectedScope: "module:leave", nextStep: "run the scheduler provider" },
      { id: "q2", code: "unresolved", affectedScope: "project", nextStep: "confirm production activation" },
    ];
    const set = renderOpenQuestions(items);
    expect(set.count).toBe(2);
    expect(set.questions.map((q) => q.code)).toEqual(["unknown", "unresolved"]);
    for (const q of set.questions) {
      expect(q.affectedScope.length).toBeGreaterThan(0);
      expect(q.nextStep.length).toBeGreaterThan(0);
    }
    expect(validateOpenQuestions(set)).toEqual({ ok: true });
  });

  it("rejects an open question with no scope or next step", () => {
    const bad = renderOpenQuestions([{ id: "q1", code: "unknown", affectedScope: "", nextStep: "" }]);
    expect(validateOpenQuestions(bad).ok).toBe(false);
  });
});

describe("validateEffects — rejects an uncited or inconsistent effect", () => {
  it("rejects an effect with no citation", () => {
    const bad = renderEffects([{ ...effects[0]!, citation: lineRef("", "", 0) }]);
    expect(validateEffects(bad).ok).toBe(false);
  });
});

describe("authored blocks agree with the section catalog", () => {
  it("every authored block id and schema matches a catalog block", () => {
    const catalogBlocks = new Map(SECTION_CATALOG.flatMap((s) => s.blocks).map((b) => [b.id, b.outputSchemaId]));
    for (const block of PM_EFFECTS_AUTHORED_BLOCKS) {
      expect(catalogBlocks.get(block.blockId)).toBe(block.outputSchemaId);
      expect(block.citationRule).toBe("required");
      expect(block.validatorId).toBe(block.outputSchemaId);
    }
    expect(KNOWN_ISSUES_IMPACT_BLOCK.blockId).toBe("known-issues.impact");
    expect(MODULE_EFFECTS_NOTES_BLOCK.blockId).toBe("module-notifications-data.notes");
  });
});
