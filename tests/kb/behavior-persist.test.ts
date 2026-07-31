import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import { MIGRATIONS, SUPPORTED_SCHEMA_VERSION } from "../../engine/store/migrations.js";
import type { Store } from "../../engine/store/types.js";
import type { EvidenceRecord } from "../../engine/contracts/shared-fact/evidence.js";
import { factId } from "../../engine/contracts/shared-fact/identity.js";
import { lineRef } from "../../engine/contracts/shared-fact/provenance.js";
import type { BehaviorFact, BehaviorModel, BehaviorPayload } from "../../engine/contracts/behavior/schema.js";
import {
  persistBehaviorModel,
  readBehaviorDiagnostics,
  readBehaviorModel,
} from "../../engine/kb/behavior-persist.js";

const resolved: EvidenceRecord = {
  attribution: { providerId: "logic", providerVersion: "1.0.0" },
  provenance: { resolutionClass: "resolved", source: lineRef("svc", "a.go", 3), confidence: "high" },
};
const unresolved: EvidenceRecord = {
  attribution: { providerId: "logic", providerVersion: "1.0.0" },
  provenance: { resolutionClass: "unresolved", source: lineRef("svc", "b.go", 9), unresolvedReason: "dynamic target" },
};

function fact(
  kind: string,
  disc: string,
  over: { evidence?: readonly EvidenceRecord[]; payload?: Partial<BehaviorPayload> } = {},
): BehaviorFact {
  return {
    factId: factId({ family: "behavioral", kind, discriminators: [disc] }),
    family: "behavioral",
    kind,
    schemaVersion: "1.0.0",
    evidence: over.evidence ?? [resolved],
    rawIdentities: [],
    payload: { scope: "symbol", activation: "always", ...over.payload },
  };
}

const decision = fact("decision", "d1");
const branch = fact("condition", "c1");
const unknown = fact("teleport", "x"); // quarantined kind
const dynamic = fact("outbound-call", "o1", { evidence: [unresolved] });

function model(): BehaviorModel {
  return {
    schemaVersion: "1.0.0",
    facts: [decision, branch, unknown, dynamic],
    relations: [{ kind: "decision-branch", from: decision.factId, to: branch.factId, role: "then" }],
  };
}

function newSnapshot(store: Store): number {
  store.run("INSERT INTO workspaces (path, created_at) VALUES (?, ?)", ["/w", "t"]);
  const ws = store.get<{ id: number }>("SELECT id FROM workspaces WHERE path = ?", ["/w"])!;
  store.run("INSERT INTO snapshots (workspace_id, identity, created_at) VALUES (?, ?, ?)", [ws.id, "snap-1", "t"]);
  return store.get<{ id: number }>("SELECT id FROM snapshots WHERE identity = ?", ["snap-1"])!.id;
}

function sortById<T extends { factId: string }>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => (a.factId < b.factId ? -1 : 1));
}

