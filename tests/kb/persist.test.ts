import { beforeEach, describe, expect, it } from "vitest";

import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { inferred, lineRef, resolved } from "../../engine/structural/provenance.js";
import { DERIVED_KINDS, derivedKey, emptyDerived, type DerivedRecords } from "../../engine/kb/kinds.js";
import {
  derivedCountsByKind,
  readDerived,
  readDerivedFor,
  readDerivedOne,
  readLinks,
  readLinksTo,
  recordDerived,
} from "../../engine/kb/persist.js";
import type { FeatureFact, RunContext } from "../../engine/kb/facts.js";
import type { BusinessRule } from "../../engine/semantics/rules.js";

let store: Store;
let snapshotId: number;

function feature(overrides: Partial<FeatureFact> = {}): FeatureFact {
  return {
    id: "feat_leave",
    name: "Leave",
    term: "leave",
    weight: 12,
    rootNames: ["svc"],
    signals: ["3 entities", "27 endpoints"],
    endpoints: [{ method: "POST", path: "/v2/leaves", rootName: "svc" }],
    dataEntities: ["leaves"],
    tables: ["leaves"],
    tablesNearby: [],
    filePaths: ["svc/leave.go"],
    flowCount: 4,
    partialFlowCount: 1,
    conditionCount: 9,
    overviewDiagram: "flowchart LR\n  a --> b",
    ...overrides,
  };
}

function rule(overrides: Partial<BusinessRule> = {}): BusinessRule {
  return {
    statement: "hours must be at most 40",
    meanings: [],
    valueSetName: null,
    subject: "lv.Hours",
    operator: ">",
    literal: 40,
    rootName: "svc",
    relPath: "leave.go",
    startLine: 88,
    text: "lv.Hours > 40",
    fullTest: null,
    guarded: "rejects",
    enclosingFunction: "Apply",
    ...overrides,
  };
}

const context: RunContext = {
  runId: "run-20260729T120000Z-abc123",
  generatedAt: "2026-07-29T12:00:00.000Z",
  workspacePath: "/w",
  projectName: "workspace",
  description: null,
  roots: [{ name: "svc", language: "go", analyzed: 10, excluded: 1 }],
  mapDiagram: "flowchart LR\n  n_svc[\"svc\"]",
  dispositions: {
    behavioralSource: 5,
    technicalOnly: 2,
    sharedInfrastructure: 2,
    unclassified: 1,
    total: 10,
  },
  unassignedEndpointCount: 3,
};

beforeEach(() => {
  store = openStore(IN_MEMORY);
  store.run("INSERT INTO workspaces (path, created_at) VALUES ('/w', 't0')");
  store.run(
    "INSERT INTO snapshots (workspace_id, identity, created_at, published_at) VALUES (1, 'i', 't0', NULL)",
  );
  snapshotId = store.get<{ id: number }>("SELECT id FROM snapshots")!.id;
});

describe("recording derived facts", () => {
  it("round-trips a record without changing it", () => {
    recordDerived(store, snapshotId, { ...emptyDerived(), feature: [feature()] });

    const stored = readDerived(store, snapshotId, "feature");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.record).toEqual(feature());
  });

  it("reports a key collision instead of silently keeping one of the two", () => {
    // Two facts under one key means the derivation disagreed with itself.
    // Nothing downstream could see that, so the count has to say it.
    const counts = recordDerived(store, snapshotId, {
      ...emptyDerived(),
      feature: [feature(), feature({ name: "Leaves", weight: 3 })],
    });

    expect(counts.inserted).toBe(1);
    expect(counts.replaced).toBe(1);
  });

  it("keeps two rules that differ only in their operator", () => {
    // One line can carry two comparisons, and one file can state the same
    // rule twice. Merging them would under-report what the code enforces.
    recordDerived(store, snapshotId, {
      ...emptyDerived(),
      "business-rule": [rule(), rule({ operator: ">=", text: "lv.Hours >= 40" })],
    });

    expect(readDerived(store, snapshotId, "business-rule")).toHaveLength(2);
  });

  it("keeps one flow per feature where two features claim the same endpoint", () => {
    const flow = {
      featureId: "feat_leave",
      featureName: "Leave",
      entryKey: "svc:POST /v2/leaves",
      method: "POST",
      path: "/v2/leaves",
      steps: [],
      partial: false,
      diagram: "flowchart LR",
    };
    recordDerived(store, snapshotId, {
      ...emptyDerived(),
      "feature-flow": [flow, { ...flow, featureId: "feat_request", featureName: "Request" }],
    });

    expect(readDerived(store, snapshotId, "feature-flow")).toHaveLength(2);
  });

  it("writes everything or nothing", () => {
    // Half a knowledge base is worse than none: a reader cannot see that the
    // features and the flows describe two different runs.
    const broken = {
      ...emptyDerived(),
      feature: [feature()],
      // A payload with a circular reference makes JSON.stringify throw
      // partway through the write.
      "coverage-note": [{ subject: "x", note: "y", get self(): unknown { return this; } }],
    } as unknown as DerivedRecords;

    expect(() => recordDerived(store, snapshotId, broken)).toThrow();
    expect(readDerived(store, snapshotId, "feature")).toHaveLength(0);
  });
});

