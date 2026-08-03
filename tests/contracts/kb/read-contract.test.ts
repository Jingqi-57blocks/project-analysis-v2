import { describe, expect, it } from "vitest";

import {
  KB_TABLES,
  LINE_ANCHORED_KINDS,
  MULTI_TABLE_KINDS,
  READABLE_KINDS,
  READING_ORDER,
  SET_VALUED_KINDS,
  WORKSPACE_LEVEL_KINDS,
  isLineAnchored,
  isReadableKind,
  isWorkspaceLevelKind,
  tablesFor,
  validateKbContract,
} from "../../../engine/contracts/kb/read-contract.js";
import { REQUIRABLE_FACT_KINDS, loadSpecRegistry } from "../../../engine/contracts/report/specs.js";

describe("knowledge-base read contract", () => {
  it("validates", () => {
    const result = validateKbContract();
    expect(result.ok ? [] : result.reasons).toEqual([]);
  });

  it("serves every readable kind from at least one table", () => {
    for (const kind of READABLE_KINDS) expect(tablesFor(kind).length).toBeGreaterThan(0);
  });

  it("declares each table's identity column as public", () => {
    for (const table of KB_TABLES) expect(table.publicColumns).toContain(table.identityColumn);
  });

  it("names the kinds served by more than one table", () => {
    // A count for one of these is ambiguous until the report names its table.
    expect(MULTI_TABLE_KINDS).toContain("condition");
    expect(MULTI_TABLE_KINDS).toContain("data-access");
    expect(MULTI_TABLE_KINDS).not.toContain("route");
    for (const kind of MULTI_TABLE_KINDS) expect(tablesFor(kind).length).toBeGreaterThan(1);
  });

  it("puts the derived layer before the raw layer in the reading order", () => {
    const derivedFirst = READING_ORDER.findIndex((step) => step.startsWith("coverage-note"));
    const rawLast = READING_ORDER.findIndex((step) => step.startsWith("raw structural"));
    expect(derivedFirst).toBeGreaterThanOrEqual(0);
    expect(rawLast).toBeGreaterThan(derivedFirst);
  });

  it("classifies the line-anchored and workspace-level kinds as readable", () => {
    for (const kind of [...LINE_ANCHORED_KINDS, ...WORKSPACE_LEVEL_KINDS, ...SET_VALUED_KINDS]) {
      expect(isReadableKind(kind)).toBe(true);
    }
  });

  it("keeps line-anchored and workspace-level apart", () => {
    // A workspace-level kind survives every scope filter; a line-anchored one
    // cannot anchor an identity. Nothing may be both, or a module report would
    // carry unscoped facts that also cannot be attributed.
    for (const kind of WORKSPACE_LEVEL_KINDS) expect(isLineAnchored(kind)).toBe(false);
    for (const kind of LINE_ANCHORED_KINDS) expect(isWorkspaceLevelKind(kind)).toBe(false);
  });
});

describe("the specs and the read contract agree", () => {
  it("lets a spec require exactly what the contract serves", () => {
    expect([...REQUIRABLE_FACT_KINDS].sort()).toEqual([...READABLE_KINDS].sort());
  });

  it("has every spec's requires served by a real table", () => {
    for (const spec of loadSpecRegistry().specs) {
      for (const kind of spec.requires) expect(tablesFor(kind).length).toBeGreaterThan(0);
    }
  });
});
