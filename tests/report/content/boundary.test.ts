import { describe, expect, it } from "vitest";

import { lineRef, type SourceRef } from "../../../engine/contracts/shared-fact/provenance.js";
import type { CoverageInput } from "../../../engine/contracts/shared-fact/applicability.js";
import { determineSectionApplicability } from "../../../engine/report/applicability.js";
import {
  CAPABILITIES_BLOCK,
  MODULE_RESPONSIBILITY_BLOCK,
  PM_STRUCTURE_AUTHORED_BLOCKS,
  type AccessRecord,
  type ContainmentRecord,
  type EntryRecord,
  type ModuleEdgeRecord,
  type ModuleRecord,
  renderEntryList,
  renderModuleMap,
  renderModuleNeighbours,
  validateEntryList,
  validateModuleMap,
} from "../../../engine/report/content/boundary.js";

const ROOT = "wcp-service-v2";
const cite = (path: string, line = 1): SourceRef => lineRef(ROOT, path, line);

const modules: ModuleRecord[] = [
  { moduleId: "leave", name: "Leave", citation: cite("internal/leave/mod.go") },
  { moduleId: "payroll", name: "Payroll", citation: cite("internal/payroll/mod.go") },
  { moduleId: "auth", name: "Auth", citation: cite("internal/auth/mod.go") },
];
const containment: ContainmentRecord[] = [{ parentModuleId: "leave", childModuleId: "auth" }];
const edges: ModuleEdgeRecord[] = [
  { fromModuleId: "leave", toModuleId: "payroll" },
  { fromModuleId: "leave", toModuleId: "auth" },
  { fromModuleId: "payroll", toModuleId: "ghost" }, // ghost is not a known module
];

describe("renderModuleMap", () => {
  it("is deterministic and reconciles its count with the ledger", () => {
    const map = renderModuleMap(modules, containment, edges);
    expect(map.moduleCount).toBe(modules.length);
    expect(map.nodes.map((n) => n.moduleId)).toEqual(["auth", "leave", "payroll"]); // sorted
    const leave = map.nodes.find((n) => n.moduleId === "leave")!;
    expect(leave.downstream).toEqual(["auth", "payroll"]);
    expect(leave.children).toEqual(["auth"]);
    expect(map.nodes.find((n) => n.moduleId === "auth")!.upstream).toEqual(["leave"]);
  });

  it("surfaces a reference to an unknown module instead of inventing a node", () => {
    const map = renderModuleMap(modules, containment, edges);
    expect(map.danglingRefs).toContain("ghost");
    expect(map.nodes.some((n) => n.moduleId === "ghost")).toBe(false);
  });

  it("carries each module's citation", () => {
    const map = renderModuleMap(modules, containment, edges);
    for (const node of map.nodes) expect(node.citation.relPath.length).toBeGreaterThan(0);
    expect(validateModuleMap(map, modules)).toEqual({ ok: true });
  });

  it("rejects a map whose count drifts from the ledger", () => {
    const map = renderModuleMap(modules, containment, edges);
    const short = validateModuleMap(map, modules.slice(1));
    expect(short.ok).toBe(false);
  });
});

describe("renderModuleNeighbours", () => {
  it("gives a module its up and downstream", () => {
    expect(renderModuleNeighbours("auth", modules, edges)).toEqual({ moduleId: "auth", upstream: ["leave"], downstream: [] });
    expect(renderModuleNeighbours("leave", modules, edges)).toEqual({ moduleId: "leave", upstream: [], downstream: ["auth", "payroll"] });
  });
});

const entries: EntryRecord[] = [
  { entryId: "e2", kind: "route", label: "POST /leaves/:id/approve", moduleId: "leave", citation: cite("internal/leave/handler.go", 20) },
  { entryId: "e1", kind: "route", label: "GET /leaves", moduleId: "leave", citation: cite("internal/leave/handler.go", 10) },
  { entryId: "e3", kind: "job", label: "payroll.run", moduleId: "payroll", citation: cite("internal/payroll/job.go", 5) },
];
const access: AccessRecord[] = [
  { entryId: "e2", mechanism: "requireRole", requirement: "manager", citation: cite("internal/leave/mw.go", 3) },
];

describe("renderEntryList", () => {
  it("preserves labels verbatim, sorts by id, and reconciles its count", () => {
    const list = renderEntryList(entries, access);
    expect(list.entryCount).toBe(3);
    expect(list.entries.map((e) => e.entryId)).toEqual(["e1", "e2", "e3"]);
    expect(list.entries.find((e) => e.entryId === "e2")!.label).toBe("POST /leaves/:id/approve");
    expect(list.byModule).toEqual({ leave: 2, payroll: 1 });
    expect(validateEntryList(list, entries)).toEqual({ ok: true });
  });

  it("shows declared access only, never a guessed permission", () => {
    const list = renderEntryList(entries, access);
    // e2 has a declared role; e1 has none — and is not assumed public
    expect(list.entries.find((e) => e.entryId === "e2")!.access).toEqual([
      { mechanism: "requireRole", requirement: "manager", citation: cite("internal/leave/mw.go", 3) },
    ]);
    expect(list.entries.find((e) => e.entryId === "e1")!.access).toEqual([]);
  });

  it("rejects an entry with an empty label", () => {
    const bad = renderEntryList([{ ...entries[0]!, label: "" }], []);
    expect(validateEntryList(bad, [{ ...entries[0]!, label: "" }]).ok).toBe(false);
  });
});

describe("no-UI project versus UI unresolved — the distinction is preserved", () => {
  function cov(over: Partial<CoverageInput>): CoverageInput {
    return {
      capable: true,
      providerRan: true,
      scopeDefined: true,
      evidencePresent: false,
      notApplicableConfirmed: false,
      failed: false,
      truncated: false,
      conflict: false,
      ...over,
    };
  }

  it("a project confirmed to have no UI is not-applicable; an unresolved UI is unknown", () => {
    const noUi = determineSectionApplicability({
      sectionId: "project-roles-flows",
      requirement: "required",
      kinds: [{ kind: "ui-route", coverage: cov({ notApplicableConfirmed: true }) }],
    });
    const unresolved = determineSectionApplicability({
      sectionId: "project-roles-flows",
      requirement: "required",
      kinds: [{ kind: "ui-route", coverage: cov({ truncated: true }) }],
    });
    expect(noUi.applicability).toBe("not-applicable");
    expect(unresolved.applicability).toBe("unknown");
    expect(noUi.applicability).not.toBe(unresolved.applicability);
  });
});

describe("authored-block contracts", () => {
  it("require citations, name their schema and validator, and carry a prompt", () => {
    for (const block of PM_STRUCTURE_AUTHORED_BLOCKS) {
      expect(block.citationRule).toBe("required");
      expect(block.outputSchemaId.length).toBeGreaterThan(0);
      expect(block.validatorId).toBe(block.outputSchemaId);
      expect(block.prompt.length).toBeGreaterThan(0);
      expect(block.inputFactKinds.length).toBeGreaterThan(0);
    }
    expect(CAPABILITIES_BLOCK.blockId).toBe("project-boundary.capabilities");
    expect(MODULE_RESPONSIBILITY_BLOCK.blockId).toBe("module-responsibility.summary");
  });
});
