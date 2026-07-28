import type { Store } from "../store/types.js";
import type { PhaseMetric } from "./types.js";

/**
 * Buffers phase timings in memory and hands them out in batches.
 *
 * `phase_metrics.snapshot_id` is `NOT NULL`, but the first phases of a run
 * (selecting roots, capturing their content digests) necessarily happen
 * before `beginSnapshot` creates that row. Rather than making the column
 * nullable, the caller buffers here and drains once a real snapshot id
 * exists, attaching every phase — including the ones that ran first — to the
 * run it belongs to.
 */
export class PhaseTimer {
  #metrics: PhaseMetric[] = [];

  /**
   * Times `fn`, recording its duration. `volume`, given `fn`'s result, may
   * report `items`/`bytes` — omitted entirely for phases with no natural
   * count.
   */
  time<T>(phase: string, fn: () => T, volume?: (result: T) => { items?: number; bytes?: number }): T {
    const start = Date.now();
    const result = fn();
    const durationMs = Date.now() - start;
    const { items, bytes } = volume?.(result) ?? {};
    this.#metrics.push({
      phase,
      durationMs,
      ...(items === undefined ? {} : { items }),
      ...(bytes === undefined ? {} : { bytes }),
    });
    return result;
  }

  /** Removes and returns every buffered metric so far. */
  drain(): PhaseMetric[] {
    const drained = this.#metrics;
    this.#metrics = [];
    return drained;
  }
}

/**
 * Persists a batch of phase metrics. A no-op for an empty batch — draining a
 * timer that recorded nothing must not touch the table at all.
 */
export function recordPhaseMetrics(store: Store, snapshotId: number, metrics: readonly PhaseMetric[]): void {
  if (metrics.length === 0) return;

  store.transaction(() => {
    for (const metric of metrics) {
      store.run(
        "INSERT INTO phase_metrics (snapshot_id, phase, duration_ms, items, bytes) VALUES (?, ?, ?, ?, ?)",
        [snapshotId, metric.phase, metric.durationMs, metric.items ?? null, metric.bytes ?? null],
      );
    }
  });
}
