import { describe, expect, it } from "vitest";

import { moduleScope, PROJECT_SCOPE } from "../../engine/contracts/report/target.js";
import {
  coverageInputForKind,
  createSliceReaders,
  readerClassOf,
  resolveModuleMembershipForModules,
  resolveKindCoverage,
  resolveSliceFacts,
} from "../../engine/report/slice-resolve.js";
import type { KnowledgeBase } from "../../engine/kb/query.js";
import { classifyCoverage } from "../../engine/contracts/shared-fact/applicability.js";
import { SNAPSHOT_ID, insertBehaviorFact, insertStructuralRecord, membershipOf, seedStore } from "./helpers/seed-resolver-kb.js";

const IN_MODULE = ["handlers/leave/notification.go", "handlers/leave/service.go"];
const OUT_OF_MODULE = "handlers/payroll/service.go";

/** A KB with 8 in-module notification facts, 2 out-of-module, plus a few others. */
function seedNotificationKb() {
  const store = seedStore();
  for (let i = 0; i < 8; i += 1) {
    insertBehaviorFact(store, {
      factId: `behavioral|notification-call|r1|handlers/leave/notification.go:${100 + i}|n${i}`,
      kind: "notification-call",
      relPath: "handlers/leave/notification.go",
      startLine: 100 + i,
      resolutionClass: "inferred",
      payload: { scope: "module", activation: "always", channel: "mail", mechanism: `send-${i}` },
    });
  }
  // Two notification facts outside the module — must be filtered out.
  for (let i = 0; i < 2; i += 1) {
    insertBehaviorFact(store, {
      factId: `behavioral|notification-call|r1|handlers/payroll/service.go:${200 + i}|p${i}`,
      kind: "notification-call",
      relPath: OUT_OF_MODULE,
      startLine: 200 + i,
    });
  }
  return store;
}

