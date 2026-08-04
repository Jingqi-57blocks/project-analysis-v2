import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { auditReport, citedPaths, citedProportions, explainAudit, inventoryFrom } from "../../engine/report/kb-audit.js";

/**
 * The archived three-model trial. These are the only artefacts where the answer
 * is independently known: one fabricates, two do not, and all three look equally
 * well formed. PI-112 exists because appearance cannot separate them.
 */
const FIXTURES = new URL("../../truth-set/report-audit/", import.meta.url);

function trialReport(model: string): string {
  return readFileSync(new URL(`${model}-overview.md`, FIXTURES), "utf8");
}

const inventory = inventoryFrom(
  JSON.parse(readFileSync(new URL("inventory.json", FIXTURES), "utf8")) as {
    paths: string[];
    extensions: string[];
    denominators: number[];
  },
);

describe("citation extraction", () => {
  it("finds qualified paths, with or without a line suffix", () => {
    const found = citedPaths("see internal/handlers/leave/service.go:147 for the guard");
    expect(found).toEqual(["internal/handlers/leave/service.go"]);
  });

  it("finds a bare filename after a full-width colon", () => {
    // The fabricated citation in the trial appears as "已验证位置：holidays.py".
    expect(citedPaths("已验证位置：holidays.py, leave 相关文件")).toContain("holidays.py");
  });

  it("does not mistake domains, library names or field accesses for files", () => {
    // These all match the shape `name.ext`. Reporting them would bury the one
    // finding that matters under noise, which is how the first version behaved.
    const prose = "调用 api2pdf.com，使用 Node.js，判断 req.user 与 uri.UserID";
    const result = auditReport({ report: prose, inventory });
    expect(result.findings).toEqual([]);
  });

  it("reads a percentage together with its fraction", () => {
    expect(citedProportions("47%（1944/4109）的入口可以继续追踪")).toEqual([
      { percent: 47, numerator: 1944, denominator: 4109 },
    ]);
  });

  it("ignores a bare ratio, which in prose is not a coverage claim", () => {
    expect(citedProportions("其中 1/3 属于此类，5/10 已处理")).toEqual([]);
  });
});

describe("regression over the archived trial artefacts", () => {
  it("reads the workspace inventory", () => {
    expect(inventory.paths.size).toBeGreaterThan(2000);
    expect(inventory.extensions.has("go")).toBe(true);
    expect(inventory.extensions.has("py")).toBe(false);
  });

  it("fails the fabricated report and names the invented citation", () => {
    const result = auditReport({ report: trialReport("haiku"), inventory });
    expect(result.passed).toBe(false);
    const invented = result.findings.filter((f) => f.code === "cited-extension-absent");
    expect(invented.map((f) => f.evidence)).toContain("holidays.py");
    expect(explainAudit(result)).toContain("no .py file at all");
  });

  it("passes the two accurate reports with no false positives", () => {
    for (const model of ["sonnet", "opus"]) {
      const result = auditReport({ report: trialReport(model), inventory });
      expect({ model, findings: result.findings }).toEqual({ model, findings: [] });
    }
  });
});

describe("proportion checking", () => {
  const inventory = {
    paths: new Set(["a/b.go"]),
    extensions: new Set(["go"]),
    denominators: new Set([520]),
  };

  it("flags a denominator no quantity in the store can justify", () => {
    const result = auditReport({ report: "18%（93/999）of traces stopped", inventory });
    expect(result.findings.map((f) => f.code)).toEqual(["proportion-denominator-unknown"]);
  });

  it("flags a percentage that does not match its own fraction", () => {
    const result = auditReport({ report: "50%（93/520）of traces stopped", inventory });
    expect(result.findings.map((f) => f.code)).toEqual(["proportion-mismatch"]);
    expect(result.findings[0]?.detail).toContain("18%");
  });

  it("accepts a correctly stated proportion", () => {
    expect(auditReport({ report: "18%（93/520）of traces stopped", inventory }).passed).toBe(true);
  });
});
