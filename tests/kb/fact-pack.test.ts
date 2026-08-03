import { beforeEach, describe, expect, it } from "vitest";

import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import {
  UnknownFactKindError,
  buildFactPack,
  emptyKinds,
  packSize,
  tablesUsedFor,
} from "../../engine/kb/fact-pack.js";
import { evaluateGate, explainVerdict } from "../../engine/kb/generation-gate.js";

let store: Store;
let snapshotId: number;

/** Paths are relative to their root; membership is keyed `root/relPath`. */
const INSIDE = "leave/service.go";
const OUTSIDE = "billing/service.go";
const MODULE_FILES = new Set([`svc/${INSIDE}`]);

function structural(kind: string, key: string, relPath: string | null, payload: unknown): void {
  store.run(
    `insert into structural_records
       (snapshot_id, source_root_id, kind, record_key, payload, resolution_class, rel_path, start_line)
     values (?, 1, ?, ?, ?, 'resolved', ?, 1)`,
    [snapshotId, kind, key, JSON.stringify(payload), relPath],
  );
}

function behaviour(kind: string, factId: string, payload: unknown): void {
  store.run(
    `insert into behavior_facts (snapshot_id, fact_id, kind, family, scope, schema_version, payload)
     values (?, ?, ?, 'behavioral', 'module', '1.0.0', ?)`,
    [snapshotId, factId, kind, JSON.stringify(payload)],
  );
}