describe("persistBehaviorModel / readBehaviorModel", () => {
  it("round-trips facts and relations losslessly, unknown kind and unresolved provenance included", () => {
    const store = openStore(IN_MEMORY, { now: "t" });
    const snap = newSnapshot(store);
    const counts = persistBehaviorModel(store, snap, model());
    expect(counts).toEqual({ facts: 4, relations: 1, diagnostics: 1, quarantined: 1 });

    const read = readBehaviorModel(store, snap);
    expect(sortById(read.facts)).toEqual(sortById(model().facts));
    expect(read.relations).toEqual(model().relations);

    // the unknown kind survived
    expect(read.facts.find((f) => f.kind === "teleport")).toBeDefined();
    // the unresolved provenance survived
    const outbound = read.facts.find((f) => f.kind === "outbound-call")!;
    expect(outbound.evidence[0]!.provenance.resolutionClass).toBe("unresolved");
    store.close();
  });

  it("records a diagnostic for the quarantined kind", () => {
    const store = openStore(IN_MEMORY, { now: "t" });
    const snap = newSnapshot(store);
    persistBehaviorModel(store, snap, model());
    const diags = readBehaviorDiagnostics(store, snap);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.reason).toContain("teleport");
    store.close();
  });

  it("is idempotent — re-persisting the same model does not duplicate rows", () => {
    const store = openStore(IN_MEMORY, { now: "t" });
    const snap = newSnapshot(store);
    persistBehaviorModel(store, snap, model());
    persistBehaviorModel(store, snap, model());
    expect(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM behavior_facts WHERE snapshot_id = ?", [snap])!.n).toBe(4);
    expect(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM behavior_relations WHERE snapshot_id = ?", [snap])!.n).toBe(1);
    expect(readBehaviorModel(store, snap).facts).toHaveLength(4);
    store.close();
  });

  it("replaces the snapshot's model wholesale — a shrunk re-persist leaves no stale fact", () => {
    const store = openStore(IN_MEMORY, { now: "t" });
    const snap = newSnapshot(store);
    persistBehaviorModel(store, snap, model()); // 4 facts
    persistBehaviorModel(store, snap, { schemaVersion: "1.0.0", facts: [branch], relations: [] }); // now 1
    const read = readBehaviorModel(store, snap);
    expect(read.facts).toHaveLength(1);
    expect(read.facts[0]!.kind).toBe("condition");
    expect(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM behavior_relations WHERE snapshot_id = ?", [snap])!.n).toBe(0);
    store.close();
  });

  it("leaves nothing readable when the write is interrupted", () => {
    const store = openStore(IN_MEMORY, { now: "t" });
    const snap = newSnapshot(store);
    expect(() =>
      store.transaction(() => {
        persistBehaviorModel(store, snap, model());
        throw new Error("interrupted");
      }),
    ).toThrow("interrupted");
    expect(readBehaviorModel(store, snap).facts).toHaveLength(0);
    store.close();
  });

  it("refuses an invalid model, writing nothing (fail closed)", () => {
    const store = openStore(IN_MEMORY, { now: "t" });
    const snap = newSnapshot(store);
    const broken: BehaviorModel = { schemaVersion: "1.0.0", facts: [decision, decision], relations: [] };
    expect(() => persistBehaviorModel(store, snap, broken)).toThrow("invalid behaviour model");
    expect(readBehaviorModel(store, snap).facts).toHaveLength(0);
    store.close();
  });

  it("refuses a model past the resource bound rather than truncating", () => {
    const store = openStore(IN_MEMORY, { now: "t" });
    const snap = newSnapshot(store);
    expect(() => persistBehaviorModel(store, snap, model(), { maxFacts: 1 })).toThrow("over the 1 limit");
    expect(readBehaviorModel(store, snap).facts).toHaveLength(0);
    store.close();
  });
});

describe("schema migration to behaviour tables", () => {
  it("migrates an older database to the behaviour schema, conserving existing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi63-mig-"));
    const path = join(dir, "kb.db");

    // Build a database at the pre-behaviour schema (version 6) with one structural row.
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    for (const m of MIGRATIONS.filter((x) => x.version <= 6)) {
      raw.exec(m.up);
      raw.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, "t");
    }
    raw.prepare("INSERT INTO workspaces (id, path, created_at) VALUES (1, '/w', 't')").run();
    raw.prepare("INSERT INTO snapshots (id, workspace_id, identity, created_at) VALUES (1, 1, 'snap-1', 't')").run();
    raw.prepare("INSERT INTO source_roots (id, snapshot_id, name, path, content_digest) VALUES (1, 1, 'svc', '/svc', 'd')").run();
    raw
      .prepare(
        `INSERT INTO structural_records (id, snapshot_id, source_root_id, kind, record_key, payload, resolution_class)
         VALUES (1, 1, 1, 'symbol', 'k1', '{}', 'declared')`,
      )
      .run();
    // Provenance/attribution rows too, so conservation covers more than one table.
    raw
      .prepare(
        `INSERT INTO structural_attributions (record_id, provider_id, provider_version) VALUES (1, 'symbols', '1.0.0')`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO derived_records (snapshot_id, kind, record_key, payload) VALUES (1, 'feature', 'f1', '{}')`,
      )
      .run();
    const before = {
      structural: (raw.prepare("SELECT COUNT(*) AS n FROM structural_records").get() as { n: number }).n,
      attributions: (raw.prepare("SELECT COUNT(*) AS n FROM structural_attributions").get() as { n: number }).n,
      derived: (raw.prepare("SELECT COUNT(*) AS n FROM derived_records").get() as { n: number }).n,
    };
    raw.close();
    expect(before).toEqual({ structural: 1, attributions: 1, derived: 1 });

    // Re-open through the tool: it migrates 6 -> 7, adding the behaviour tables.
    const store = openStore(path, { now: "t" });
    expect(store.schemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
    // Every pre-existing row is conserved across the migration.
    expect(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM structural_records")!.n).toBe(1);
    expect(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM structural_attributions")!.n).toBe(1);
    expect(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM derived_records")!.n).toBe(1);
    // And the new behaviour tables exist and are usable.
    persistBehaviorModel(store, 1, { schemaVersion: "1.0.0", facts: [branch], relations: [] });
    expect(readBehaviorModel(store, 1).facts).toHaveLength(1);
    store.close();
  });
});
