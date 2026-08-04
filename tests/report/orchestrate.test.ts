import { describe, expect, it } from "vitest";

import { loadSpecRegistry } from "../../engine/contracts/report/specs.js";
import type { ModuleDirectory } from "../../engine/contracts/module/index.js";
import { explainFailures, parseArgs, planReport } from "../../engine/report/orchestrate.js";

const registry = loadSpecRegistry();

const directory: ModuleDirectory = {
  identities: [
    { id: "mod_a", structuralName: "leaves", category: "product-capability", rootNames: ["svc"], aliases: [] },
    { id: "mod_b", structuralName: "billing", category: "product-capability", rootNames: ["svc"], aliases: [] },
  ],
  displayNames: [{ moduleId: "mod_a", language: "zh-CN", name: "请假" }],
};

const request = (targets: Parameters<typeof planReport>[0]["targets"], language = "zh-CN") => ({
  targets,
  language,
  format: "markdown",
});

describe("planning a request", () => {
  it("plans a project overview", () => {
    const result = planReport(request([{ scope: "project", audience: "product" }]), registry, directory);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.targets[0]?.spec.id).toBe("project-product");
      expect(result.plan.targets[0]?.directory).toBe("project-product");
      expect(result.plan.runLabel).toBe("project-product-zh-CN");
    }
  });

  it("resolves a module by any of its references", () => {
    for (const ref of ["leave", "leaves", "mod_a", "请假"]) {
      const result = planReport(request([{ scope: "module", audience: "product", module: ref }]), registry, directory);
      expect({ ref, id: result.ok ? result.plan.targets[0]?.module?.id : null }).toEqual({ ref, id: "mod_a" });
    }
  });

  it("cuts one pack per scope and module, not per audience", () => {
    // Two audiences over one module read the same facts. Cutting twice would
    // double the work and let the two documents disagree about what was in scope.
    const result = planReport(
      request([
        { scope: "module", audience: "product", module: "leave" },
        { scope: "module", audience: "developer", module: "leave" },
      ]),
      registry,
      directory,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.targets).toHaveLength(2);
      expect(result.plan.packKeys).toEqual(["module:mod_a"]);
    }
  });

  it("keeps packs separate for different modules", () => {
    const result = planReport(
      request([
        { scope: "module", audience: "product", module: "leave" },
        { scope: "module", audience: "product", module: "billing" },
      ]),
      registry,
      directory,
    );
    expect(result.ok && result.plan.packKeys).toEqual(["module:mod_a", "module:mod_b"]);
  });

  it("gives each target its own directory inside the run", () => {
    const result = planReport(
      request([
        { scope: "project", audience: "product" },
        { scope: "module", audience: "product", module: "leave" },
      ]),
      registry,
      directory,
    );
    expect(result.ok && result.plan.targets.map((t) => t.directory)).toEqual([
      "project-product",
      "module-leaves-product",
    ]);
  });
});

describe("failure paths", () => {
  it("refuses an empty request", () => {
    const result = planReport(request([]), registry, directory);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures[0]?.code).toBe("no-targets");
  });

  it("refuses an unserved combination and lists what exists", () => {
    const result = planReport(request([{ scope: "project", audience: "auditor" }]), registry, directory);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures[0]?.code).toBe("spec-not-found");
      expect(result.failures[0]?.available).toContain("project/product");
    }
  });

  it("refuses a scoped target with no module", () => {
    const result = planReport(request([{ scope: "module", audience: "product" }]), registry, directory);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures[0]?.code).toBe("module-missing");
  });

  it("stops on an unresolved module rather than widening to the project", () => {
    const result = planReport(
      request([{ scope: "module", audience: "product", module: "nope" }]),
      registry,
      directory,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures[0]?.code).toBe("module-unresolved");
      expect(result.failures[0]?.detail).toContain("widening");
      expect(result.failures[0]?.available).toContain("leaves");
    }
  });

  it("refuses the same target twice", () => {
    const result = planReport(
      request([
        { scope: "project", audience: "product" },
        { scope: "project", audience: "product" },
      ]),
      registry,
      directory,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures[0]?.code).toBe("duplicate-target");
  });

  it("explains every failure, with the alternatives", () => {
    const result = planReport(request([{ scope: "release", audience: "product" }]), registry, directory);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const text = explainFailures(result.failures);
      expect(text).toContain("request refused");
      expect(text).toContain("available:");
    }
  });
});

describe("argument parsing", () => {
  it("reads scope, audience, module, language and format", () => {
    const parsed = parseArgs(["--scope", "module", "--module", "leave", "--audience", "developer", "--lang", "es", "--format", "docx"]);
    expect(parsed).toEqual({
      targets: [{ scope: "module", audience: "developer", module: "leave" }],
      language: "es",
      format: "docx",
    });
  });

  it("defaults to the project product report in Chinese Markdown", () => {
    expect(parseArgs([])).toEqual({
      targets: [{ scope: "project", audience: "product" }],
      language: "zh-CN",
      format: "markdown",
    });
  });

  it("expands several modules and audiences into separate targets", () => {
    const parsed = parseArgs(["--scope", "module", "--module", "leave", "--module", "billing", "--audience", "product", "--audience", "developer"]);
    expect(parsed.targets).toHaveLength(4);
  });

  it("does not restrict language to a whitelist", () => {
    expect(parseArgs(["--lang", "pt-BR"]).language).toBe("pt-BR");
  });
});
