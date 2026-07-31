import { describe, expect, it } from "vitest";

import { SECTION_CATALOG } from "../../../engine/contracts/report/catalog.js";
import {
  DOCUMENT_PRESETS,
  type DocumentPreset,
  MODULE_DEVELOPER_DETAIL,
  MODULE_PRODUCT_DETAIL,
  presetFor,
  resolveSections,
  validatePreset,
} from "../../../engine/contracts/report/presets.js";

describe("document presets", () => {
  it("has exactly one preset per scope x audience", () => {
    expect(DOCUMENT_PRESETS).toHaveLength(4);
    for (const scope of ["project", "module"] as const) {
      for (const audience of ["product", "developer"] as const) {
        expect(presetFor(scope, audience).scope).toBe(scope);
        expect(presetFor(scope, audience).audience).toBe(audience);
      }
    }
  });

  it("every preset validates and resolves to real sections", () => {
    for (const preset of DOCUMENT_PRESETS) {
      expect(validatePreset(preset).ok, preset.id).toBe(true);
      expect(resolveSections(preset).required.length).toBeGreaterThan(0);
    }
  });

  it("includes the shared-claim sections in every document, so shared claims keep one identity", () => {
    for (const preset of DOCUMENT_PRESETS) {
      expect(preset.requiredSectionIds, preset.id).toContain("fact-ledger");
      expect(preset.requiredSectionIds, preset.id).toContain("known-issues");
    }
  });

  it("does not repeat the project overview inside a module detail", () => {
    for (const preset of [MODULE_PRODUCT_DETAIL, MODULE_DEVELOPER_DETAIL]) {
      const { required, optional } = resolveSections(preset);
      for (const s of [...required, ...optional]) {
        expect(s.scope, `${preset.id} -> ${s.id}`).not.toBe("project");
      }
    }
  });

  it("rejects a preset that references a missing section", () => {
    const bad: DocumentPreset = {
      id: "bad",
      scope: "project",
      audience: "product",
      requiredSectionIds: ["does-not-exist"],
      optionalSectionIds: [],
    };
    expect(validatePreset(bad).ok).toBe(false);
    expect(() => resolveSections(bad)).toThrow();
  });
});

describe("section catalog", () => {
  it("has unique section ids", () => {
    const ids = SECTION_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only deterministic and authored-required blocks — no ai-optional", () => {
    for (const s of SECTION_CATALOG) {
      for (const b of s.blocks) {
        expect(["deterministic", "authored-required"], b.id).toContain(b.kind);
      }
    }
  });

  it("every block reads facts and names an output schema, so a document needs no source re-read", () => {
    for (const s of SECTION_CATALOG) {
      expect(s.blocks.length, s.id).toBeGreaterThan(0);
      for (const b of s.blocks) {
        expect(b.inputFactKinds.length, b.id).toBeGreaterThan(0);
        expect(b.outputSchemaId.length, b.id).toBeGreaterThan(0);
      }
    }
  });
});
