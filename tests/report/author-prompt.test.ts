import { describe, expect, it } from "vitest";

import { moduleTarget, type ReportTarget } from "../../engine/contracts/report/target.js";
import type { SectionDefinition } from "../../engine/contracts/report/catalog.js";
import type { GenerationParams } from "../../engine/contracts/report/pipeline.js";
import type { AnalysisSnapshotIdentity } from "../../engine/contracts/report/snapshot.js";
import type { KindCoverageInput, SectionApplicabilityDecision } from "../../engine/report/applicability.js";
import { compileExecutablePlan } from "../../engine/report/plan.js";
import { type DecisionIndex } from "../../engine/report/deterministic-content.js";
import {
  type AuthoredPromptContract,
  buildAuthoringRequests,
  composeAuthorPrompt,
  formatIndexedDigest,
} from "../../engine/report/author-prompt.js";
import { coverageInputForKind, createSliceReaders, resolveKindCoverage } from "../../engine/report/slice-resolve.js";
import { PM_AUTHORED_BLOCKS } from "../../engine/report/presets/pm.js";
import { DEV_AUTHORED_BLOCKS } from "../../engine/report/presets/dev.js";
import type { CitedFact } from "../../engine/report/slice-resolve.js";
import { SNAPSHOT_ID, insertBehaviorFact, membershipOf, seedStore } from "./helpers/seed-resolver-kb.js";

function fact(factId: string, value: unknown): CitedFact {
  return {
    factId,
    kind: "data-access",
    value,
    citation: { rootName: "r1", relPath: "handlers/leave/service.go", startLine: 42, endLine: 42, startColumn: null, endColumn: null },
    resolutionClass: "declared",
  };
}

const FACTS: readonly CitedFact[] = [fact("f|a", { table: "wcp_leave" }), fact("f|b", { branch: "x" })];

describe("formatIndexedDigest — numbered digest in the resolver's fact order", () => {
  it("numbers facts 1..n and keeps id, value, kind and citation", () => {
    const digest = formatIndexedDigest(FACTS);
    const lines = digest.split("\n");
    expect(lines[0]).toBe('1. [f|a] «{"table":"wcp_leave"}» (data-access) — r1/handlers/leave/service.go:42');
    expect(lines[1]!.startsWith("2. [f|b]")).toBe(true);
  });

  it("discloses an empty slice rather than an empty string", () => {
    expect(formatIndexedDigest([])).toContain("no cited facts");
  });
});

describe("composeAuthorPrompt — contract prompt + framing + digest + cite rule", () => {
  const contract: AuthoredPromptContract = {
    blockId: "module-flows-branches.flows",
    outputSchemaId: "flows.v1",
    inputFactKinds: ["condition"],
    prompt: "CONTRACT-VOICE-RULES",
  };

  it("layers the contract prompt, the section/audience framing, the digest and the [n] instruction", () => {
    const prompt = composeAuthorPrompt(contract, "Flows and branches", "product", FACTS);
    expect(prompt).toContain("CONTRACT-VOICE-RULES");
    expect(prompt).toContain("Section: Flows and branches");
    expect(prompt).toContain("Audience: product manager");
    expect(prompt).toContain("1. [f|a]");
    expect(prompt).toContain("cite each claim with a bracketed marker");
    expect(prompt).toContain("[n]");
  });
});

const snapshot: AnalysisSnapshotIdentity = { sourceIdentity: "s", codeGraphIdentity: "s", providerIdentity: "s", schemaVersion: "1.0.0", configIdentity: "s" };
const params: GenerationParams = { executorKind: "host-agent", modelId: "unbound-test", language: "en" };
const IN_MODULE = ["handlers/leave/service.go"];

function decisionIndexOf(applicability: readonly { documentId: string; decision: SectionApplicabilityDecision }[]): DecisionIndex {
  const index = new Map<string, Map<string, SectionApplicabilityDecision>>();
  for (const { documentId, decision } of applicability) {
    const inner = index.get(documentId) ?? new Map<string, SectionApplicabilityDecision>();
    inner.set(decision.sectionId, decision);
    index.set(documentId, inner);
  }
  return index;
}

function contractsByBlockId(): Map<string, AuthoredPromptContract> {
  const map = new Map<string, AuthoredPromptContract>();
  for (const c of [...PM_AUTHORED_BLOCKS, ...DEV_AUTHORED_BLOCKS]) map.set(c.blockId, c);
  return map;
}

describe("buildAuthoringRequests — one per authored block whose own slice resolves ≥1 fact", () => {
  it("emits requests only for grounded authored blocks, carrying the prompt, digest and facts", () => {
    const store = seedStore();
    for (const kind of ["error-handling", "data-access", "condition", "decision", "validation-rule", "transition"]) {
      insertBehaviorFact(store, { factId: `behavioral|${kind}|r1|handlers/leave/service.go:1|${kind}`, kind, relPath: "handlers/leave/service.go", startLine: 1 });
    }
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const request: readonly ReportTarget[] = [moduleTarget("leave", "product"), moduleTarget("leave", "developer")];
    const coverage = (target: ReportTarget, section: SectionDefinition): readonly KindCoverageInput[] =>
      section.inputFactKinds.map((kind) => ({ kind, coverage: coverageInputForKind(resolveKindCoverage(readers, target.scope, kind)) }));
    const executable = compileExecutablePlan({ request, snapshot, params, analysisRunId: "run-1", coverage });
    const decisions = decisionIndexOf(executable.applicability);

    const requests = buildAuthoringRequests(executable.plan, readers, decisions, contractsByBlockId());
    expect(requests.length).toBeGreaterThan(0);
    for (const req of requests) {
      expect(req.facts.length).toBeGreaterThanOrEqual(1);
      expect(req.prompt).toContain(req.digest.split("\n")[0]!); // the digest is embedded in the prompt
      expect(req.taskId.length).toBeGreaterThan(0);
      expect(req.documentId.includes("leave")).toBe(true);
    }
    // Deterministic — the same inputs give the same request set.
    const again = buildAuthoringRequests(executable.plan, readers, decisions, contractsByBlockId());
    expect(again.map((r) => r.taskId)).toEqual(requests.map((r) => r.taskId));
  });
});
