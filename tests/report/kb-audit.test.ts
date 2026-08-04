import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { auditReport, citedPaths, citedProportions, explainAudit, inventoryFrom, readInventory } from "../../engine/report/kb-audit.js";
import type { Store } from "../../engine/store/types.js";

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

describe("the closing checklist block", () => {
  const inventory = { paths: new Set(["a/b.go"]), extensions: new Set(["go"]), denominators: new Set([520]) };
  const block = (entries: unknown): string =>
    `# report\n\n\`\`\`json\n${JSON.stringify({ checklist: entries }, null, 2)}\n\`\`\`\n`;
  const required = ["literal-secrets", "open"];

  it("is required when the rules name checklist items", () => {
    const result = auditReport({ report: "# report\n\nno block here", inventory, requiredChecklistIds: required });
    expect(result.findings.map((f) => f.code)).toEqual(["checklist-block-missing"]);
    expect(result.passed).toBe(false);
  });

  it("is not required of a report written under no checklist", () => {
    expect(auditReport({ report: "# report\n\nno block here", inventory }).passed).toBe(true);
  });

  it("names the item that was silently dropped", () => {
    // A dropped item and one that searched and found nothing read identically in
    // prose. Only the block tells them apart.
    const report = block([{ id: "literal-secrets", verdict: "hit", evidence: ["k"] }]);
    const result = auditReport({ report, inventory, requiredChecklistIds: required });
    expect(result.findings.filter((f) => f.code === "checklist-item-missing").map((f) => f.evidence)).toEqual(["open"]);
  });

  it("rejects a verdict outside the three", () => {
    const report = block([
      { id: "literal-secrets", verdict: "probably fine", evidence: ["k"] },
      { id: "open", verdict: "hit", evidence: ["k"] },
    ]);
    const result = auditReport({ report, inventory, requiredChecklistIds: required });
    expect(result.findings.map((f) => f.code)).toContain("checklist-verdict-unknown");
  });

  it("rejects a verdict that names no row it read", () => {
    // Only cannot-determine may cite nothing: a search that hit or that searched
    // and found nothing both had rows in front of them.
    const report = block([
      { id: "literal-secrets", verdict: "searched-not-found", evidence: [] },
      { id: "open", verdict: "cannot-determine", evidence: [] },
    ]);
    const result = auditReport({ report, inventory, requiredChecklistIds: required });
    expect(result.findings.filter((f) => f.code === "verdict-without-evidence").map((f) => f.evidence)).toEqual([
      "literal-secrets",
    ]);
  });

  it("rejects an identity the base does not contain", () => {
    // This is what replaced the persisted claim layer: the report names the rows
    // it read, and every name is looked up.
    const report = block([
      { id: "literal-secrets", verdict: "hit", evidence: ["real-id", "invented-id"] },
      { id: "open", verdict: "hit", evidence: ["real-id"] },
    ]);
    const result = auditReport({
      report,
      inventory,
      requiredChecklistIds: required,
      resolveIds: () => new Set(["real-id"]),
    });
    expect(result.findings.filter((f) => f.code === "cited-id-not-in-base").map((f) => f.evidence)).toEqual([
      "invented-id",
    ]);
    expect(result.passed).toBe(false);
  });

  it("notices, without blocking, a run that only executed the list", () => {
    // The open item is the one thing testing whether the author investigated. A
    // small project may legitimately close it empty, so this is a reason to
    // reject the run deliberately rather than an assertion of untruth.
    const report = block([
      { id: "literal-secrets", verdict: "hit", evidence: ["real-id"] },
      { id: "open", verdict: "cannot-determine", evidence: [] },
    ]);
    const result = auditReport({
      report,
      inventory,
      requiredChecklistIds: required,
      resolveIds: () => new Set(["real-id"]),
    });
    expect(result.findings.map((f) => f.code)).toEqual(["no-open-finding"]);
    expect(result.passed).toBe(true);
  });

  it("accepts a complete block and reports how much of it resolved", () => {
    const report = block([
      { id: "literal-secrets", verdict: "hit", evidence: ["real-id"] },
      { id: "open", verdict: "hit", evidence: ["real-id"] },
    ]);
    const result = auditReport({
      report,
      inventory,
      requiredChecklistIds: required,
      resolveIds: () => new Set(["real-id"]),
    });
    expect(result.passed).toBe(true);
    expect(result.checklist).toEqual([
      { id: "literal-secrets", verdict: "hit", cited: 1, resolved: 1 },
      { id: "open", verdict: "hit", cited: 1, resolved: 1 },
    ]);
  });
});

describe("denominators a subject-scoped report can legitimately cite", () => {
  /** A store holding one file, one kind count, and one derived capability. */
  const store = {
    all: (sql: string) => {
      if (sql.includes("from files")) return [{ rel_path: "a/b.go" }];
      if (sql.includes("count(*)")) return [{ n: 4109 }];
      if (sql.includes("derived_records")) {
        return [{ payload: JSON.stringify({ name: "Leave", endpoints: new Array(26).fill("e"), flowCount: 26 }) }];
      }
      return [];
    },
  } as unknown as Store;

  it("counts the cardinalities inside derived payloads", () => {
    // Without this a correct capability report is rejected: "50% (13/26)" is
    // about that capability's 26 endpoints, and no workspace-wide count is 26.
    const inventory = readInventory(store, 1);
    expect(inventory.denominators.has(26)).toBe(true);
    expect(auditReport({ report: "50%（13/26）of its flows are traced", inventory }).passed).toBe(true);
  });

  it("still rejects a denominator nothing in the store justifies", () => {
    const inventory = readInventory(store, 1);
    const result = auditReport({ report: "50%（13/27）of its flows are traced", inventory });
    expect(result.findings.map((f) => f.code)).toEqual(["proportion-denominator-unknown"]);
  });
});
