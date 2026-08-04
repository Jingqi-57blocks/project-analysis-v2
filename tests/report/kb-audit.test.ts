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
    // These fixtures exist to prove the audit separates the fabricated report from
    // the accurate ones. They were written before the later style rules and are
    // frozen, so a *notice* about, say, coverage figures not being in checkable
    // shape is a true statement about them rather than a false positive — the opus
    // artefact has ten percentages and none in the required form. What must never
    // appear on them is anything that says the report is untrue.
    const untruth = new Set([
      "cited-path-not-in-workspace",
      "cited-extension-absent",
      "proportion-denominator-unknown",
      "proportion-mismatch",
      "cited-id-not-in-base",
    ]);
    for (const model of ["sonnet", "opus"]) {
      const result = auditReport({ report: trialReport(model), inventory });
      expect({ model, blocking: result.findings.filter((f) => f.severity === "blocking") }).toEqual({
        model,
        blocking: [],
      });
      expect({ model, untrue: result.findings.filter((f) => untruth.has(f.code)) }).toEqual({ model, untrue: [] });
      expect({ model, passed: result.passed }).toEqual({ model, passed: true });
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

describe("the analysis's own artefacts are not project citations", () => {
  it("does not flag the knowledge base the report was written from", () => {
    // A correct report names its own snapshot. That is this tool's output, not a
    // file in the analysed project, and checking it against the project's file
    // list marked a correct report as fabricated.
    const inventory = { paths: new Set(["a/b.go"]), extensions: new Set(["go"]), denominators: new Set([1]) };
    const report = "本报告基于 `.analysis/kb.sqlite` 的快照生成，见 `.analysis/reports/08-04_11-10_x/report.md`。";
    expect(auditReport({ report, inventory }).findings).toEqual([]);
  });
});

describe("the checklist lives beside the report, not inside it", () => {
  const inventory = { paths: new Set(["a/b.go"]), extensions: new Set(["go"]), denominators: new Set([1]) };
  const required = ["literal-secrets", "open"];
  const entries = [
    { id: "literal-secrets", verdict: "hit", evidence: ["real-id"] },
    { id: "open", verdict: "hit", evidence: ["real-id"] },
  ];
  const resolveIds = (): ReadonlySet<string> => new Set(["real-id"]);

  it("reads it from a separate file, leaving the report free of machine identifiers", () => {
    // A business reader has no use for the verdicts, and a document ending in a
    // wall of identity strings reads as a data dump whatever precedes it.
    const result = auditReport({
      report: "# 报告\n\n没有任何机器标识串。",
      inventory,
      requiredChecklistIds: required,
      checklist: JSON.stringify({ checklist: entries }),
      resolveIds,
    });
    expect(result.passed).toBe(true);
    expect(result.checklist.map((c) => c.id)).toEqual(["literal-secrets", "open"]);
  });

  it("still accepts an older report that carries the block inline", () => {
    const report = `# 报告\n\n\`\`\`json\n${JSON.stringify({ checklist: entries })}\n\`\`\`\n`;
    expect(auditReport({ report, inventory, requiredChecklistIds: required, resolveIds }).passed).toBe(true);
  });

  it("fails when neither is present", () => {
    const result = auditReport({ report: "# 报告", inventory, requiredChecklistIds: required });
    expect(result.findings.map((f) => f.code)).toEqual(["checklist-block-missing"]);
    expect(result.findings[0]?.evidence).toBe("checklist.json");
  });
});

describe("what the audit deliberately does not check", () => {
  it("cannot tell a closing synthesis from a last labelled fact", () => {
    // Both are a paragraph introduced in bold, and one artefact writes the
    // synthesis as a heading instead. The property is real and required — it is
    // what makes the document argue something rather than answer questions — but
    // it is semantic, and an audit that guessed at it from formatting would pass
    // a chapter ending "**Project stage** — unavailable" as though it had one.
    // It is enforced by the spec's per-chapter structure instead.
    const inventory = { paths: new Set(["a/b.go"]), extensions: new Set(["go"]), denominators: new Set([1]) };
    const endsOnAFact = "# r\n\n## 一\n\n有五个仓库。\n\n**项目所处阶段**——不可得。\n";
    const endsOnASynthesis = "# r\n\n## 一\n\n有五个仓库。\n\n**小结。** 五个仓库不是五套业务。\n";
    for (const report of [endsOnAFact, endsOnASynthesis]) {
      expect(auditReport({ report, inventory }).findings).toEqual([]);
    }
  });
});

describe("coverage figures the audit can actually check", () => {
  const inventory = { paths: new Set(["a/b.go"]), extensions: new Set(["go"]), denominators: new Set([520]) };

  it("notices a report whose percentages are all in an uncheckable shape", () => {
    // "18% of traces (93/520)" — a noun between the sign and the bracket — matched
    // nothing, so a report's entire coverage chapter passed unexamined while the
    // audit reported no findings at all.
    const result = auditReport({ report: "18%的行为追踪（93/520）未完成", inventory });
    expect(result.findings.map((f) => f.code)).toEqual(["no-checkable-coverage-figure"]);
    expect(result.passed).toBe(true);
  });

  it("says nothing when at least one figure is checkable", () => {
    expect(auditReport({ report: "18%（93/520）的追踪未完成，其中 100% 属于同一根", inventory }).findings).toEqual([]);
  });

  it("does not flag a percentage that is a rule the code enforces", () => {
    // A report may quote "the ratio must not exceed 100%". Nothing in the
    // formatting separates that from a coverage figure, so per-percentage checking
    // produces false positives on correct reports — this is the one claim the
    // audit can stand behind.
    expect(auditReport({ report: "折扣比例不得超过 100%，且 18%（93/520）的追踪未完成", inventory }).findings).toEqual([]);
  });
});
