import { describe, expect, it } from "vitest";

import type { ImportedEdge } from "../../engine/providers/codegraph/importedges.js";
import type { ImportedNode } from "../../engine/providers/codegraph/importnodes.js";
import type { SentinelItem } from "../../engine/contracts/truth/sentinel.js";
import { gradeSentinels } from "../../engine/gates/sentinel-smoke.js";

const node = (path: string, structuralKind: ImportedNode["structuralKind"] = "symbol"): ImportedNode => ({
  nativeId: path,
  structuralKind,
  rawKind: "x",
  name: "x",
  qualifiedName: null,
  filePath: path,
  startLine: 1,
  endLine: 2,
  metadata: {},
});

function sentinel(id: string, kind: SentinelItem["kind"], path: string, root = "web-vue"): SentinelItem {
  return {
    id,
    root,
    kind,
    category: "x",
    claim: "",
    evidence: [{ path }],
    expectedStatus: kind === "clean-absence" ? "absent" : "found",
    criticality: "normal",
    mustFind: kind !== "clean-absence",
    noDedicatedReader: true,
    prevents: "x",
  };
}

const noEdges: readonly ImportedEdge[] = [];

describe("gradeSentinels", () => {
  it("passes when positives are found and no server route is invented", () => {
    const report = gradeSentinels(
      [sentinel("P1", "positive", "src/router/index.js"), sentinel("A1", "clean-absence", "src")],
      [node("src/router/index.js"), node("src/views/Home.vue")],
      noEdges,
      "web-vue",
    );
    expect(report.passed).toBe(true);
    expect(report.positivesFound).toBe(1);
    expect(report.cleanAbsencesHonored).toBe(1);
    expect(report.results.find((r) => r.id === "A1")!.status).toBe("absent");
  });

  it("fails when a positive is not found — the generic path produced no structure there", () => {
    const report = gradeSentinels([sentinel("P1", "positive", "src/router/index.js")], [node("other.js")], noEdges, "web-vue");
    expect(report.results[0]!.status).toBe("not-found");
    expect(report.passed).toBe(false);
  });

  it("fails a clean-absence when a server route is invented for the SPA", () => {
    const report = gradeSentinels(
      [sentinel("A1", "clean-absence", "src")],
      [node("src/x.js"), node("src/api.js", "route")],
      noEdges,
      "web-vue",
    );
    expect(report.results[0]!.status).toBe("present");
    expect(report.passed).toBe(false);
  });

  it("fails when the generic path produced no useful structure at all", () => {
    const report = gradeSentinels([sentinel("P1", "positive", "src/x")], [], noEdges, "web-vue");
    expect(report.usefulStructureNodes).toBe(0);
    expect(report.passed).toBe(false);
  });

  it("marks a sentinel in another root unresolved", () => {
    const report = gradeSentinels([sentinel("B1", "positive", "index.js", "backend")], [node("src/x")], noEdges, "web-vue");
    expect(report.results[0]!.status).toBe("unresolved");
  });
});
