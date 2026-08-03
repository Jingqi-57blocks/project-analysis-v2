import { describe, expect, it } from "vitest";

import { moduleScope, type Scope } from "../../engine/contracts/report/target.js";
import type { AssembledBlock } from "../../engine/report/assemble.js";
import type { BlockContent } from "../../engine/report/render.js";
import type { CitedFact } from "../../engine/report/slice-resolve.js";
import { type ProseStore } from "../../engine/report/authoring-host.js";
import { authoredContent } from "../../engine/report/authored-content.js";

function fact(factId: string, value: unknown, startLine: number): CitedFact {
  return {
    factId,
    kind: "data-access",
    value,
    citation: { rootName: "r1", relPath: "handlers/leave/service.go", startLine, endLine: startLine, startColumn: null, endColumn: null },
    resolutionClass: "declared",
  };
}

const F1 = fact("f|a", { table: "wcp_leave" }, 42);
const F2 = fact("f|b", { branch: "x" }, 7);

function block(blockId: string, taskId: string | null, scope: Scope = moduleScope("leave")): AssembledBlock {
  return {
    blockId,
    kind: taskId === null ? "deterministic" : "authored-required",
    outputSchemaId: "schema.v1",
    carriesSharedClaim: false,
    taskId,
    sliceScope: scope,
    sliceKey: "k",
    sliceDigest: "d",
    validated: true,
    artifactRef: taskId === null ? null : `authored-prose://${taskId}`,
  };
}

const fallback: BlockContent = (_documentId, b) => `FALLBACK:${b.blockId}`;

describe("authoredContent — renders stored prose with an expanded citations footnote", () => {
  it("renders the prose and expands each cited fact to its factId and source location", () => {
    const store: ProseStore = new Map([
      ["t1", { prose: "The leave table is read [1]. A balance branch guards it [2].", groundedFactIds: [F1.factId, F2.factId], facts: [F1, F2] }],
    ]);
    const content = authoredContent(store, fallback);
    const text = content("module:leave|developer", block("module-flows-branches.flows", "t1"));
    expect(text).toContain("The leave table is read [1].");
    expect(text).toContain("_Citations:_");
    expect(text).toContain("- [1] f|a — r1/handlers/leave/service.go:42");
    expect(text).toContain("- [2] f|b — r1/handlers/leave/service.go:7");
  });

  it("lists a footnote only for the facts the prose actually cited", () => {
    const store: ProseStore = new Map([
      ["t1", { prose: "Only the first fact is cited [1].", groundedFactIds: [F1.factId], facts: [F1, F2] }],
    ]);
    const content = authoredContent(store, fallback);
    const text = content("module:leave|developer", block("module-flows-branches.flows", "t1"));
    expect(text).toContain("- [1] f|a");
    expect(text).not.toContain("f|b"); // the uncited fact is not footnoted
  });
});

describe("authoredContent — delegates every other block to the fallback", () => {
  it("delegates an authored block whose task is not in the store", () => {
    const content = authoredContent(new Map(), fallback);
    expect(content("module:leave|developer", block("module-flows-branches.flows", "t-absent"))).toBe("FALLBACK:module-flows-branches.flows");
  });

  it("delegates a deterministic block (no task)", () => {
    const content = authoredContent(new Map(), fallback);
    expect(content("module:leave|developer", block("module-callpaths-deps.graph", null))).toBe("FALLBACK:module-callpaths-deps.graph");
  });
});
