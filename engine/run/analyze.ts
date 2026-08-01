import { isAbsolute, relative, resolve } from "node:path";

import { openStore } from "../store/open.js";
import { selectWorkspace } from "../workspace/select.js";
import { analyzedRoots } from "../workspace/types.js";
import { snapshotRoot } from "../snapshot/rootsnapshot.js";
import { beginSnapshot, publishOrRefuse, type SnapshotHandle } from "../snapshot/persist.js";
import { walkRoot } from "../inventory/walk.js";
import { recordInventory } from "../inventory/persist.js";
import { runPreflight, requireAvailable, recordPreflight } from "../providers/index.js";
import { codeIndexLocation, defaultReaders } from "../kb/build.js";
import { extractRoot, type RootFacts } from "../kb/extract.js";
import { derive } from "../kb/derive.js";
import { recordDerived } from "../kb/persist.js";
import { countDerived } from "../kb/kinds.js";
import { assembleBehaviorModel } from "../kb/behavior-assemble.js";
import { persistBehaviorModel } from "../kb/behavior-persist.js";
import { behaviorInputFrom } from "../kb/behavior-input.js";
import { recordAssembledModel, recordCapabilities } from "../structural/persist.js";
import { recordEvidence } from "../semantic/persist.js";
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
  assertOutsideRoots(dbPath, roots);
}

/** The same refusal for anything else a command writes near analyzed source. */
export function assertOutsideRoots(
  outputPath: string,
  roots: readonly { name: string; path: string }[],
): void {
  const resolved = resolve(outputPath);
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

    // The walk feeds both the inventory and the readers. Walking twice was
    // how the two halves of this pipeline used to disagree about which files
    // exist — one applied inventory's exclusions and the other did not.
    const walks = new Map<string, ReturnType<typeof walkRoot>>();

    const rootResults = timer.time(
      "inventory",
      () => {
        const results: AnalyzedRootResult[] = [];
        for (const snapshot of rootSnapshots) {
          const rootId = rootIdByName.get(snapshot.name);
          if (rootId === undefined) throw new Error(`No persisted root id for ${snapshot.name}`);

          const walkResult = walkRoot(snapshot.path);
          walks.set(snapshot.name, walkResult);
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

    const indexOptions = {
      ...(options.indexRoot === undefined ? {} : { indexRoot: options.indexRoot }),
      ...(options.noCodeIndex === true ? { noCodeIndex: true } : {}),
    };
    const readers = options.readers ?? defaultReaders(roots.map((root) => root.path), indexOptions);
    const codeIndexPath =
      options.readers === undefined
        ? codeIndexLocation(roots.map((root) => root.path), indexOptions)
        : undefined;
    // Only the structural readers preflight: they are the ones that can be
    // missing at runtime, because some of them shell out to a tool the user
    // may not have installed. The schema readers and collectors are in-process
    // and cannot be absent from a build that contains them.
    const providers = options.providers ?? readers.structural;
    const providerReport = timer.time(
      "preflight",
      () => runPreflight(providers),
      (report) => ({ items: report.results.length }),
    );
    recordPreflight(store, handle.snapshotId, providerReport, now);
    if (options.requiredProviderIds) {
      requireAvailable(providerReport, options.requiredProviderIds);
    }

    // Extraction, derivation and persistence — the three stages that used to
    // live in a separate command, re-reading the same source into a model
    // nothing kept. One run now produces one knowledge base under one run id.
    const rootFacts = timer.time(
      "extract",
      () =>
        roots.map((root): RootFacts => {
          const walk = walks.get(root.name);
          if (walk === undefined) throw new Error(`No inventory for ${root.name}`);
          return extractRoot({
            name: root.name,
            path: root.path,
            analyzedFiles: walk.analyzed.map((file) => file.relPath),
            generatedFiles: new Set(
              walk.analyzed
                .filter((file) => file.classification === "generated")
                .map((file) => file.relPath),
            ),
            excludedCount: walk.excluded.length,
            structuralProviders: readers.structural,
            dataProviders: readers.data,
            collectors: readers.collectors,
          });
        }),
      (facts) => ({ items: facts.reduce((sum, root) => sum + root.model.records.length, 0) }),
    );

    const derived = timer.time(
      "derive",
      () =>
        derive({
          roots: rootFacts,
          providers: readers.structural,
          runId: handle!.runId,
          generatedAt: now,
          workspacePath: selection.workspacePath,
          codeIndexPath,
        }),
      (result) => ({ items: countDerived(result.records) }),
    );

    timer.time(
      "persist",
      () => {
        let written = 0;
        for (const facts of rootFacts) {
          const rootId = rootIdByName.get(facts.rootName);
          if (rootId === undefined) throw new Error(`No persisted root id for ${facts.rootName}`);

          written += recordAssembledModel(store, handle!.snapshotId, rootId, facts.model).inserted;
          for (const entry of facts.contributions) {
            recordCapabilities(
              store,
              handle!.snapshotId,
              rootId,
              entry.contribution,
              entry.capabilities,
            );
          }
          recordEvidence(store, handle!.snapshotId, rootId, facts.evidence);

          for (const failure of facts.vocabularyFailures) {
            store.run(
              `INSERT INTO extraction_failures (snapshot_id, source_root_id, provider_id, scope, reason)
               VALUES (?, ?, 'value-sets', ?, ?)`,
              [handle!.snapshotId, rootId, failure.scope, failure.reason],
            );
          }
        }
        written += recordDerived(
          store,
          handle!.snapshotId,
          derived.records,
          derived.links,
        ).inserted;
        return written;
      },
      (written) => ({ items: written }),
    );

    // Derive and persist the behaviour model from the extracted evidence. This was
    // the base-layer gap the PI-19 baseline surfaced: the derivers existed but were
    // never run over an analysis, so no behaviour facts reached the knowledge base.
    //
    // Behaviour derivation must not take down an otherwise-complete run: the
    // structural KB is already extracted, derived and persisted. If the behaviour
    // validator or persist fails-closed, record the reason as a gap and still
    // publish the structural knowledge base rather than aborting the whole run.
    timer.time(
      "behavior",
      () => {
        try {
          // The code index (when one was built) lets the notification-reachability
          // deriver reverse-reach send sinks to the handlers that trigger them.
          const behaviorOpts = {
            rootPaths: new Map(roots.map((root) => [root.name, root.path] as const)),
            ...(codeIndexPath === undefined ? {} : { codeIndexPath }),
          };
          return persistBehaviorModel(
            store,
            handle!.snapshotId,
            assembleBehaviorModel(behaviorInputFrom(rootFacts, behaviorOpts)).model,
          ).facts;
        } catch (behaviorError) {
          // The behaviour model is snapshot-level; attribute its failure to the
          // first root so the NOT NULL foreign key holds, and record why.
          const firstRootId = handle!.roots[0]?.id;
          if (firstRootId !== undefined) {
            store.run(
              `INSERT INTO extraction_failures (snapshot_id, source_root_id, provider_id, scope, reason)
               VALUES (?, ?, 'behavior', 'behavior-model', ?)`,
              [handle!.snapshotId, firstRootId, behaviorError instanceof Error ? behaviorError.message : String(behaviorError)],
            );
          }
          return 0;
        }
      },
      (facts) => ({ items: facts }),
    );

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
      codeIndexPath: codeIndexPath ?? null,
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
