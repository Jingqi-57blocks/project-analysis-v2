import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { digestDirectory } from "../../engine/targets/digest.js";
import { resolveTarget } from "../../engine/targets/resolve.js";
import { runAnalyze } from "../../engine/run/analyze.js";
import { getStatus } from "../../engine/run/status.js";
import { openStore } from "../../engine/store/open.js";
import { openKnowledgeBase } from "../../engine/kb/query.js";
import { announceSkip } from "../support/targets.js";

/**
 * One full end-to-end run against a single real root (wcp-auth), confirming
 * the whole orchestration works on real source and that running it changes
 * nothing on disk under the target — the same read-only guarantee every
 * other stage has been checked against.
 */

const wcpV2 = resolveTarget("wcp-v2");
if (!wcpV2.ok) announceSkip("run on wcp-auth", wcpV2.unavailable.reason);

let tmpRoot: string | undefined;

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = undefined;
});

describe.skipIf(!wcpV2.ok)("runAnalyze on wcp-auth", () => {
  it("analyzes wcp-auth end to end and leaves it unchanged on disk", { timeout: 600_000 }, () => {
    if (!wcpV2.ok) return;
    const authRoot = wcpV2.target.roots.find((r) => r.name === "wcp-auth");
    expect(authRoot?.present, "wcp-auth not present").toBe(true);

    tmpRoot = mkdtempSync(join(tmpdir(), "pa-run-real-target-"));
    const dbPath = join(tmpRoot, "kb.sqlite");

    const before = digestDirectory(authRoot!.path);
    const result = runAnalyze({ paths: [authRoot!.path], dbPath });
    const after = digestDirectory(authRoot!.path);

    expect(after).toBe(before);

    expect(result.roots).toHaveLength(1);
    const root = result.roots[0]!;
    expect(root.name).toBe("wcp-auth");
    expect(root.vcs).toBe("git");
    expect(root.commitSha).not.toBeNull();
    expect(root.counts.analyzed).toBeGreaterThan(30);
    expect(root.counts.failed).toBe(0);

    const store = openStore(dbPath);
    try {
      const status = getStatus(store, authRoot!.path);
      expect(status.analyzed).toBe(true);
      expect(status.snapshotId).toBe(result.snapshotId);
      expect(status.roots?.[0]?.name).toBe("wcp-auth");

      // The run leaves a knowledge base behind, not just an inventory. Before
      // one pipeline, `analyze` published a snapshot with no facts in it and
      // everything downstream re-read the source.
      const structural = store.all<{ kind: string; n: number }>(
        "SELECT kind, COUNT(*) AS n FROM structural_records WHERE snapshot_id = ? GROUP BY kind",
        [result.snapshotId],
      );
      const byKind = new Map(structural.map((row) => [row.kind, row.n]));
      expect(byKind.get("route") ?? 0).toBeGreaterThan(10);
      expect(byKind.get("symbol") ?? 0).toBeGreaterThan(50);

      const derived = store.all<{ kind: string; n: number }>(
        "SELECT kind, COUNT(*) AS n FROM derived_records WHERE snapshot_id = ? GROUP BY kind",
        [result.snapshotId],
      );
      const derivedByKind = new Map(derived.map((row) => [row.kind, row.n]));
      expect(derivedByKind.get("run-context")).toBe(1);
      expect(derivedByKind.get("coverage-note") ?? 0).toBeGreaterThan(0);
      // Rules stated in the project's own vocabulary, which is the join this
      // stage exists to make: conditions come from one reader, the constants
      // that explain them from another, and neither knows about the other.
      expect(derivedByKind.get("business-rule") ?? 0).toBeGreaterThan(0);
      expect(derivedByKind.get("value-set") ?? 0).toBeGreaterThan(0);
      expect(derivedByKind.get("trace") ?? 0).toBeGreaterThan(0);

      // The run id on the facts is the run id the caller was handed: an
      // overview and a module report drawn separately must be the same run.
      const context = store.get<{ payload: string }>(
        "SELECT payload FROM derived_records WHERE snapshot_id = ? AND kind = 'run-context'",
        [result.snapshotId],
      );
      expect(JSON.parse(context!.payload).runId).toBe(result.runId);
    } finally {
      store.close();
    }
  });
  it("names the files it read and drew nothing behavioural from", { timeout: 900_000 }, () => {
    // Against the real target deliberately. A hand-written fixture for this would
    // be code shaped to be convenient to analyze — the first attempt proved it,
    // needing an `if` deleted before a file counted as silent.
    //
    // Two roots, not one: capabilities only form across more than one root, and
    // the capability-scoped list is the issue's primary deliverable. Analyzing
    // wcp-auth alone left that assertion unable to run at all.
    if (!wcpV2.ok) return;
    const roots = ["wcp-auth", "wcp-service"].map(
      (name) => wcpV2.target.roots.find((r) => r.name === name)!,
    );
    expect(roots.every((root) => root.present)).toBe(true);

    tmpRoot = mkdtempSync(join(tmpdir(), "pa-run-silent-"));
    const dbPath = join(tmpRoot, "kb.sqlite");
    const result = runAnalyze({ paths: roots.map((root) => root.path), dbPath });

    const store = openStore(dbPath);
    try {
      const kb = openKnowledgeBase(store, result.runId);
      const silent = kb.silentFiles();
      const paths = silent.map((file) => `${file.rootName}/${file.relPath}`);
      expect(silent.length).toBeGreaterThan(0);

      // Every entry is code this run analyzed, so nothing here is an artefact of
      // the file walk rather than of the readers.
      const analyzed = new Set(
        store
          .all<{ root_name: string; rel_path: string }>(
            `SELECT r.name AS root_name, f.rel_path FROM files f
               JOIN source_roots r ON r.id = f.source_root_id
              WHERE r.snapshot_id = ? AND f.disposition = 'analyzed'
                AND f.classification IN ('source','test')`,
            [result.snapshotId],
          )
          .map((row) => `${row.root_name}/${row.rel_path}`),
      );
      for (const path of paths) expect(analyzed.has(path)).toBe(true);

      // Largest first: a reader choosing what to open should start there.
      const sizes = silent.map((file) => file.sizeBytes);
      expect(sizes.length).toBeGreaterThan(1);
      expect(sizes).toEqual([...sizes].sort((a, b) => b - a));

      // Only files something was parsed out of. Without this the list led with a
      // 3 KB file whose 96 of 97 lines are commented out, under an instruction to
      // start with the largest — and the byte floor cannot see that.
      const parsedCount = (file: { rootName: string; relPath: string }): number =>
        store.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM structural_records s
             JOIN source_roots r ON r.id = s.source_root_id
            WHERE s.snapshot_id = ? AND r.name = ? AND s.rel_path = ?
              AND s.kind IN ('symbol','import')`,
          [result.snapshotId, file.rootName, file.relPath],
        )!.n;

      for (const file of silent) {
        expect(parsedCount(file), `${file.rootName}/${file.relPath} was never parsed`).toBeGreaterThan(0);
      }

      // And the ones nothing was read from are reported rather than dropped —
      // separately, because "could not be read" is a stronger statement than
      // "says nothing". Dropping them lost 41 model files each declaring a table.
      const unread = kb.unreadFiles();
      expect(unread.length).toBeGreaterThan(0);
      for (const file of unread) {
        expect(parsedCount(file), `${file.rootName}/${file.relPath} was parsed after all`).toBe(0);
      }
      // Disjoint: a file is in one list or the other, never both.
      const unreadPaths = new Set(unread.map((file) => `${file.rootName}/${file.relPath}`));
      for (const path of paths) expect(unreadPaths.has(path)).toBe(false);

      // Nothing falls out of both. Every file the coverage fraction counts as
      // unread is named by one of the two lists — the claim the note makes, and
      // the one an earlier version of this query broke for 38 files.
      const coverageUnread = store
        .all<{ root_name: string; rel_path: string }>(
          `SELECT r.name AS root_name, f.rel_path
             FROM files f JOIN source_roots r ON r.id = f.source_root_id
            WHERE r.snapshot_id = ? AND f.disposition = 'analyzed'
              AND f.classification IN ('source','test')
              AND f.size_bytes >= 128
              AND NOT EXISTS (
                SELECT 1 FROM structural_records s
                 WHERE s.snapshot_id = ? AND s.source_root_id = f.source_root_id
                   AND s.rel_path = f.rel_path
                   AND s.kind NOT IN ('source-file','module-containment'))
              AND NOT EXISTS (
                SELECT 1 FROM evidence_items e
                 WHERE e.snapshot_id = ? AND e.source_root_id = f.source_root_id
                   AND e.rel_path = f.rel_path)
              AND NOT EXISTS (
                SELECT 1 FROM derived_records d
                 WHERE d.snapshot_id = ? AND d.root_name = r.name AND d.rel_path = f.rel_path)`,
          [result.snapshotId, result.snapshotId, result.snapshotId, result.snapshotId],
        )
        .map((row) => `${row.root_name}/${row.rel_path}`);
      expect(coverageUnread.length).toBeGreaterThan(0);
      const named = new Set([...paths, ...unreadPaths]);
      for (const path of coverageUnread) {
        expect(named.has(path), `${path} is unread by coverage and named by neither list`).toBe(true);
      }

      // The premise the floor needs, asserted rather than assumed: without a
      // candidate under the floor, an assertion about the floor cannot fail.
      const tiny = store.all<{ rel_path: string }>(
        `SELECT f.rel_path FROM files f JOIN source_roots r ON r.id = f.source_root_id
          WHERE r.snapshot_id = ? AND f.disposition = 'analyzed'
            AND f.classification IN ('source','test') AND f.size_bytes < 128`,
        [result.snapshotId],
      );
      expect(tiny.length, "no sub-floor file in this target, so the floor is untested").toBeGreaterThan(0);
      for (const row of tiny) {
        expect(silent.map((file) => file.relPath)).not.toContain(row.rel_path);
      }

      // A file whose behaviour was read is not listed, or the list would be every
      // file and mean nothing. Ordered, so this does not hold by insertion accident.
      const withRoute = store.get<{ root_name: string; rel_path: string }>(
        `SELECT r.name AS root_name, s.rel_path FROM structural_records s
           JOIN source_roots r ON r.id = s.source_root_id
          WHERE s.snapshot_id = ? AND s.kind = 'route'
          ORDER BY s.rel_path LIMIT 1`,
        [result.snapshotId],
      );
      expect(paths).not.toContain(`${withRoute!.root_name}/${withRoute!.rel_path}`);

      // Nor a file whose only contribution is a derived value set: it supplied the
      // vocabulary a roles section reads, so it is not silent.
      const valueSetFile = store.get<{ root_name: string; rel_path: string }>(
        `SELECT root_name, rel_path FROM derived_records
          WHERE snapshot_id = ? AND kind = 'value-set' AND rel_path IS NOT NULL
          ORDER BY rel_path LIMIT 1`,
        [result.snapshotId],
      );
      expect(paths).not.toContain(`${valueSetFile!.root_name}/${valueSetFile!.rel_path}`);
    } finally {
      store.close();
    }
  });

  it("scopes silence to the capability that owns the file", { timeout: 900_000 }, () => {
    if (!wcpV2.ok) return;
    const roots = ["wcp-auth", "wcp-service"].map(
      (name) => wcpV2.target.roots.find((r) => r.name === name)!,
    );

    tmpRoot = mkdtempSync(join(tmpdir(), "pa-run-silent-feature-"));
    const dbPath = join(tmpRoot, "kb.sqlite");
    const result = runAnalyze({ paths: roots.map((root) => root.path), dbPath });

    const store = openStore(dbPath);
    try {
      const kb = openKnowledgeBase(store, result.runId);

      // The premise, asserted: with no capability the loop below runs zero times
      // and gutting the query to `return []` passes, which is how this went
      // untested on a single root.
      const features = kb.features();
      expect(features.length, "no capability formed, so the scoped query is untested").toBeGreaterThan(0);

      let scopedTotal = 0;
      for (const feature of features) {
        const owned = new Set(feature.filePaths);
        for (const file of kb.silentFilesForFeature(feature.id)) {
          expect(owned.has(`${file.rootName}/${file.relPath}`)).toBe(true);
          scopedTotal += 1;
        }
      }
      // At least one capability owns at least one silent file, or every assertion
      // above is vacuous.
      expect(scopedTotal, "no capability owns a silent file").toBeGreaterThan(0);

      expect(kb.silentFilesForFeature("feat_nonexistent")).toEqual([]);
    } finally {
      store.close();
    }
  });
});
