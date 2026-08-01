import { describe, expect, it } from "vitest";

import type { GenerationParams } from "../../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../../engine/contracts/report/snapshot.js";
import { moduleTarget, projectTarget, type ReportRequest } from "../../engine/contracts/report/target.js";
import { authoredTasks } from "../../engine/contracts/report/pipeline.js";
import { compileExecutablePlan } from "../../engine/report/plan.js";
import { executeAuthoredTasks } from "../../engine/report/execute.js";
import { assembleReport, type AssembledBlock } from "../../engine/report/assemble.js";
import { auditReport, accountDocuments } from "../../engine/report/audit.js";
import { renderReport } from "../../engine/report/render.js";
import { fakeHost } from "./helpers/fake-host.js";

const SNAPSHOT: AnalysisSnapshotIdentity = {
  sourceIdentity: "src-1",
  codeGraphIdentity: "graph-1",
  providerIdentity: "providers-1",
  schemaVersion: "1.0.0",
  configIdentity: "config-1",
};
const PARAMS: GenerationParams = { executorKind: "host-agent", modelId: "claude-opus-4-8", language: "en" };

function compile(request: ReportRequest) {
  return compileExecutablePlan({ request, snapshot: SNAPSHOT, params: PARAMS, analysisRunId: "run-1" });
}

/** Deterministic synthetic content for a block — a stand-in for the M4 live render. */
const content = (documentId: string, block: AssembledBlock): string => `[${documentId}] ${block.blockId} (${block.kind})`;

const BOTH: ReportRequest = [projectTarget("product"), projectTarget("developer")];

describe("assembleReport — ordered, complete, digest-stable", () => {
  it("assembles every document's sections and blocks in the plan's order, complete when all validate", () => {
    const e = compile(BOTH);
    const run = executeAuthoredTasks(e.plan, fakeHost());
    const report = assembleReport(e.plan, e.slices, run.artifacts);

    expect(report.documents.map((d) => d.documentId).sort()).toEqual(["project|developer", "project|product"]);
    for (const doc of report.documents) {
      const planDoc = e.plan.documents.find((d) => d.documentId === doc.documentId)!;
      expect(doc.sections.map((s) => s.sectionId)).toEqual(planDoc.sections.map((s) => s.sectionId)); // plan order preserved
      expect(doc.complete).toBe(true);
      expect(doc.missingRequired).toEqual([]);
      // every block records its source slice digest
      for (const s of doc.sections) for (const b of s.blocks) expect(typeof b.sliceDigest === "string" || b.sliceDigest === null).toBe(true);
    }
    expect(report.complete).toBe(true);
  });

  it("is byte-stable regardless of task completion order", () => {
    const e = compile(BOTH);
    // one run clean, one where the last task adopts late (flaky) — same assembled bytes
    const clean = assembleReport(e.plan, e.slices, executeAuthoredTasks(e.plan, fakeHost()).artifacts);
    const lastTask = authoredTasks(e.plan).at(-1)!;
    const late = assembleReport(e.plan, e.slices, executeAuthoredTasks(e.plan, fakeHost({ flakyUntil: { [lastTask.taskId]: 1 } })).artifacts);
    expect(late.digest).toBe(clean.digest);
  });

  it("leaves a document incomplete when a required authored block never validates", () => {
    const e = compile(BOTH);
    const target = authoredTasks(e.plan)[0]!;
    const run = executeAuthoredTasks(e.plan, fakeHost({ alwaysReject: new Set([target.taskId]) }));
    const report = assembleReport(e.plan, e.slices, run.artifacts);
    const incomplete = report.documents.find((d) => d.missingRequired.includes(target.taskId))!;
    expect(incomplete.complete).toBe(false);
    expect(report.complete).toBe(false);
  });
});

describe("auditReport — cross-document consistency, fail-closed", () => {
  it("passes a clean dual report and reports shared-claim reuse", () => {
    const e = compile(BOTH);
    const run = executeAuthoredTasks(e.plan, fakeHost());
    const audit = auditReport(assembleReport(e.plan, e.slices, run.artifacts));
    expect(audit.ok).toBe(true);
    expect(audit.findings).toEqual([]);
    expect(audit.sharedClaimBlocks).toBeGreaterThan(0); // known-issues.impact is shared across both documents
  });

  it("blocks the run when a required block is missing", () => {
    const e = compile(BOTH);
    const target = authoredTasks(e.plan)[0]!;
    const run = executeAuthoredTasks(e.plan, fakeHost({ alwaysReject: new Set([target.taskId]) }));
    const audit = auditReport(assembleReport(e.plan, e.slices, run.artifacts));
    expect(audit.ok).toBe(false);
    expect(audit.findings.some((f) => f.kind === "incomplete-document")).toBe(true);
  });

  it("catches a shared claim whose identity diverges across documents", () => {
    const e = compile(BOTH);
    const report = assembleReport(e.plan, e.slices, executeAuthoredTasks(e.plan, fakeHost()).artifacts);
    // tamper: give one document's shared known-issues.impact block a different slice digest
    const tampered = {
      ...report,
      documents: report.documents.map((doc, i) =>
        i === 0
          ? doc
          : {
              ...doc,
              sections: doc.sections.map((s) =>
                s.sectionId !== "known-issues"
                  ? s
                  : { ...s, blocks: s.blocks.map((b) => (b.blockId === "known-issues.impact" ? { ...b, sliceDigest: "tampered" } : b)) },
              ),
            },
      ),
    };
    const audit = auditReport(tampered);
    expect(audit.ok).toBe(false);
    expect(audit.findings.some((f) => f.kind === "shared-claim-divergent")).toBe(true);
  });
});

