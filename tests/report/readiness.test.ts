import { beforeEach, describe, expect, it } from "vitest";

import { explainReadiness, reportReadiness } from "../../engine/report/readiness.js";
import { auditReport } from "../../engine/report/kb-audit.js";
import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";

let store: Store;

beforeEach(() => {
  store = openStore(IN_MEMORY);
  store.run("INSERT INTO workspaces (path, created_at) VALUES ('/w', 't')");
  store.run("INSERT INTO snapshots (workspace_id, identity, created_at) VALUES (1, 'i', 't')");
  store.run("INSERT INTO source_roots (snapshot_id, name, path, content_digest) VALUES (1, 'r', '/r', 'd')");
});

function record(kind: string, key: string): void {
  store.run(
    "INSERT INTO structural_records (snapshot_id, source_root_id, record_key, kind, payload, resolution_class) VALUES (1, 1, ?, ?, '{}', 'declared')",
    [key, kind],
  );
}

function behaviorFact(id: string): void {
  store.run(
    "INSERT INTO behavior_facts (snapshot_id, fact_id, kind, family, schema_version, payload) VALUES (1, ?, 'guard', 'rule', '1', '{}')",
    [id],
  );
}

function complete(): void {
  record("call-edge", "e1");
  record("route", "r1");
  record("data-access", "d1");
  behaviorFact("b1");
}

describe("what a capability report cannot be written without", () => {
  it("is ready when the snapshot holds all four", () => {
    complete();
    expect(reportReadiness(store, 1, "feature-product").ready).toBe(true);
  });

  it("is not ready with no call graph, which is what a missing indexer leaves", () => {
    record("route", "r1");
    record("data-access", "d1");
    behaviorFact("b1");

    const readiness = reportReadiness(store, 1, "feature-product");
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toEqual(["call-edge"]);
  });

  it("names every missing kind, not the first", () => {
    expect(reportReadiness(store, 1, "feature-product").missing).toEqual([
      "call-edge",
      "route",
      "data-access",
      "behavior-fact",
    ]);
  });

  it("says what to do rather than only what is absent", () => {
    const text = explainReadiness(reportReadiness(store, 1, "feature-product"));
    expect(text).toContain("not ready for feature-product");
    expect(text).toContain("code index");
  });
});

describe("what an overview can be written from", () => {
  it("is ready on a base with no call graph, deliberately", () => {
    const readiness = reportReadiness(store, 1, "project-product");
    expect(readiness.ready).toBe(true);
    expect(readiness.missing).toEqual([]);
  });

  it("still reports the counts, so a thin base is visible", () => {
    complete();
    const readiness = reportReadiness(store, 1, "project-product");
    expect(readiness.signals.find((s) => s.kind === "call-edge")?.count).toBe(1);
    expect(readiness.signals.every((s) => !s.required)).toBe(true);
  });
});

describe("a report of a type the snapshot cannot support", () => {
  const inventory = { paths: new Set<string>(), extensions: new Set<string>(), denominators: new Set<number>() };

  it("is not a deliverable, however well it is written", () => {
    const result = auditReport({
      report: "## One\n",
      inventory,
      readiness: reportReadiness(store, 1, "feature-product"),
    });

    expect(result.passed).toBe(false);
    expect(result.findings.map((f) => f.code)).toContain("snapshot-not-ready-for-spec");
  });

  it("says nothing when the snapshot can support it", () => {
    complete();
    const result = auditReport({
      report: "## One\n",
      inventory,
      readiness: reportReadiness(store, 1, "feature-product"),
    });

    expect(result.findings).toEqual([]);
  });
});