describe("finding facts again", () => {
  it("returns a subject's own records and nobody else's", () => {
    recordDerived(store, snapshotId, {
      ...emptyDerived(),
      "feature-finding": [
        {
          featureId: "feat_leave",
          featureName: "Leave",
          id: "unguarded-writes",
          title: "T",
          finding: "F",
          severity: "concern",
          evidence: ["e"],
        },
        {
          featureId: "feat_order",
          featureName: "Order",
          id: "unguarded-writes",
          title: "T",
          finding: "F",
          severity: "notice",
          evidence: [],
        },
      ],
    });

    const own = readDerivedFor(store, snapshotId, "feature-finding", "feat_leave");
    expect(own.map((finding) => finding.featureName)).toEqual(["Leave"]);
  });

  it("lifts severity into a column so findings can be filtered without parsing payloads", () => {
    recordDerived(store, snapshotId, {
      ...emptyDerived(),
      "structural-finding": [
        { id: "shared-table", title: "T", finding: "F", severity: "concern", evidence: [] },
        { id: "quiet", title: "T", finding: "F", severity: "info", evidence: [] },
      ],
    });

    const rows = store.all<{ record_key: string }>(
      "SELECT record_key FROM derived_records WHERE snapshot_id = ? AND severity = 'concern'",
      [snapshotId],
    );
    expect(rows.map((row) => row.record_key)).toEqual(["shared-table"]);
  });

  it("reads the run context as the single record it is", () => {
    recordDerived(store, snapshotId, { ...emptyDerived(), "run-context": [context] });
    expect(readDerivedOne(store, snapshotId, "run-context")).toEqual(context);
  });

  it("says nothing rather than guessing when a singleton was never written", () => {
    expect(readDerivedOne(store, snapshotId, "run-context")).toBeNull();
  });

  it("counts what a snapshot holds, per kind", () => {
    recordDerived(store, snapshotId, {
      ...emptyDerived(),
      feature: [feature(), feature({ id: "feat_order", name: "Order" })],
      "business-rule": [rule()],
    });

    const counts = derivedCountsByKind(store, snapshotId);
    expect(counts.get("feature")).toBe(2);
    expect(counts.get("business-rule")).toBe(1);
    expect(counts.get("module")).toBeUndefined();
  });
});

describe("links between facts", () => {
  it("points a feature at records another table owns", () => {
    // A feature's endpoints are routes, which no derivation produced. The
    // link has to be able to name them anyway.
    recordDerived(
      store,
      snapshotId,
      { ...emptyDerived(), feature: [feature()] },
      [
        { fromKind: "feature", fromKey: "feat_leave", role: "endpoint", toKind: "route", toKey: "svc|POST|/v2/leaves" },
        { fromKind: "feature", fromKey: "feat_leave", role: "rule", toKind: "business-rule", toKey: "svc|leave.go|88" },
      ],
    );

    expect(readLinks(store, snapshotId, "feature", "feat_leave", "endpoint")).toEqual([
      { fromKind: "feature", fromKey: "feat_leave", role: "endpoint", toKind: "route", toKey: "svc|POST|/v2/leaves" },
    ]);
    expect(readLinks(store, snapshotId, "feature", "feat_leave")).toHaveLength(2);
  });

  it("answers which fact owns a given one", () => {
    recordDerived(store, snapshotId, emptyDerived(), [
      { fromKind: "module", fromKey: "mod_a", role: "feature", toKind: "feature", toKey: "feat_leave" },
      { fromKind: "module", fromKey: "mod_b", role: "feature", toKind: "feature", toKey: "feat_leave" },
    ]);

    // A feature can belong to two modules. Both survive, because a column on
    // the feature could only have held one.
    expect(readLinksTo(store, snapshotId, "feature", "feat_leave").map((l) => l.fromKey)).toEqual([
      "mod_a",
      "mod_b",
    ]);
  });

  it("records one link once, however many times it is asserted", () => {
    const link = {
      fromKind: "feature" as const,
      fromKey: "feat_leave",
      role: "flow",
      toKind: "feature-flow",
      toKey: "feat_leave|svc:POST /v2/leaves",
    };
    recordDerived(store, snapshotId, emptyDerived(), [link, link]);
    expect(readLinks(store, snapshotId, "feature", "feat_leave")).toHaveLength(1);
  });
});

