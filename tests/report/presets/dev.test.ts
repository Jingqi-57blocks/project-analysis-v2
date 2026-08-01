import { describe, expect, it } from "vitest";

import { sectionById } from "../../../engine/contracts/report/catalog.js";
import type { SectionApplicabilityDecision } from "../../../engine/report/applicability.js";
import { KNOWN_ISSUES_IMPACT_BLOCK, PM_EFFECTS_AUTHORED_BLOCKS } from "../../../engine/report/content/effects.js";
import {
  DEV_AUTHORED_BLOCKS,
  DEV_QUESTIONS,
  devPresetSections,
  devQuestionCoverage,
  validateDevPreset,
} from "../../../engine/report/presets/dev.js";

describe("validateDevPreset", () => {
  it("is complete and consistent — questions, sections, blocks and contracts all resolve", () => {
    expect(validateDevPreset()).toEqual({ ok: true });
  });
});

describe("developer questions map to real sections", () => {
  it("every required developer question names a catalog section", () => {
    expect(DEV_QUESTIONS.length).toBeGreaterThan(0);
    for (const q of DEV_QUESTIONS) {
      expect(sectionById(q.sectionId), `${q.id} → ${q.sectionId}`).toBeDefined();
    }
  });

  it("covers the shared, project and module domains", () => {
    const scopes = new Set(DEV_QUESTIONS.map((q) => q.scope));
    expect(scopes.has("shared")).toBe(true);
    expect(scopes.has("project")).toBe(true);
    expect(scopes.has("module")).toBe(true);
  });
});

describe("every authored block in the developer preset has a contract", () => {
  it("no authored-required block in the project or module developer sections is uncovered", () => {
    const contractIds = new Set(DEV_AUTHORED_BLOCKS.map((b) => b.blockId));
    const sections = [...devPresetSections("project"), ...devPresetSections("module")];
    const authored = sections.flatMap((s) => s.blocks).filter((b) => b.kind === "authored-required");
    expect(authored.length).toBeGreaterThan(0);
    for (const block of authored) {
      expect(contractIds.has(block.id), `authored block ${block.id}`).toBe(true);
    }
  });

  it("the shared known-issues impact block is the same contract OBJECT the product report uses", () => {
    const impact = sectionById("known-issues")!.blocks.find((b) => b.id === "known-issues.impact")!;
    const contract = DEV_AUTHORED_BLOCKS.find((b) => b.blockId === "known-issues.impact")!;
    expect(contract.outputSchemaId).toBe(impact.outputSchemaId); // problem-impact.v1
    // object identity, not merely the same schema — a future re-minted copy would fail this
    expect(contract).toBe(KNOWN_ISSUES_IMPACT_BLOCK);
    expect(PM_EFFECTS_AUTHORED_BLOCKS).toContain(KNOWN_ISSUES_IMPACT_BLOCK); // one ledger across both audiences
  });

  it("has no duplicate contract block id (a duplicate could mask a fact-kind mismatch)", () => {
    const ids = DEV_AUTHORED_BLOCKS.map((b) => b.blockId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries no contract that the developer preset does not need", () => {
    const sectionBlockIds = new Set(
      [...devPresetSections("project"), ...devPresetSections("module")]
        .flatMap((s) => s.blocks)
        .filter((b) => b.kind === "authored-required")
        .map((b) => b.id),
    );
    for (const contract of DEV_AUTHORED_BLOCKS) {
      expect(sectionBlockIds.has(contract.blockId), `contract ${contract.blockId}`).toBe(true);
    }
  });
});

describe("every developer section answers a question (reverse coverage)", () => {
  it("no section in either developer preset is without a question", () => {
    const questionSections = new Set(DEV_QUESTIONS.map((q) => q.sectionId));
    const sections = new Set([...devPresetSections("project"), ...devPresetSections("module")].map((s) => s.id));
    for (const id of sections) expect(questionSections.has(id), `section ${id}`).toBe(true);
  });
});

describe("devQuestionCoverage — every question answered or a structured reason", () => {
  const decision = (sectionId: string, applicability: "included" | "not-applicable" | "unknown", reason: string): SectionApplicabilityDecision => ({
    sectionId,
    applicability,
    state: applicability === "included" ? "found" : applicability === "not-applicable" ? "not-applicable" : "unknown",
    reason,
    evidence: [],
  });

  it("maps each question to its section's applicability, defaulting to unknown", () => {
    const decisions = {
      "project-architecture": decision("project-architecture", "included", "found the module graph"),
      "project-ops-entrypoints": decision("project-ops-entrypoints", "not-applicable", "no build/test targets were evidenced"),
      // no decision for the rest → unknown with a stated reason
    };
    const coverage = devQuestionCoverage(decisions);
    expect(coverage.length).toBe(DEV_QUESTIONS.length);
    const byS = new Map(coverage.map((c) => [c.sectionId, c]));
    expect(byS.get("project-architecture")!.applicability).toBe("included");
    expect(byS.get("project-ops-entrypoints")!.applicability).toBe("not-applicable"); // not conflated with unknown
    const undecided = byS.get("identity")!;
    expect(undecided.applicability).toBe("unknown");
    expect(undecided.reason.length).toBeGreaterThan(0); // a stated reason, never silently answered
  });
});

describe("scope variants share facts but not project/module structure", () => {
  it("both scopes include the shared sections", () => {
    const project = devPresetSections("project").map((s) => s.id);
    const module = devPresetSections("module").map((s) => s.id);
    for (const shared of ["identity", "fact-ledger", "coverage", "known-issues"]) {
      expect(project).toContain(shared);
      expect(module).toContain(shared);
    }
  });

  it("project sections are not in the module preset, and vice versa", () => {
    const project = devPresetSections("project").map((s) => s.id);
    const module = devPresetSections("module").map((s) => s.id);
    expect(project).toContain("project-architecture");
    expect(module).not.toContain("project-architecture");
    expect(module).toContain("module-code-boundary");
    expect(project).not.toContain("module-code-boundary");
  });
});

describe("developer authored blocks require citations", () => {
  it("every contract requires a citation and names its validator", () => {
    for (const block of DEV_AUTHORED_BLOCKS) {
      expect(block.citationRule).toBe("required");
      expect(block.validatorId).toBe(block.outputSchemaId);
      expect(block.prompt.length).toBeGreaterThan(0);
    }
  });
});
