import { describe, expect, it } from "vitest";

import {
  canonicalModuleId,
  isLiveOrMigratable,
  type ModuleRegistry,
  resolveModule,
} from "../../../engine/contracts/shared-fact/module-identity.js";

const leave = canonicalModuleId("api", "leave");
const leaveV2 = canonicalModuleId("api", "leave-v2");
const leaveApply = canonicalModuleId("api", "leave/apply");
const leaveApprove = canonicalModuleId("api", "leave/approve");
const payroll = canonicalModuleId("api", "payroll");

describe("canonicalModuleId", () => {
  it("is repo-scoped and stable", () => {
    expect(canonicalModuleId("api", "leave")).toBe(leave);
    expect(canonicalModuleId("web", "leave")).not.toBe(leave);
  });
});

describe("resolveModule", () => {
  it("resolves a live module exactly", () => {
    expect(resolveModule(leave, { modules: [leave], lineage: [] })).toEqual({ kind: "exact", id: leave });
  });

  it("follows a supersede/alias chain to the current module", () => {
    const reg: ModuleRegistry = {
      modules: [leaveV2],
      lineage: [{ from: leave, to: [leaveV2], relation: "supersede", reason: "renamed leave-v2" }],
    };
    const r = resolveModule(leave, reg);
    expect(r.kind).toBe("aliased");
    if (r.kind === "aliased") {
      expect(r.id).toBe(leaveV2);
      expect(r.from).toBe(leave);
    }
  });

  it("returns candidates for a split, never a guess", () => {
    const reg: ModuleRegistry = {
      modules: [leaveApply, leaveApprove],
      lineage: [{ from: leave, to: [leaveApply, leaveApprove], relation: "split", reason: "split" }],
    };
    const r = resolveModule(leave, reg);
    expect(r.kind).toBe("candidate");
    if (r.kind === "candidate") expect(r.ids).toHaveLength(2);
  });

  it("folds a merge source into the merged module", () => {
    const reg: ModuleRegistry = {
      modules: [payroll],
      lineage: [{ from: leave, to: [payroll], relation: "merge", reason: "merged into payroll" }],
    };
    expect(resolveModule(leave, reg).kind).toBe("aliased");
  });

  it("fails closed on an unknown id — no guess, no widening", () => {
    expect(resolveModule(leave, { modules: [payroll], lineage: [] }).kind).toBe("unresolved");
  });

  it("fails closed on a lineage cycle", () => {
    const reg: ModuleRegistry = {
      modules: [],
      lineage: [
        { from: leave, to: [leaveV2], relation: "alias", reason: "" },
        { from: leaveV2, to: [leave], relation: "alias", reason: "" },
      ],
    };
    expect(resolveModule(leave, reg).kind).toBe("unresolved");
  });
});

describe("isLiveOrMigratable", () => {
  it("is true for live and aliased, false for unknown", () => {
    expect(isLiveOrMigratable(leave, { modules: [leave], lineage: [] })).toBe(true);
    expect(
      isLiveOrMigratable(leave, {
        modules: [leaveV2],
        lineage: [{ from: leave, to: [leaveV2], relation: "alias", reason: "" }],
      }),
    ).toBe(true);
    expect(isLiveOrMigratable(leave, { modules: [payroll], lineage: [] })).toBe(false);
  });
});