describe("auditReport — the remaining consistency checks fire", () => {
  it("catches a block whose slice scope escapes its document scope", () => {
    const e = compile([projectTarget("product")]);
    const report = assembleReport(e.plan, e.slices, executeAuthoredTasks(e.plan, fakeHost()).artifacts);
    const tampered = {
      ...report,
      documents: report.documents.map((doc) => ({
        ...doc,
        sections: doc.sections.map((s, i) =>
          i === 0 ? { ...s, blocks: s.blocks.map((b) => ({ ...b, sliceScope: { kind: "module" as const, moduleId: "elsewhere" } })) } : s,
        ),
      })),
    };
    const audit = auditReport(tampered);
    expect(audit.ok).toBe(false);
    expect(audit.findings.some((f) => f.kind === "slice-out-of-scope")).toBe(true);
  });

  it("catches an authored block reused across two documents", () => {
    const e = compile(BOTH);
    const report = assembleReport(e.plan, e.slices, executeAuthoredTasks(e.plan, fakeHost()).artifacts);
    // find an authored task id in document 0 and forge it into document 1
    const authoredIn0 = report.documents[0]!.sections.flatMap((s) => s.blocks).find((b) => b.taskId !== null)!;
    const tampered = {
      ...report,
      documents: report.documents.map((doc, i) =>
        i !== 1
          ? doc
          : {
              ...doc,
              sections: [
                { ...doc.sections[0]!, blocks: [...doc.sections[0]!.blocks, authoredIn0] }, // graft doc-0's authored block in
                ...doc.sections.slice(1),
              ],
            },
      ),
    };
    const audit = auditReport(tampered);
    expect(audit.ok).toBe(false);
    expect(audit.findings.some((f) => f.kind === "authored-block-cross-audience")).toBe(true);
  });
});

describe("renderReport — Markdown and HTML from one audited structure", () => {
  it("renders both formats deterministically with a shared manifest", () => {
    const e = compile(BOTH);
    const report = assembleReport(e.plan, e.slices, executeAuthoredTasks(e.plan, fakeHost()).artifacts);
    const a = renderReport(report, content);
    const b = renderReport(report, content);
    expect(a).toEqual(b); // deterministic

    expect(a.documents.length).toBe(2);
    for (const doc of a.documents) {
      expect(doc.markdown.startsWith("# ")).toBe(true);
      expect(doc.html.startsWith("<!doctype html>")).toBe(true);
    }
    // the manifest binds both serializations to the assembled structure
    expect(a.manifest.documents.map((d) => d.documentId).sort()).toEqual(["project|developer", "project|product"]);
    for (const entry of a.manifest.documents) {
      const assembled = report.documents.find((d) => d.documentId === entry.documentId)!;
      expect(entry.structureDigest).toBe(assembled.digest); // same audited structure
    }
  });

  it("renders a marked gap for a required block that did not validate, without failing the render", () => {
    const e = compile(BOTH);
    const target = authoredTasks(e.plan)[0]!;
    const report = assembleReport(e.plan, e.slices, executeAuthoredTasks(e.plan, fakeHost({ alwaysReject: new Set([target.taskId]) })).artifacts);
    const rendered = renderReport(report, content);
    const withGap = rendered.documents.find((d) => report.documents.find((rd) => rd.documentId === d.documentId)!.complete === false)!;
    expect(withGap.markdown).toContain("[gap:"); // the skeleton is legible but marked
    expect(withGap.html).toContain('class="gap"');
    expect(rendered.manifest.documents.find((d) => d.documentId === withGap.documentId)!.complete).toBe(false);
  });
});

describe("module-only report assembles independently", () => {
  it("assembles a module developer report with no project document", () => {
    const e = compile([moduleTarget("leave", "developer")]);
    const report = assembleReport(e.plan, e.slices, executeAuthoredTasks(e.plan, fakeHost()).artifacts);
    expect(report.documents).toHaveLength(1);
    expect(report.documents[0]!.scope.kind).toBe("module");
    expect(auditReport(report).ok).toBe(true);
    const accounting = accountDocuments(report);
    expect(accounting[0]!.printed).toBe(accounting[0]!.blocks); // fully printed
  });
});
