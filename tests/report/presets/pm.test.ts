import { describe, expect, it } from "vitest";

import { sectionById } from "../../../engine/contracts/report/catalog.js";
import {
  PM_AUTHORED_BLOCKS,
  PM_QUESTIONS,
  PROJECT_BUSINESS_PATHS_BLOCK,
  PROJECT_CROSS_MODULE_RULES_BLOCK,
  pmPresetSections,
  validatePmPreset,
} from "../../../engine/report/presets/pm.js";

describe("validatePmPreset", () => {
  it("is complete and consistent — questions, sections, blocks and contracts all resolve", () => {
    expect(validatePmPreset()).toEqual({ ok: true });
  });
});

describe("PM questions map to real sections", () => {
  it("every required product-manager question names a catalog section", () => {
    expect(PM_QUESTIONS.length).toBeGreaterThan(0);
    for (const q of PM_QUESTIONS) {
      expect(sectionById(q.sectionId), `${q.id} → ${q.sectionId}`).toBeDefined();
    }
  });

  it("covers the shared, project and module domains", () => {
    const scopes = new Set(PM_QUESTIONS.map((q) => q.scope));
    expect(scopes.has("shared")).toBe(true);
    expect(scopes.has("project")).toBe(true);
    expect(scopes.has("module")).toBe(true);
  });
});

describe("every authored block in the PM preset has a contract", () => {
  it("no authored-required block in the project or module product sections is uncovered", () => {
    const contractIds = new Set(PM_AUTHORED_BLOCKS.map((b) => b.blockId));
    const sections = [...pmPresetSections("project"), ...pmPresetSections("module")];
    const authored = sections.flatMap((s) => s.blocks).filter((b) => b.kind === "authored-required");
    expect(authored.length).toBeGreaterThan(0);
    for (const block of authored) {
      expect(contractIds.has(block.id), `authored block ${block.id}`).toBe(true);
    }
  });

  it("adds the two project-scope authored blocks that complete the set, matching the catalog", () => {
    const paths = sectionById("project-roles-flows")!.blocks.find((b) => b.id === "project-roles-flows.paths")!;
    const rules = sectionById("project-objects-lifecycle")!.blocks.find((b) => b.id === "project-objects-lifecycle.rules")!;
    expect(PROJECT_BUSINESS_PATHS_BLOCK.outputSchemaId).toBe(paths.outputSchemaId);
    expect(PROJECT_CROSS_MODULE_RULES_BLOCK.outputSchemaId).toBe(rules.outputSchemaId);
  });
});

describe("scope variants share facts but not project/module structure", () => {
  it("both scopes include the shared sections", () => {
    const project = pmPresetSections("project").map((s) => s.id);
    const module = pmPresetSections("module").map((s) => s.id);
    for (const shared of ["identity", "fact-ledger", "coverage", "known-issues"]) {
      expect(project).toContain(shared);
      expect(module).toContain(shared);
    }
  });

  it("project sections are not in the module preset, and vice versa", () => {
    const project = pmPresetSections("project").map((s) => s.id);
    const module = pmPresetSections("module").map((s) => s.id);
    expect(project).toContain("project-boundary");
    expect(module).not.toContain("project-boundary");
    expect(module).toContain("module-responsibility");
    expect(project).not.toContain("module-responsibility");
  });
});

describe("PM authored blocks require citations", () => {
  it("every contract requires a citation and names its validator", () => {
    for (const block of PM_AUTHORED_BLOCKS) {
      expect(block.citationRule).toBe("required");
      expect(block.validatorId).toBe(block.outputSchemaId);
      expect(block.prompt.length).toBeGreaterThan(0);
    }
  });
});
