import { describe, expect, it } from "vitest";

import {
  REQUIRABLE_FACT_KINDS,
  allRequiredKinds,
  availableCombinations,
  loadSpecRegistry,
  specFor,
  validateSpecRegistry,
} from "../../../engine/contracts/report/specs.js";

const OPEN_SET_FIXTURE = new URL("./fixtures/specs-open-set/", import.meta.url);

describe("output spec registry", () => {
  const registry = loadSpecRegistry();

  it("loads exactly one shared writing contract, which is not a report type", () => {
    expect(registry.contract.id).toBe("contract");
    expect(registry.specs.map((s) => s.id)).not.toContain("contract");
  });

  it("validates", () => {
    const result = validateSpecRegistry(registry);
    expect(result.ok ? [] : result.reasons).toEqual([]);
  });

  it("every spec inherits the shared contract", () => {
    for (const spec of registry.specs) expect(spec.inherits).toBe("contract.md");
  });

  it("requires only fact kinds the pack can supply", () => {
    for (const spec of registry.specs) {
      for (const kind of spec.requires) expect(REQUIRABLE_FACT_KINDS).toContain(kind);
    }
  });

  it("declares a non-empty, duplicate-free requires set per spec", () => {
    for (const spec of registry.specs) {
      expect(spec.requires.length).toBeGreaterThan(0);
      expect(new Set(spec.requires).size).toBe(spec.requires.length);
    }
  });

  it("serves all four scope × audience combinations", () => {
    expect(availableCombinations(registry)).toEqual([
      "module/developer",
      "module/product",
      "project/developer",
      "project/product",
    ]);
  });

  it("resolves a combination, and fails closed on one it does not serve", () => {
    expect(specFor(registry, "project", "product")?.id).toBe("project-product");
    expect(specFor(registry, "module", "product")?.id).toBe("module-product");
    expect(specFor(registry, "project", "auditor")).toBeUndefined();
    expect(specFor(registry, "release", "product")).toBeUndefined();
  });

  it("asks for Mermaid diagrams, not hand-written SVG", () => {
    // A wall of SVG path data cannot be read in the source, edited by hand, or
    // diffed between runs. Rendering to a portable format is the engine's job.
    expect(registry.contract.body).toMatch(/Diagrams \*\*MUST\*\* be written as Mermaid/);
    expect(registry.contract.body).toMatch(/MUST NOT\*\* ask the author to emit SVG/);
    for (const spec of registry.specs) {
      expect({ id: spec.id, asksForSvg: /emit(ted)? as SVG|以 SVG 产出/.test(spec.body) }).toEqual({
        id: spec.id,
        asksForSvg: false,
      });
    }
  });

  it("keeps the four specs' evidence model identical by inheriting one contract", () => {
    // The evidence markers live in the shared contract, not in any spec: a spec
    // that redefined them would be the drift PI-108 exists to prevent.
    for (const token of ["`fact`", "`verified`", "`unavailable`"]) {
      expect(registry.contract.body).toContain(token);
    }
    for (const spec of registry.specs) {
      expect(spec.body).not.toMatch(/^\| Marker \| Meaning \|/m);
    }
  });

  it("serves at most one spec per combination", () => {
    const combinations = availableCombinations(registry);
    expect(new Set(combinations).size).toBe(combinations.length);
  });

  it("bounds a fact pack by the union of what the specs require", () => {
    const union = allRequiredKinds(registry);
    expect(union.length).toBeGreaterThan(0);
    for (const kind of union) expect(REQUIRABLE_FACT_KINDS).toContain(kind);
  });
});

describe("scope and audience are open sets", () => {
  it("accepts a spec whose scope and audience appear nowhere in the engine", () => {
    const registry = loadSpecRegistry(OPEN_SET_FIXTURE);
    expect(validateSpecRegistry(registry).ok).toBe(true);
    expect(availableCombinations(registry)).toEqual(["runbook/operator"]);
    expect(specFor(registry, "runbook", "operator")?.title).toContain("no code names");
  });
});

describe("frontmatter is read strictly", () => {
  // The parser is exercised through the loader; a malformed spec must throw
  // rather than load with a silently wrong field.
  it("rejects a directory with no shared writing contract", () => {
    expect(() => loadSpecRegistry(new URL("./fixtures/", import.meta.url))).toThrow(
      /no shared writing contract/,
    );
  });
});
