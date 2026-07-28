import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { PhaseTimer, recordPhaseMetrics } from "../../engine/run/metrics.js";

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

describe("PhaseTimer", () => {
  it("buffers metrics until drained", () => {
    const timer = new PhaseTimer();
    timer.time("a", () => 1);
    timer.time("b", () => 2);

    const drained = timer.drain();
    expect(drained.map((m) => m.phase)).toEqual(["a", "b"]);
    expect(drained.every((m) => m.durationMs >= 0)).toBe(true);
  });

  it("drain empties the buffer — a second drain returns nothing new", () => {
    const timer = new PhaseTimer();
    timer.time("a", () => 1);
    timer.drain();

    expect(timer.drain()).toEqual([]);
  });

  it("returns the wrapped function's result unchanged", () => {
    const timer = new PhaseTimer();
    const result = timer.time("phase", () => ({ value: 42 }));
    expect(result).toEqual({ value: 42 });
  });

  it("propagates a thrown error from the wrapped function without swallowing it", () => {
    const timer = new PhaseTimer();
    expect(() =>
      timer.time("phase", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });

  it("attaches items/bytes reported by the volume callback", () => {
    const timer = new PhaseTimer();
    timer.time(
      "inventory",
      () => ["a", "bb", "ccc"],
      (result) => ({ items: result.length, bytes: result.join("").length }),
    );

    const [metric] = timer.drain();
    expect(metric).toEqual({ phase: "inventory", durationMs: expect.any(Number), items: 3, bytes: 6 });
  });

  it("omits items/bytes entirely when no volume callback is given", () => {
    const timer = new PhaseTimer();
    timer.time("select", () => "ignored");

    const [metric] = timer.drain();
    expect(metric).toEqual({ phase: "select", durationMs: expect.any(Number) });
    expect("items" in metric!).toBe(false);
    expect("bytes" in metric!).toBe(false);
  });
});

describe("recordPhaseMetrics", () => {
  it("writes one row per metric, tied to the given snapshot", () => {
    recordPhaseMetrics(store, snapshotId, [
      { phase: "select", durationMs: 5, items: 2 },
      { phase: "inventory", durationMs: 40, items: 100, bytes: 5000 },
    ]);

    const rows = store.all<{
      phase: string;
      duration_ms: number;
      items: number | null;
      bytes: number | null;
    }>("SELECT phase, duration_ms, items, bytes FROM phase_metrics ORDER BY id", []);

    expect(rows).toEqual([
      { phase: "select", duration_ms: 5, items: 2, bytes: null },
      { phase: "inventory", duration_ms: 40, items: 100, bytes: 5000 },
    ]);
  });

  it("does nothing for an empty batch", () => {
    recordPhaseMetrics(store, snapshotId, []);
    expect(store.all("SELECT * FROM phase_metrics")).toEqual([]);
  });

  it("writes nothing if the batch write is interrupted", () => {
    // No uniqueness constraint to collide with, so force failure the same way
    // tests/providers/persist.test.ts does: an invalid snapshot_id violates
    // the foreign key the store enforces.
    expect(() =>
      recordPhaseMetrics(store, 9999, [
        { phase: "a", durationMs: 1 },
        { phase: "b", durationMs: 2 },
      ]),
    ).toThrow();
    expect(store.all("SELECT * FROM phase_metrics")).toEqual([]);
  });
});