describe("resolveSliceFacts — behaviour kinds via the behaviour query, scoped by membership", () => {
  it("resolves the 8 populated in-module notification facts, cited and sorted, and drops the out-of-module ones", () => {
    const store = seedNotificationKb();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const facts = resolveSliceFacts(readers, moduleScope("leave"), ["notification-call"]);

    expect(facts).toHaveLength(8);
    expect(facts.every((f) => f.kind === "notification-call")).toBe(true);
    expect(facts.every((f) => f.citation.relPath === "handlers/leave/notification.go")).toBe(true);
    // Every cited fact carries an id, a verbatim value and a resolution class.
    const first = facts[0]!;
    expect(first.factId).toContain("notification-call");
    expect(first.resolutionClass).toBe("inferred");
    expect(first.value).toMatchObject({ mechanism: expect.any(String) });
    // Stable order — sorted by fact id.
    const ids = facts.map((f) => f.factId);
    expect(ids).toEqual([...ids].sort());
  });

  it("maps the catalog `state-transition` kind onto the behaviour model's `transition` facts", () => {
    const store = seedStore();
    const transitionId = "behavioral|transition|r1|handlers/leave/service.go:10|t1";
    const pendingId = "behavioral|state|r1|handlers/leave/service.go:8|pending";
    const approvedId = "behavioral|state|r1|handlers/leave/service.go:9|approved";
    insertBehaviorFact(store, {
      factId: transitionId,
      kind: "transition",
      relPath: "handlers/leave/service.go",
      startLine: 10,
      payload: { field: "status", trigger: "Approve" },
    });
    insertBehaviorFact(store, {
      factId: pendingId,
      kind: "state",
      relPath: "handlers/leave/service.go",
      startLine: 8,
      payload: { label: "Pending", value: 0, valueSet: "LeaveStatus" },
    });
    insertBehaviorFact(store, {
      factId: approvedId,
      kind: "state",
      relPath: "handlers/leave/service.go",
      startLine: 9,
      payload: { label: "Approved", value: 1, valueSet: "LeaveStatus" },
    });
    store.run(
      "INSERT INTO behavior_relations (snapshot_id, kind, from_id, to_id, role) VALUES (?, 'transition-endpoint', ?, ?, 'from-state')",
      [SNAPSHOT_ID, transitionId, pendingId],
    );
    store.run(
      "INSERT INTO behavior_relations (snapshot_id, kind, from_id, to_id, role) VALUES (?, 'transition-endpoint', ?, ?, 'to-state')",
      [SNAPSHOT_ID, transitionId, approvedId],
    );
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const facts = resolveSliceFacts(readers, moduleScope("leave"), ["state-transition"]);
    expect(facts).toHaveLength(1);
    // The cited fact keeps the slice's declared kind, so it stays inside the slice.
    expect(facts[0]!.kind).toBe("state-transition");
    expect(facts[0]!.value).toMatchObject({
      field: "status",
      trigger: "Approve",
      fromFactId: pendingId,
      toFactId: approvedId,
      from: { label: "Pending", value: 0, valueSet: "LeaveStatus" },
      to: { label: "Approved", value: 1, valueSet: "LeaveStatus" },
    });
  });

  it("resolves a structural kind from the structural records, scoped by rel path", () => {
    const store = seedStore();
    insertStructuralRecord(store, { recordKey: "r1|handlers/leave/service.go|func|Apply", kind: "symbol", relPath: "handlers/leave/service.go", startLine: 5 });
    insertStructuralRecord(store, { recordKey: "r1|handlers/payroll/service.go|func|Pay", kind: "symbol", relPath: OUT_OF_MODULE, startLine: 5 });
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const facts = resolveSliceFacts(readers, moduleScope("leave"), ["symbol"]);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.factId).toContain("handlers/leave/service.go");
    expect(facts[0]!.citation.startLine).toBe(5);
  });

  it("keeps shared router files narrow by exact entry identity", () => {
    const store = seedStore();
    const shared = "handlers/handlers.go";
    insertStructuralRecord(store, {
      recordKey: "leave-route",
      kind: "route",
      relPath: shared,
      startLine: 10,
      payload: { rootName: "r1", method: "POST", path: "/leaves", provenance: { source: { rootName: "r1", relPath: shared, startLine: 10, endLine: 10, startColumn: null, endColumn: null } } },
    });
    insertStructuralRecord(store, {
      recordKey: "payroll-route",
      kind: "route",
      relPath: shared,
      startLine: 20,
      payload: { rootName: "r1", method: "POST", path: "/payroll", provenance: { source: { rootName: "r1", relPath: shared, startLine: 20, endLine: 20, startColumn: null, endColumn: null } } },
    });
    const membership = { ...membershipOf("leave", [shared]), entryKeys: new Set(["r1:POST /leaves"]), coreEntryKeys: new Set(["r1:POST /leaves"]) };
    const facts = resolveSliceFacts(createSliceReaders(store, SNAPSHOT_ID, membership), moduleScope("leave"), ["route"]);
    expect(facts.map((fact) => (fact.value as { path: string }).path)).toEqual(["/leaves"]);
  });

  it("scopes derived flows by formed entry key, not only their shared registration file", () => {
    const store = seedStore();
    const shared = "handlers/handlers.go";
    const flow = (entryKey: string, line: number) => ({
      featureId: "feat_shared",
      featureName: "Shared",
      entryKey,
      steps: [{ provenance: { source: { rootName: "r1", relPath: shared, startLine: line, endLine: line, startColumn: null, endColumn: null } } }],
      diagram: "flowchart LR",
    });
    store.run("INSERT INTO derived_records (snapshot_id, kind, record_key, payload, subject_key) VALUES (?, 'feature-flow', ?, ?, 'feat_shared')", [SNAPSHOT_ID, "leave-flow", JSON.stringify(flow("r1:POST /leaves", 10))]);
    store.run("INSERT INTO derived_records (snapshot_id, kind, record_key, payload, subject_key) VALUES (?, 'feature-flow', ?, ?, 'feat_shared')", [SNAPSHOT_ID, "payroll-flow", JSON.stringify(flow("r1:POST /payroll", 20))]);
    const membership = { ...membershipOf("leave", [shared]), entryKeys: new Set(["r1:POST /leaves"]), coreEntryKeys: new Set(["r1:POST /leaves"]), featureIds: new Set(["feat_shared"]) };
    const facts = resolveSliceFacts(createSliceReaders(store, SNAPSHOT_ID, membership), moduleScope("leave"), ["feature-flow"]);
    expect(facts).toHaveLength(1);
    expect((facts[0]!.value as { entryKey: string }).entryKey).toBe("r1:POST /leaves");
  });

  it("marks an expanded entry as supporting even when its caller is a core UI file", () => {
    const store = seedStore();
    const shared = "pages/leave/Leave.tsx";
    const flow = (entryKey: string, line: number) => ({
      featureId: "feat_shared",
      featureName: "Shared page calls",
      entryKey,
      steps: [{ provenance: { source: { rootName: "r1", relPath: shared, startLine: line, endLine: line, startColumn: null, endColumn: null } } }],
      diagram: "flowchart LR",
    });
    store.run("INSERT INTO derived_records (snapshot_id, kind, record_key, payload, subject_key) VALUES (?, 'feature-flow', ?, ?, 'feat_shared')", [SNAPSHOT_ID, "leave-flow", JSON.stringify(flow("r1:POST /leaves", 10))]);
    store.run("INSERT INTO derived_records (snapshot_id, kind, record_key, payload, subject_key) VALUES (?, 'feature-flow', ?, ?, 'feat_shared')", [SNAPSHOT_ID, "token-flow", JSON.stringify(flow("r1:POST /tokens", 20))]);
    const membership = {
      ...membershipOf("leave", [shared]),
      entryKeys: new Set(["r1:POST /leaves", "r1:POST /tokens"]),
      coreEntryKeys: new Set(["r1:POST /leaves"]),
      featureIds: new Set(["feat_shared"]),
      coreFiles: new Set([`r1/${shared}`]),
    };

    const facts = resolveSliceFacts(createSliceReaders(store, SNAPSHOT_ID, membership), moduleScope("leave"), ["feature-flow"]);
    expect(facts.map((fact) => [
      (fact.value as { entryKey: string }).entryKey,
      fact.scopeRole,
      (fact.value as { reportScopeRole: string }).reportScopeRole,
    ])).toEqual([
      ["r1:POST /leaves", "core", "core"],
      ["r1:POST /tokens", "supporting", "supporting"],
    ]);
  });

  it("returns an empty slice for a kind with no facts in the module, never a fabricated one", () => {
    const store = seedNotificationKb();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    expect(resolveSliceFacts(readers, moduleScope("leave"), ["outbound-call"])).toEqual([]);
  });

  it("resolves nothing for a scope that is not this membership's module", () => {
    const store = seedNotificationKb();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    expect(resolveSliceFacts(readers, moduleScope("payroll"), ["notification-call"])).toEqual([]);
  });

  it("does not apply one module's file filter to a project-scoped slice", () => {
    const store = seedNotificationKb();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const facts = resolveSliceFacts(readers, PROJECT_SCOPE, ["notification-call"]);
    expect(facts).toHaveLength(10);
    expect(facts.some((fact) => fact.citation.relPath === OUT_OF_MODULE)).toBe(true);
  });

  it("resolves several module memberships from one frozen reader set", () => {
    const store = seedNotificationKb();
    const readers = createSliceReaders(store, SNAPSHOT_ID, [
      membershipOf("leave", IN_MODULE),
      membershipOf("payroll", [OUT_OF_MODULE]),
    ]);
    expect(resolveSliceFacts(readers, moduleScope("leave"), ["notification-call"])).toHaveLength(8);
    expect(resolveSliceFacts(readers, moduleScope("payroll"), ["notification-call"])).toHaveLength(2);
  });

  it("is deterministic — two resolutions of one frozen KB are identical", () => {
    const store = seedNotificationKb();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const a = resolveSliceFacts(readers, moduleScope("leave"), ["notification-call"]);
    const b = resolveSliceFacts(readers, moduleScope("leave"), ["notification-call"]);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe("resolveModuleMembershipForModules — bounded cross-root surface closure", () => {
  it("omits caller-unresolved legacy entries when an observed replacement exists", () => {
    const source = (rootName: string, relPath: string, line: number) => ({
      resolutionClass: "declared" as const,
      source: { rootName, relPath, startLine: line, endLine: line, startColumn: null, endColumn: null },
    });
    const currentFlow = {
      entryKey: "api-v2:POST /v2/leaves",
      steps: [
        { provenance: source("ui", "src/pages/leave/ApplyLeave.tsx", 20) },
        { provenance: source("api-v2", "handlers/leave/service.go", 40) },
      ],
    };
    const legacyFlow = {
      entryKey: "api-v1:POST /leaves",
      steps: [
        { provenance: null },
        { provenance: source("api-v1", "routes/leave.js", 60) },
      ],
    };
    const feature = {
      id: "feat_leave",
      filePaths: [
        "ui/src/pages/leave/ApplyLeave.tsx",
        "api-v2/handlers/leave/service.go",
        "api-v1/routes/leave.js",
      ],
    };
    const fake = {
      modules: () => [{
        id: "mod_leave",
        name: "leave",
        entryKeys: [currentFlow.entryKey, legacyFlow.entryKey],
      }],
      moduleDetail: () => ({ features: [feature] }),
      flowsForFeature: () => [currentFlow, legacyFlow],
      features: () => [feature],
      crossRootLinks: () => [],
      callEdges: () => [],
      symbols: () => [],
      endpoints: () => [],
      scheduledTasks: () => [],
      dataAccess: () => [],
    } as unknown as KnowledgeBase;

    const membership = resolveModuleMembershipForModules(fake, "leave", ["mod_leave"], {
      preferObservedEntries: true,
    });

    expect([...membership.entryKeys]).toEqual([currentFlow.entryKey]);
    expect(membership.files).toContain("ui/src/pages/leave/ApplyLeave.tsx");
    expect(membership.files).toContain("api-v2/handlers/leave/service.go");
    expect(membership.files).not.toContain("api-v1/routes/leave.js");
  });

  it("omits an unresolved legacy candidate when its merged canonical module has an observed surface", () => {
    const source = (rootName: string, relPath: string, line: number) => ({
      resolutionClass: "declared" as const,
      source: { rootName, relPath, startLine: line, endLine: line, startColumn: null, endColumn: null },
    });
    const currentFlow = {
      entryKey: "api-v2:POST /worklogs",
      steps: [
        { provenance: source("ui", "src/pages/worklog/Worklog.tsx", 20) },
        { provenance: source("api-v2", "handlers/worklogs/service.go", 40) },
      ],
    };
    const legacyFlow = {
      entryKey: "api-v1:GET /wlog/:projectKey",
      steps: [
        { provenance: null },
        { provenance: source("api-v1", "handlers/wlog/export.go", 60) },
      ],
    };
    const currentFeature = { id: "feat_worklogs", filePaths: ["ui/src/pages/worklog/Worklog.tsx", "api-v2/handlers/worklogs/service.go"] };
    const legacyFeature = { id: "feat_wlog", filePaths: ["api-v1/handlers/wlog/export.go"] };
    const fake = {
      modules: () => [
        { id: "mod_worklogs", name: "worklogs", entryKeys: [currentFlow.entryKey] },
        { id: "mod_wlog", name: "wlog", entryKeys: [legacyFlow.entryKey] },
      ],
      moduleDetail: (id: string) => ({ features: [id === "mod_worklogs" ? currentFeature : legacyFeature] }),
      flowsForFeature: (id: string) => id === currentFeature.id ? [currentFlow] : [legacyFlow],
      features: () => [currentFeature, legacyFeature],
      crossRootLinks: () => [],
      callEdges: () => [],
      symbols: () => [],
      endpoints: () => [],
      scheduledTasks: () => [],
      dataAccess: () => [],
    } as unknown as KnowledgeBase;

    const membership = resolveModuleMembershipForModules(fake, "worklog", ["mod_worklogs", "mod_wlog"], {
      preferObservedEntries: true,
    });

    expect([...membership.entryKeys]).toEqual([currentFlow.entryKey]);
    expect(membership.files).toContain("ui/src/pages/worklog/Worklog.tsx");
    expect(membership.files).not.toContain("api-v1/handlers/wlog/export.go");
  });

  it("adds only the concrete backend entry reached through an owned UI helper", () => {
    const source = (rootName: string, relPath: string, line: number) => ({
      resolutionClass: "declared" as const,
      source: { rootName, relPath, startLine: line, endLine: line, startColumn: null, endColumn: null },
    });
    const worklogFeature = {
      id: "feat_worklog",
      filePaths: ["ui/src/pages/worklog/Worklog.tsx"],
    };
    const clockFlow = {
      entryKey: "api:GET /v2/support/entry-records",
      steps: [
        { provenance: source("ui", "src/api/clockInApi.ts", 21) },
        { provenance: source("api", "internal/handlers/support/entry_records.go", 101) },
      ],
    };
    const helperId = "ui|src/api/clockInApi.ts|function|getClockInRecords|";
    const fake = {
      modules: () => [{ id: "mod_worklog", name: "worklogs", entryKeys: ["api:GET /worklogs"] }],
      moduleDetail: () => ({ features: [worklogFeature] }),
      features: () => [worklogFeature, { id: "feat_support", filePaths: [] }],
      flowsForFeature: (id: string) => id === "feat_support" ? [clockFlow] : [],
      crossRootLinks: () => [{
        fromRoot: "ui",
        fromSymbolId: null,
        target: "/v2/support/entry-records",
        toRoot: "api",
        toMethod: "GET",
        toPath: "/v2/support/entry-records",
        toHandlerSymbolId: null,
        kind: "http-route",
        provenance: source("ui", "src/api/clockInApi.ts", 21),
      }],
      symbols: () => [{ id: helperId, provenance: source("ui", "src/api/clockInApi.ts", 17) }],
      callEdges: () => [{
        callerId: "ui|src/pages/worklog/Worklog.tsx|function|Worklog|",
        calleeId: helperId,
        calleeName: "getClockInRecords",
        provenance: source("ui", "src/pages/worklog/Worklog.tsx", 111),
      }],
      endpoints: () => [{
        rootName: "api",
        method: "GET",
        path: "/v2/support/entry-records",
        provenance: source("api", "internal/handlers/handlers.go", 88),
      }],
    } as unknown as KnowledgeBase;

    const membership = resolveModuleMembershipForModules(fake, "worklog", ["mod_worklog"], {
      expandObservedSurface: true,
    });

    expect([...membership.entryKeys]).toEqual([
      "api:GET /worklogs",
      "api:GET /v2/support/entry-records",
    ]);
    expect(membership.featureIds).toContain("feat_support");
    expect(membership.files).toEqual(new Set([
      "ui/src/pages/worklog/Worklog.tsx",
      "ui/src/api/clockInApi.ts",
      "api/internal/handlers/support/entry_records.go",
      "api/internal/handlers/handlers.go",
    ]));
  });

  it("does not treat a same-named symbol in another root as a helper call", () => {
    const source = (rootName: string, relPath: string, line: number) => ({
      resolutionClass: "declared" as const,
      source: { rootName, relPath, startLine: line, endLine: line, startColumn: null, endColumn: null },
    });
    const feature = { id: "feat_application", filePaths: ["api/handlers/application/service.go"] };
    const foreignHelper = "ui|src/api/reviewApi.ts|function|Group|";
    const fake = {
      modules: () => [{ id: "mod_application", name: "application", entryKeys: ["api:POST /applications"] }],
      moduleDetail: () => ({ features: [feature] }),
      features: () => [feature, { id: "feat_review", filePaths: [] }],
      flowsForFeature: () => [],
      crossRootLinks: () => [{
        fromRoot: "ui",
        fromSymbolId: foreignHelper,
        target: "/reviews",
        toRoot: "review",
        toMethod: "GET",
        toPath: "/reviews",
        toHandlerSymbolId: null,
        kind: "http-route",
        provenance: source("ui", "src/api/reviewApi.ts", 12),
      }],
      symbols: () => [{ id: foreignHelper, provenance: source("ui", "src/api/reviewApi.ts", 10) }],
      callEdges: () => [{
        callerId: "api|handlers/application/service.go|method|Exporter::Group|",
        calleeId: foreignHelper,
        calleeName: "Group",
        provenance: source("api", "handlers/application/service.go", 30),
      }],
      endpoints: () => [],
    } as unknown as KnowledgeBase;

    const membership = resolveModuleMembershipForModules(fake, "application", ["mod_application"], {
      expandObservedSurface: true,
    });

    expect(membership.files).not.toContain("ui/src/api/reviewApi.ts");
    expect(membership.entryKeys).not.toContain("review:GET /reviews");
  });

  it("lets another classified boundary exclude ambiguous sibling entries and filename-only feature files", () => {
    const source = (rootName: string, relPath: string, line: number) => ({
      resolutionClass: "declared" as const,
      source: { rootName, relPath, startLine: line, endLine: line, startColumn: null, endColumn: null },
    });
    const applicationFlow = {
      entryKey: "api:POST /applications",
      steps: [{ provenance: source("api", "handlers/application/service.go", 20) }],
    };
    const promotionFlow = {
      entryKey: "review:POST /promotions/:id/application",
      steps: [{ provenance: source("review", "handlers/promotion/application_state.go", 40) }],
    };
    const feature = {
      id: "feat_application",
      filePaths: [
        "ui/pages/application/Form.tsx",
        "ui/pages/promotion-review/ViewApplicationModal.tsx",
        "review/handlers/promotion/application_state.go",
      ],
    };
    const fake = {
      modules: () => [{
        id: "mod_application",
        name: "application",
        entryKeys: [applicationFlow.entryKey, promotionFlow.entryKey],
      }],
      moduleDetail: () => ({ features: [feature] }),
      flowsForFeature: () => [applicationFlow, promotionFlow],
      features: () => [feature],
      crossRootLinks: () => [],
      callEdges: () => [],
      symbols: () => [],
      endpoints: () => [],
    } as unknown as KnowledgeBase;

    const membership = resolveModuleMembershipForModules(fake, "application", ["mod_application"], {
      expandObservedSurface: true,
      excludedEntryKeys: new Set([promotionFlow.entryKey]),
    });

    expect([...membership.coreEntryKeys]).toEqual([applicationFlow.entryKey]);
    expect(membership.files).toContain("api/handlers/application/service.go");
    expect(membership.files).toContain("ui/pages/application/Form.tsx");
    expect(membership.files).not.toContain("review/handlers/promotion/application_state.go");
    expect(membership.files).not.toContain("ui/pages/promotion-review/ViewApplicationModal.tsx");
  });

  it("includes a scheduled lifecycle writer only through a module-named owned table", () => {
    const source = (rootName: string, relPath: string, line: number) => ({
      resolutionClass: "declared" as const,
      source: { rootName, relPath, startLine: line, endLine: line, startColumn: null, endColumn: null },
    });
    const feature = { id: "feat_leave", filePaths: ["api/handlers/leave/service.go"] };
    const fake = {
      modules: () => [{ id: "mod_leave", name: "leaves", entryKeys: ["api:POST /leaves"] }],
      moduleDetail: () => ({ features: [feature] }),
      features: () => [feature],
      flowsForFeature: () => [],
      crossRootLinks: () => [],
      callEdges: () => [],
      symbols: () => [],
      endpoints: () => [],
      scheduledTasks: () => [
        { rootName: "api", source: source("api", "cron/lifecycle.go", 10).source },
        { rootName: "api", source: source("api", "cron/unrelated.go", 10).source },
      ],
      dataAccess: () => [
        { rootName: "api", entity: "wcp_leave", operation: "write", mechanism: "orm", symbolId: null, provenance: source("api", "handlers/leave/service.go", 20) },
        { rootName: "api", entity: "wcp_leave", operation: "write", mechanism: "orm", symbolId: null, provenance: source("api", "cron/lifecycle.go", 30) },
        { rootName: "api", entity: "wcp_user", operation: "write", mechanism: "orm", symbolId: null, provenance: source("api", "cron/unrelated.go", 30) },
      ],
    } as unknown as KnowledgeBase;

    const membership = resolveModuleMembershipForModules(fake, "leave", ["mod_leave"], {
      expandObservedSurface: true,
    });

    expect(membership.files).toContain("api/cron/lifecycle.go");
    expect(membership.files).not.toContain("api/cron/unrelated.go");
    expect(membership.coreFiles).not.toContain("api/cron/lifecycle.go");
  });
});

describe("coverageInputForKind — honest per-kind coverage for the applicability compiler", () => {
  it("a behaviour kind with facts is found, and with none is not-found", () => {
    const store = seedNotificationKb();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const found = coverageInputForKind(resolveKindCoverage(readers, moduleScope("leave"), "notification-call"));
    const empty = coverageInputForKind(resolveKindCoverage(readers, moduleScope("leave"), "outbound-call"));
    expect(classifyCoverage(found).state).toBe("found");
    expect(classifyCoverage(empty).state).toBe("not-found");
  });

  it("an unresolved module scope (kbModuleId null) is unknown, never a false 'found none'", () => {
    const store = seedNotificationKb();
    // A module id the module model never surfaced: no module to have found none in.
    const unresolved = { moduleId: "order", kbModuleId: null, kbModuleName: null, rawModuleIds: new Set<string>(), entryKeys: new Set<string>(), coreEntryKeys: new Set<string>(), coreFiles: new Set<string>(), featureIds: new Set<string>(), files: new Set<string>(), fileCount: 0 };
    const readers = createSliceReaders(store, SNAPSHOT_ID, unresolved);
    for (const kind of ["notification-call", "outbound-call", "route", "entity"]) {
      const result = resolveKindCoverage(readers, moduleScope("order"), kind);
      expect(result.scopeResolved).toBe(false);
      expect(classifyCoverage(coverageInputForKind(result)).state).toBe("unknown");
    }
    // A resolved module with genuinely none stays not-found — the distinction holds.
    const resolved = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    expect(classifyCoverage(coverageInputForKind(resolveKindCoverage(resolved, moduleScope("leave"), "outbound-call"))).state).toBe("not-found");
  });

  it("a resolved module bound to no file (endpoint-only) is unknown, never a false 'found none'", () => {
    const store = seedNotificationKb();
    // The module model surfaced this module, but bound it to no analyzed file — an
    // endpoint-only module whose handlers never resolved to a file. As with an
    // unresolved id, there is no code to have found none in.
    const emptyMembership = {
      moduleId: "maps",
      kbModuleId: "mod_maps",
      kbModuleName: "maps",
      rawModuleIds: new Set(["mod_maps"]),
      entryKeys: new Set<string>(),
      coreEntryKeys: new Set<string>(),
      coreFiles: new Set<string>(),
      featureIds: new Set<string>(),
      files: new Set<string>(),
      fileCount: 0,
    };
    const readers = createSliceReaders(store, SNAPSHOT_ID, emptyMembership);
    for (const kind of ["notification-call", "outbound-call", "route", "entity"]) {
      const result = resolveKindCoverage(readers, moduleScope("maps"), kind);
      expect(result.scopeResolved).toBe(false);
      expect(classifyCoverage(coverageInputForKind(result)).state).toBe("unknown");
    }
  });

  it("a kind this resolver cannot read is unknown, never a confirmed absence", () => {
    const store = seedStore();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    expect(readerClassOf("mystery-fact")).toBe("none");
    expect(classifyCoverage(coverageInputForKind(resolveKindCoverage(readers, moduleScope("leave"), "mystery-fact"))).state).toBe("unknown");
  });

  it("a module with no attributed diagnostics is unknown, not not-found", () => {
    const store = seedStore();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    expect(classifyCoverage(coverageInputForKind(resolveKindCoverage(readers, moduleScope("leave"), "diagnostic"))).state).toBe("unknown");
  });

  it("the `*` fact ledger is found when it resolves facts", () => {
    const store = seedNotificationKb();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    expect(classifyCoverage(coverageInputForKind(resolveKindCoverage(readers, moduleScope("leave"), "*"))).state).toBe("found");
  });

  it("identity and coverage resolve no cited facts in this pass and are unknown — never a fiat 'evidence present'", () => {
    const store = seedNotificationKb();
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    for (const kind of ["run-identity", "scope-identity", "coverage", "gap"]) {
      const result = resolveKindCoverage(readers, moduleScope("leave"), kind);
      expect(result.count).toBe(0);
      expect(classifyCoverage(coverageInputForKind(result)).state).toBe("unknown");
    }
  });
});
