import { isAbsolute, relative, resolve } from "node:path";

import { openStore } from "../store/open.js";
import { selectWorkspace } from "../workspace/select.js";
import { analyzedRoots } from "../workspace/types.js";
import { snapshotRoot } from "../snapshot/rootsnapshot.js";
import { beginSnapshot, publishOrRefuse, type SnapshotHandle } from "../snapshot/persist.js";
import { walkRoot } from "../inventory/walk.js";
import { recordInventory } from "../inventory/persist.js";
import { runPreflight, requireAvailable, recordPreflight } from "../providers/index.js";
import { PhaseTimer, recordPhaseMetrics } from "./metrics.js";
import type { AnalysisResult, AnalyzeOptions, AnalyzedRootResult } from "./types.js";

export class UnsafeDatabaseLocationError extends Error {
  constructor(
    readonly dbPath: string,
    readonly rootName: string,
  ) {
    super(
      `Refusing to write the knowledge base to ${dbPath}: that path is inside "${rootName}", ` +
        "a root being analyzed. Analyzed source is read-only — and writing here would change " +
        "the very content this run is measuring, surfacing later as spurious drift. " +
        "Point --db somewhere outside the analyzed roots.",
    );
    this.name = "UnsafeDatabaseLocationError";
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Refuses a knowledge-base path that lives inside a root being analyzed.
 *
 * Enforced rather than documented, for the same reason `deriveVariant` guards
 * its output directory: the read-only guarantee toward analyzed source is only
 * real if something checks it. Here the failure would also be self-inflicted
 * and confusing — writing the database into a root changes that root's content
 * digest mid-run, and the user would see a drift refusal naming their own
 * output file rather than the mistake they actually made.
 */
function assertSafeDatabasePath(dbPath: string, roots: readonly { name: string; path: string }[]): void {
  const resolved = resolve(dbPath);
  for (const root of roots) {
    if (isInside(resolved, resolve(root.path))) {
      throw new UnsafeDatabaseLocationError(resolved, root.name);
    }
  }
}

/**
 * Runs one full analysis: select roots, snapshot them, persist inventory,
 * check providers, then publish — or refuse, leaving the previous published
 * snapshot exactly as it was.
 *
 * No new rollback mechanism is needed for "an interrupted run leaves the
 * prior knowledge base usable": `beginSnapshot` already commits the new
 * snapshot as unpublished, and `getStatus` only ever looks at the latest
 * snapshot with `published_at` set. A run that throws at any point after that
 * simply leaves its own snapshot inert — the previous one is untouched.
 */
export function runAnalyze(options: AnalyzeOptions, now: string = new Date().toISOString()): AnalysisResult {
  const timer = new PhaseTimer();

  const selection = timer.time(
    "select",
    () =>
      selectWorkspace({
        paths: options.paths,
        ...(options.include ? { include: options.include } : {}),
        ...(options.exclude ? { exclude: options.exclude } : {}),
      }),
    (sel) => ({ items: analyzedRoots(sel).length }),
  );
  const roots = analyzedRoots(selection);

  // Checked before anything is captured or opened: refusing early costs the
  // user nothing, while refusing after the walk would waste the whole run.
  assertSafeDatabasePath(options.dbPath, roots);

  const rootSnapshots = timer.time(
    "snapshot-capture",
    () => roots.map((r) => snapshotRoot({ name: r.name, path: r.path, isGitRepo: r.isGitRepo })),
    (result) => ({ items: result.length }),
  );

  const store = openStore(options.dbPath);
  let handle: SnapshotHandle | undefined;

  try {
    handle = timer.time(
      "begin-snapshot",
      () => beginSnapshot(store, selection.workspacePath, rootSnapshots, now, options.runId),
      (h) => ({ items: h.roots.length }),
    );

    // The snapshot row now exists — flush the phases that ran before it did.
    recordPhaseMetrics(store, handle.snapshotId, timer.drain());

    const rootIdByName = new Map(handle.roots.map((r) => [r.name, r.id] as const));
    let inventoryBytes = 0;

    const rootResults = timer.time(
      "inventory",
      () => {
        const results: AnalyzedRootResult[] = [];
        for (const snapshot of rootSnapshots) {
          const rootId = rootIdByName.get(snapshot.name);
          if (rootId === undefined) throw new Error(`No persisted root id for ${snapshot.name}`);

          const walkResult = walkRoot(snapshot.path);
          const counts = recordInventory(store, rootId, walkResult);
          inventoryBytes += walkResult.analyzed.reduce((sum, f) => sum + f.sizeBytes, 0);

          results.push({
            name: snapshot.name,
            vcs: snapshot.vcs,
            commitSha: snapshot.commitSha,
            dirty: snapshot.dirty,
            counts,
          });
        }
        return results;
      },
      (results) => ({
        items: results.reduce((sum, r) => sum + r.counts.discovered, 0),
        bytes: inventoryBytes,
      }),
    );

    const providers = options.providers ?? [];
    const providerReport = timer.time(
      "preflight",
      () => runPreflight(providers),
      (report) => ({ items: report.results.length }),
    );
    recordPreflight(store, handle.snapshotId, providerReport, now);
    if (options.requiredProviderIds) {
      requireAvailable(providerReport, options.requiredProviderIds);
    }

    timer.time(
      "publish",
      () => publishOrRefuse(store, handle!, rootSnapshots, now),
      () => ({ items: rootSnapshots.length }),
    );

    // On the success path a failure to record metrics is a real failure and
    // surfaces normally — the run claimed to have measured itself.
    recordPhaseMetrics(store, handle.snapshotId, timer.drain());

    return {
      snapshotId: handle.snapshotId,
      runId: handle.runId,
      identity: handle.identity,
      workspacePath: selection.workspacePath,
      roots: rootResults,
      providerReport,
    };
  } catch (error) {
    // A failed run's phase timings are still worth having — they show where
    // the time went before it stopped. But recording them is diagnostic, and
    // a diagnostic write must never replace the error that actually stopped
    // the run: a caller told "SQL constraint failed" instead of "source
    // changed during analysis" has been handed the wrong problem to solve.
    if (handle) {
      try {
        recordPhaseMetrics(store, handle.snapshotId, timer.drain());
      } catch {
        // Deliberately swallowed. The original error below is strictly more
        // important than the timings of the run that produced it.
      }
    }
    throw error;
  } finally {
    store.close();
  }
}