function derived(kind: string, key: string, subjectKey: string | null, payload: unknown, relPath: string | null = null): void {
  store.run(
    `insert into derived_records (snapshot_id, kind, record_key, payload, subject_key, root_name, rel_path)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [snapshotId, kind, key, JSON.stringify(payload), subjectKey, relPath === null ? null : "svc", relPath],
  );
}

/** Provenance in the payload, the way behaviour facts actually carry it. */
function withSource(relPath: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { rootName: "svc", provenance: { source: { rootName: "svc", relPath, startLine: 1 } }, ...extra };
}

beforeEach(() => {
  store = openStore(IN_MEMORY);
  store.run("INSERT INTO workspaces (path, created_at) VALUES ('/w', 't0')");
  store.run("INSERT INTO snapshots (workspace_id, identity, created_at, published_at) VALUES (1, 'i', 't0', NULL)");
  snapshotId = store.get<{ id: number }>("SELECT id FROM snapshots")!.id;
  store.run(
    "INSERT INTO source_roots (snapshot_id, name, path, content_digest) VALUES (?, 'svc', '/w/svc', 'd')",
    [snapshotId],
  );

  structural("route", "svc|GET|/leaves", INSIDE, { rootName: "svc", method: "GET", path: "/leaves" });
  structural("route", "svc|GET|/billings", OUTSIDE, { rootName: "svc", method: "GET", path: "/billings" });
  structural("entity", "svc|wcp_leave", null, { rootName: "svc", name: "wcp_leave" });

  // Behaviour facts have no rel_path column; their provenance lives in payload.
  behaviour("condition", "b|cond|inside", withSource(INSIDE, { text: "hours > 0" }));
  behaviour("condition", "b|cond|outside", withSource(OUTSIDE, { text: "amount > 0" }));
  behaviour("value-set", "b|vs|status", withSource(INSIDE, { name: "LeaveStatus", values: ["applied", "approved"] }));

  derived("module", "mod_leaves", "mod_leaves", { id: "mod_leaves", name: "leaves" });
  derived("module", "mod_billing", "mod_billing", { id: "mod_billing", name: "billing" });
  derived("feature-flow", "flow_1", "feat_leave", { id: "flow_1" });
  derived("coverage-note", "cov_1", null, { id: "cov_1", note: "6% behavioural coverage" });
});

const ALL_KINDS = ["route", "entity", "condition", "value-set", "module", "feature-flow", "coverage-note"];

function moduleRequest(requires: readonly string[] = ALL_KINDS) {
  return {
    scope: "module",
    moduleId: "leave",
    kbModuleId: "mod_leaves",
    moduleFiles: MODULE_FILES,
    subjectKeys: new Set(["mod_leaves", "feat_leave"]),
    requires,
  };
}

describe("fact pack scoping", () => {
  it("keeps only the requested kinds", () => {
    const pack = buildFactPack(store, snapshotId, "i", { scope: "project", requires: ["route"] });
    expect([...new Set(pack.rows.map((row) => row.kind))]).toEqual(["route"]);
  });

  it("rejects a kind the read contract does not serve", () => {
    expect(() => buildFactPack(store, snapshotId, "i", { scope: "project", requires: ["invented-kind"] })).toThrow(
      UnknownFactKindError,
    );
  });

  it("excludes out-of-scope rows that carry a file path in a column", () => {
    const pack = buildFactPack(store, snapshotId, "i", moduleRequest(["route"]));
    expect(pack.rows.map((row) => row.key)).toEqual(["svc|GET|/leaves"]);
  });

  it("excludes out-of-scope behaviour facts, whose path lives in the payload", () => {
    // behavior_facts has no rel_path column. Reading only the column admits
    // every behaviour fact in the workspace into a module pack.
    const pack = buildFactPack(store, snapshotId, "i", moduleRequest(["condition"]));
    expect(pack.rows.map((row) => row.key)).toEqual(["b|cond|inside"]);
  });

  it("keeps derived rows the module owns, which carry no file path at all", () => {
    const pack = buildFactPack(store, snapshotId, "i", moduleRequest(["module", "feature-flow"]));
    expect(pack.rows.map((row) => row.key).sort()).toEqual(["flow_1", "mod_leaves"]);
  });

  it("keeps workspace-level kinds whatever the scope", () => {
    const pack = buildFactPack(store, snapshotId, "i", moduleRequest(["coverage-note"]));
    expect(pack.rows).toHaveLength(1);
  });

  it("excludes rows of a scoped kind that cannot say where they live", () => {
    // The entity row has neither a column path nor payload provenance.
    const pack = buildFactPack(store, snapshotId, "i", moduleRequest(["entity"]));
    expect(pack.rows).toHaveLength(0);
  });

  it("admits everything at project scope", () => {
    const pack = buildFactPack(store, snapshotId, "i", { scope: "project", requires: ALL_KINDS });
    expect(packSize(pack)).toBe(10);
  });
});

describe("fact pack accounting", () => {
  it("reports in-snapshot and in-scope counts per kind and table", () => {
    const pack = buildFactPack(store, snapshotId, "i", moduleRequest(["route"]));
    expect(pack.coverage).toEqual([
      { kind: "route", table: "structural_records", inSnapshot: 2, inScope: 1 },
    ]);
  });

  it("names the requested kinds that have no rows in scope", () => {
    const pack = buildFactPack(store, snapshotId, "i", moduleRequest(["route", "entity"]));
    expect(emptyKinds(pack)).toEqual(["entity"]);
  });

  it("records which table each kind was drawn from", () => {
    const pack = buildFactPack(store, snapshotId, "i", { scope: "project", requires: ["condition"] });
    expect(tablesUsedFor(pack, "condition")).toEqual(["behavior_facts"]);
  });
});

describe("set-valued kinds become member-level subjects", () => {
  it("expands a value set into one subject per member", () => {
    const pack = buildFactPack(store, snapshotId, "i", moduleRequest(["value-set"]));
    expect(pack.subjects.map((subject) => subject.ref).sort()).toEqual(["applied", "approved"]);
    // The row itself stays, as the fact supporting those subjects.
    expect(pack.rows).toHaveLength(1);
  });

  it("gives no subject to a line-anchored kind", () => {
    const pack = buildFactPack(store, snapshotId, "i", moduleRequest(["condition"]));
    expect(pack.subjects).toEqual([]);
  });

  it("gives a subject to a stably keyed kind", () => {
    const pack = buildFactPack(store, snapshotId, "i", moduleRequest(["route"]));
    expect(pack.subjects).toEqual([{ type: "route", ref: "svc|GET|/leaves", factKey: "svc|GET|/leaves" }]);
  });
});

describe("pre-generation gate", () => {
  it("passes when the mandatory kinds are present", () => {
    const pack = buildFactPack(store, snapshotId, "i", moduleRequest(["route", "module"]));
    expect(evaluateGate({ pack, mandatoryKinds: ["route", "module"] })).toEqual({ ok: true });
  });

  it("blocks, rather than degrades, when a mandatory kind is empty in scope", () => {
    const pack = buildFactPack(store, snapshotId, "i", moduleRequest(["route", "entity"]));
    const verdict = evaluateGate({ pack, mandatoryKinds: ["entity"] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.blockers.map((b) => b.code)).toEqual(["coverage-insufficient"]);
  });

  it("blocks an unresolved module instead of widening to the whole project", () => {
    const pack = buildFactPack(store, snapshotId, "i", {
      scope: "module",
      moduleId: "nope",
      kbModuleId: null,
      moduleFiles: new Set(),
      requires: ["route"],
    });
    const verdict = evaluateGate({ pack, mandatoryKinds: [] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.blockers[0]?.code).toBe("module-unresolved");
  });

  it("blocks when a mandatory chapter rests only on line-anchored facts", () => {
    const pack = buildFactPack(store, snapshotId, "i", moduleRequest(["condition"]));
    const verdict = evaluateGate({ pack, mandatoryKinds: ["condition"] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.blockers.map((b) => b.code)).toEqual(["subject-not-addressable"]);
  });

  it("passes conflicting facts and indistinguishable products through as blockers", () => {
    const pack = buildFactPack(store, snapshotId, "i", { scope: "project", requires: ["route"] });
    const verdict = evaluateGate({
      pack,
      mandatoryKinds: [],
      indistinguishableProducts: ["two products in one workspace"],
      conflicts: ["two revisions claim the same entity shape"],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.blockers.map((b) => b.code).sort()).toEqual(["conflicting-facts", "indistinguishable-products"]);
    }
  });

  it("explains why it stopped, naming each gap", () => {
    const pack = buildFactPack(store, snapshotId, "i", moduleRequest(["route", "entity"]));
    const text = explainVerdict(evaluateGate({ pack, mandatoryKinds: ["entity"] }));
    expect(text).toContain("generation refused");
    expect(text).toContain("entity");
  });
});
