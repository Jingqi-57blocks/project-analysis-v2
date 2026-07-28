import type { Store } from "../store/types.js";
import type { PreflightReport } from "./types.js";

/**
 * Writes one `provider_checks` row per preflight result, in one transaction.
 *
 * Run metadata, not analysis content — the same category as `phase_metrics`,
 * which is why it lives in the base schema rather than the knowledge-base
 * layer that owns domain entities.
 */
export function recordPreflight(
  store: Store,
  snapshotId: number,
  report: PreflightReport,
  checkedAt: string = new Date().toISOString(),
): void {
  store.transaction(() => {
    for (const result of report.results) {
      store.run(
        `INSERT INTO provider_checks (snapshot_id, provider_id, version, available, reason, checked_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          snapshotId,
          result.id,
          result.available ? result.version : null,
          result.available ? 1 : 0,
          result.available ? null : result.reason,
          checkedAt,
        ],
      );
    }
  });
}