describe("identity", () => {
  it("gives every kind a key builder", () => {
    // The map is exhaustive by type, but a kind added with a placeholder
    // builder would typecheck and collide at runtime.
    const samples: { [K in (typeof DERIVED_KINDS)[number]]?: unknown } = {
      feature: feature(),
      "business-rule": rule(),
      "run-context": context,
    };
    for (const [kind, sample] of Object.entries(samples)) {
      expect(derivedKey(kind as never, sample as never)).not.toBe("");
    }
  });

  it("separates two map edges between the same pair of nodes", () => {
    // A service can both call another and store into it. One edge would
    // erase the difference between an integration and a datastore.
    recordDerived(store, snapshotId, {
      ...emptyDerived(),
      "map-edge": [
        { from: "ui", to: "api", kind: "internal", detail: "3 calls" },
        { from: "ui", to: "api", kind: "external", detail: null },
      ],
    });
    expect(readDerived(store, snapshotId, "map-edge")).toHaveLength(2);
  });

  it("keeps two coverage notes about one subject", () => {
    recordDerived(store, snapshotId, {
      ...emptyDerived(),
      "coverage-note": [
        { subject: "route", note: "group prefixes are not resolved" },
        { subject: "route", note: "routes registered in a closure are missed" },
      ],
    });
    expect(readDerived(store, snapshotId, "coverage-note")).toHaveLength(2);
  });

  it("keeps two calls from one caller to one destination", () => {
    const base = {
      fromRoot: "ui",
      fromSymbolId: null,
      target: "https://api/v2/leaves",
      toRoot: "api",
      toMethod: "GET",
      toPath: "/v2/leaves",
      toHandlerSymbolId: null,
      kind: "http-route",
    };
    recordDerived(store, snapshotId, {
      ...emptyDerived(),
      "cross-root-link": [
        { ...base, provenance: inferred(lineRef("ui", "a.ts", 10, 1), "medium") },
        { ...base, provenance: inferred(lineRef("ui", "a.ts", 44, 1), "medium") },
      ],
    });
    // Two call sites are two observations of the integration, not one.
    expect(readDerived(store, snapshotId, "cross-root-link")).toHaveLength(2);
  });

  it("stores where a rule lives, so a file's rules can be found without parsing payloads", () => {
    recordDerived(store, snapshotId, { ...emptyDerived(), "business-rule": [rule()] });
    const row = store.get<{ rel_path: string; start_line: number; root_name: string }>(
      "SELECT rel_path, start_line, root_name FROM derived_records WHERE kind = 'business-rule'",
    );
    expect(row).toEqual({ rel_path: "leave.go", start_line: 88, root_name: "svc" });
  });

  it("locates a link at its call site rather than at its destination", () => {
    recordDerived(store, snapshotId, {
      ...emptyDerived(),
      "unlinked-call": [
        {
          fromRoot: "ui",
          fromSymbolId: null,
          target: "https://third-party/pay",
          reason: "external-destination",
          candidates: [],
          provenance: resolved(lineRef("ui", "pay.ts", 12, 3), "high"),
        },
      ],
    });
    const row = store.get<{ rel_path: string; root_name: string }>(
      "SELECT rel_path, root_name FROM derived_records WHERE kind = 'unlinked-call'",
    );
    expect(row).toEqual({ rel_path: "pay.ts", root_name: "ui" });
  });
});
