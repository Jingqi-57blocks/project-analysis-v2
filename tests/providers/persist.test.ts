import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import { SUPPORTED_SCHEMA_VERSION } from "../../engine/store/migrations.js";
import type { Store } from "../../engine/store/types.js";
import { recordPreflight } from "../../engine/providers/persist.js";
import { runPreflight } from "../../engine/providers/preflight.js";
import type { Provider } from "../../engine/providers/types.js";

function fakeProvider(id: string, result: "available" | "unavailable"): Provider {
  return {
    id,
    version: "1.0.0",
    capabilities: () => [],
    preflight: () =>
      result === "available"
        ? { available: true, version: "1.0.0" }
        : { available: false, reason: `${id} missing` },
  };
}

let store: Store;
let snapshotId: number;

beforeEach(() => {
  store = openStore(IN_MEMORY);
  store.run("INSERT INTO workspaces (path, created_at) VALUES ('/w', 't0')");
  store.run(
    "INSERT INTO snapshots (workspace_id, identity, created_at, published_at) VALUES (1, 'id', 't0', NULL)",
  );
  snapshotId = store.get<{ id: number }>("SELECT id FROM snapshots WHERE identity = 'id'")!.id;
});

afterEach(() => {
  store.close();
});

describe("migration", () => {
  it("applies the provider_checks migration additively, without disturbing version 1", () => {
    expect(store.schemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(store.schemaVersion).toBeGreaterThanOrEqual(2);

    const applied = store.all<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    );
    expect(applied[0]).toEqual({ version: 1, name: "base-tables" });
    expect(applied.find((m) => m.version === 2)?.name).toBe("provider-checks");
  });

  it("creates the provider_checks table", () => {
    const names = store
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r.name);
    expect(names).toContain("provider_checks");
  });
});

describe("recordPreflight", () => {
  it("writes one row per provider result", () => {
    const report = runPreflight([fakeProvider("a", "available"), fakeProvider("b", "unavailable")]);
    recordPreflight(store, snapshotId, report, "2020-01-01T00:00:00.000Z");

    const rows = store.all<{
      provider_id: string;
      version: string | null;
      available: number;
      reason: string | null;
      checked_at: string;
    }>("SELECT provider_id, version, available, reason, checked_at FROM provider_checks ORDER BY provider_id", []);

    expect(rows).toEqual([
      { provider_id: "a", version: "1.0.0", available: 1, reason: null, checked_at: "2020-01-01T00:00:00.000Z" },
      { provider_id: "b", version: null, available: 0, reason: "b missing", checked_at: "2020-01-01T00:00:00.000Z" },
    ]);
  });

  it("ties rows to the given snapshot", () => {
    store.run(
      "INSERT INTO snapshots (workspace_id, identity, created_at, published_at) VALUES (1, 'id2', 't1', NULL)",
    );
    const otherSnapshotId = store.get<{ id: number }>("SELECT id FROM snapshots WHERE identity = 'id2'")!.id;

    recordPreflight(store, snapshotId, runPreflight([fakeProvider("a", "available")]));
    recordPreflight(store, otherSnapshotId, runPreflight([fakeProvider("b", "available")]));

    const forFirst = store.all<{ provider_id: string }>(
      "SELECT provider_id FROM provider_checks WHERE snapshot_id = ?",
      [snapshotId],
    );
    expect(forFirst).toEqual([{ provider_id: "a" }]);
  });

  it("writes nothing for an empty report", () => {
    recordPreflight(store, snapshotId, { results: [] });
    expect(store.all("SELECT * FROM provider_checks")).toEqual([]);
  });

  it("commits nothing if the transaction is interrupted", () => {
    // Pre-seed a row that will collide only in spirit — provider_checks has
    // no uniqueness constraint on (snapshot_id, provider_id), so force a
    // failure a different way: an invalid snapshot_id violates the foreign
    // key, which the store enforces (proven in tests/store/open.test.ts).
    const report = runPreflight([fakeProvider("a", "available"), fakeProvider("b", "available")]);

    expect(() => recordPreflight(store, 9999, report)).toThrow();
    expect(store.all("SELECT * FROM provider_checks")).toEqual([]);
  });
});
