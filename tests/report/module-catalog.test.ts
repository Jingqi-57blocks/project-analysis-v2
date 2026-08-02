import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openKnowledgeBase } from "../../engine/kb/query.js";
import {
  classifyReportModules,
  productReportModules,
  reportableReportModules,
} from "../../engine/report/module-catalog.js";
import { SNAPSHOT_ID, seedStore } from "./helpers/seed-resolver-kb.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("reportableReportModules", () => {
  it("allows an explicitly requested aggregate with canonical membership without promoting it", () => {
    const input = {
      modules: [{
        id: "mod_application",
        name: "application",
        rootNames: ["svc"],
        entryKeys: ["POST /application", "POST /application/:id/approve"],
        endpoints: [],
        symbolCount: 4,
        dataEntities: ["application"],
        outboundTargets: [],
        groupingSignal: "entry points sharing application",
        evidence: [],
      }],
      components: [],
      externalSystems: [],
    };
    const artifact = {
      schemaVersion: "module-classification.v2" as const,
      sourceSnapshotId: "snapshot",
      candidateSetDigest: "digest",
      classifier: { executor: "test", model: "fake", contractVersion: "v1" },
      candidates: [{
        candidateId: "mod_application",
        classification: "aggregate-surface" as const,
        confidence: 0.9,
        reason: "unifies request types",
        evidenceRefs: ["fact:module:mod_application"],
        status: "classified" as const,
        displayName: "申请与审批中心",
        summary: "集中处理多类申请。",
        group: "员工服务",
        includedCandidateIds: [],
      }],
    };

    expect(productReportModules(artifact, input)).toEqual([]);
    expect(reportableReportModules(artifact, input)).toEqual([
      expect.objectContaining({ id: "mod_application", rawNames: ["application"] }),
    ]);
  });

  it("does not widen a product scope with unresolved or external candidates", () => {
    const module = (id: string, name: string) => ({
      id, name, rootNames: ["svc"], entryKeys: [`POST /${name}`], endpoints: [],
      symbolCount: 1, dataEntities: [], outboundTargets: [], groupingSignal: "entry", evidence: [],
    });
    const input = {
      modules: [module("canonical", "leave"), module("support", "leave-admin"), module("unknown", "holidayhour")],
      components: [],
      externalSystems: [],
    };
    const classified = (candidateId: string, classification: "product-module" | "technical-component" | "unresolved", status: "classified" | "unresolved", includedCandidateIds: string[] = []) => ({
      candidateId, classification, confidence: 0.9, reason: "evidence", evidenceRefs: [candidateId], status,
      displayName: candidateId, summary: candidateId, group: "group", includedCandidateIds,
    });
    const artifact = {
      schemaVersion: "module-classification.v2" as const,
      sourceSnapshotId: "snapshot",
      candidateSetDigest: "digest",
      classifier: { executor: "test", model: "fake", contractVersion: "v1" },
      candidates: [
        classified("canonical", "product-module", "classified", ["support", "unknown"]),
        classified("support", "technical-component", "classified"),
        classified("unknown", "unresolved", "unresolved"),
      ],
    };

    expect(productReportModules(artifact, input)[0]?.sourceCandidateIds).toEqual(["canonical", "support"]);
  });
});

describe("classifyReportModules", () => {
  it("classifies only formed modules and reuses the persisted bounded-list result", async () => {
    const store = seedStore();
    const module = {
      id: "mod_leave",
      name: "leaves",
      rootNames: ["r1"],
      entryKeys: ["POST /leaves"],
      endpoints: [{ method: "POST", path: "/leaves", rootName: "r1" }],
      symbolCount: 1,
      dataEntities: ["leaves"],
      outboundTargets: [],
      groupingSignal: "route-prefix",
      evidence: [],
    };
    store.run(
      "INSERT INTO derived_records (snapshot_id, kind, record_key, payload, subject_key, root_name) VALUES (?, 'module', ?, ?, ?, 'r1')",
      [SNAPSHOT_ID, module.id, JSON.stringify(module), module.id],
    );
    const kb = openKnowledgeBase(store);
    const runDir = mkdtempSync(join(tmpdir(), "pa-module-catalog-"));
    temporary.push(runDir);
    let calls = 0;
    const runner = async (request: { prompt: string }) => {
      calls += 1;
      const candidates = JSON.parse(request.prompt.split("Candidate input:\n").at(-1)!) as { candidateId: string; evidenceRefs: string[] }[];
      return { candidates: candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        classification: calls === 1 ? "unresolved" as const : "product-module" as const,
        confidence: 0.95,
        reason: "user entry and business object evidence",
        evidenceRefs: calls === 1 ? [] : ["behavioral|foreign|not-in-candidate"],
        displayName: "Leave 请假",
        summary: "员工提交并跟踪请假申请。",
        group: "员工自助",
        includedCandidateIds: [],
      })) };
    };
    const options = {
      store,
      kb,
      runDir,
      language: "zh-CN",
      agent: { executor: "test", model: "fake", reasoningEffort: "low" as const },
      run: runner,
    };
    const first = await classifyReportModules(options);
    const second = await classifyReportModules(options);
    const modules = productReportModules(first.artifact, first.input);

    expect(first.classifierCalls).toBe(2);
    expect(first.classifierInputBytes).toBeGreaterThan(0);
    expect(first.classifierNormalizations).toBe(1);
    expect(first.reused).toBe(false);
    expect(second.classifierCalls).toBe(0);
    expect(second.reused).toBe(true);
    expect(calls).toBe(2);
    expect(modules).toEqual([expect.objectContaining({ id: "mod_leave", displayName: "Leave 请假", rawNames: ["leaves"] })]);
    store.close();
  });
});
