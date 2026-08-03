import { describe, expect, it } from "vitest";

import {
  ILLEGAL_REQUEST_EXAMPLES,
  LEGAL_COMBINATION_EXAMPLES,
  isModuleOnly,
  moduleTarget,
  projectLevelTargets,
  projectTarget,
  resolveModuleScope,
  targetKey,
  UnresolvedModuleError,
  validateRequest,
} from "../../../engine/contracts/report/target.js";

describe("validateRequest", () => {
  it("accepts every named legal combination", () => {
    for (const { name, request } of LEGAL_COMBINATION_EXAMPLES) {
      expect(validateRequest(request).ok, name).toBe(true);
    }
  });

  it("rejects empty, duplicate, and unnamed-module requests", () => {
    for (const { why, request } of ILLEGAL_REQUEST_EXAMPLES) {
      expect(validateRequest(request).ok, why).toBe(false);
    }
  });
});

describe("module-only", () => {
  it("produces zero project-level targets", () => {
    const request = [moduleTarget("leave", "product"), moduleTarget("leave", "developer")];
    expect(isModuleOnly(request)).toBe(true);
    expect(projectLevelTargets(request)).toHaveLength(0);
  });

  it("a mixed request is not module-only and keeps its project-level target", () => {
    const request = [projectTarget("product"), moduleTarget("leave", "developer")];
    expect(isModuleOnly(request)).toBe(false);
    expect(projectLevelTargets(request)).toHaveLength(1);
  });
});

describe("resolveModuleScope", () => {
  const known = new Set(["leave", "payroll"]);

  it("resolves a known module id", () => {
    expect(resolveModuleScope("leave", known)).toEqual({ kind: "module", moduleId: "leave" });
  });

  it("fails closed on an unknown id, never widening to the project", () => {
    expect(() => resolveModuleScope("ghost", known)).toThrow(UnresolvedModuleError);
  });
});

describe("targetKey", () => {
  it("distinguishes scope and audience, and equates identical targets", () => {
    expect(targetKey(projectTarget("product"))).toBe(targetKey(projectTarget("product")));
    expect(targetKey(projectTarget("product"))).not.toBe(targetKey(projectTarget("developer")));
    expect(targetKey(moduleTarget("leave", "product"))).not.toBe(targetKey(moduleTarget("payroll", "product")));
  });
});
