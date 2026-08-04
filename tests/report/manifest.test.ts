import { describe, expect, it } from "vitest";

import {
  ManifestError,
  codegraphVersionOf,
  manifestDisagreements,
  parseManifest,
  type ReportManifest,
} from "../../engine/report/manifest.js";
import { IN_MEMORY, openStore } from "../../engine/store/open.js";

const COMPLETE = {
  workspacePath: "/w",
  runId: "run-1",
  snapshotId: 3,
  identity: "abc",
  publishedAt: "2026-08-03T00:00:00.000Z",
  specId: "project-product",
  language: "zh-CN",
  codegraphVersion: "1.5.0",
};

const ACTUAL = {
  id: 3,
  identity: "abc",
  publishedAt: "2026-08-03T00:00:00.000Z",
  workspacePath: "/w",
  codegraphVersion: "1.5.0",
};

describe("parsing a manifest", () => {
  it("reads a complete one", () => {
    expect(parseManifest(JSON.stringify(COMPLETE))).toEqual(COMPLETE);
  });

  it("accepts a run that had no code index", () => {
    const parsed = parseManifest(JSON.stringify({ ...COMPLETE, codegraphVersion: null }));
    expect(parsed.codegraphVersion).toBeNull();
  });

  it.each(["workspacePath", "runId", "identity", "publishedAt", "specId", "language"])(
    "refuses a manifest missing %s",
    (field) => {
      const partial: Record<string, unknown> = { ...COMPLETE };
      delete partial[field];
      expect(() => parseManifest(JSON.stringify(partial))).toThrow(ManifestError);
    },
  );

  it("refuses a snapshot id that is not an integer", () => {
    expect(() => parseManifest(JSON.stringify({ ...COMPLETE, snapshotId: "3" }))).toThrow(ManifestError);
  });

  it("refuses text that is not JSON at all", () => {
    expect(() => parseManifest("not json")).toThrow(ManifestError);
  });
});

describe("comparing a manifest to the base", () => {
  it("says nothing when they agree", () => {
    expect(manifestDisagreements(COMPLETE as ReportManifest, ACTUAL)).toEqual([]);
  });

  it("catches a report bound to a snapshot other than the run's", () => {
    const drifted = { ...COMPLETE, snapshotId: 2 } as ReportManifest;
    expect(manifestDisagreements(drifted, ACTUAL)[0]).toContain("snapshot 3");
  });

  it("catches a base rebuilt from different source since the report was written", () => {
    const stale = { ...COMPLETE, identity: "older" } as ReportManifest;
    expect(manifestDisagreements(stale, ACTUAL)[0]).toContain("identity older");
  });

  it("names every disagreement, not the first", () => {
    const wrong = { ...COMPLETE, identity: "x", workspacePath: "/other" } as ReportManifest;
    expect(manifestDisagreements(wrong, ACTUAL)).toHaveLength(2);
  });

  it("catches a report written when the code index was a different version", () => {
    const wrong = { ...COMPLETE, codegraphVersion: "1.4.0" } as ReportManifest;
    expect(manifestDisagreements(wrong, ACTUAL)[0]).toContain("1.4.0");
  });
});

describe("the code-index version behind a snapshot", () => {
  const seed = () => {
    const store = openStore(IN_MEMORY);
    store.run("INSERT INTO workspaces (path, created_at) VALUES ('/w', 't')");
    store.run("INSERT INTO snapshots (workspace_id, identity, created_at) VALUES (1, 'i', 't')");
    return store;
  };

  it("reads it from the provider check the run recorded", () => {
    const store = seed();
    store.run(
      "INSERT INTO provider_checks (snapshot_id, provider_id, version, available, checked_at) VALUES (1, 'codegraph', '1.5.0', 1, 't')",
    );
    expect(codegraphVersionOf(store, 1)).toBe("1.5.0");
    store.close();
  });

  it("is null when the indexer was not available to that run", () => {
    const store = seed();
    store.run(
      "INSERT INTO provider_checks (snapshot_id, provider_id, version, available, checked_at) VALUES (1, 'codegraph', NULL, 0, 't')",
    );
    expect(codegraphVersionOf(store, 1)).toBeNull();
    store.close();
  });

  it("is null when no code index took part at all", () => {
    const store = seed();
    expect(codegraphVersionOf(store, 1)).toBeNull();
    store.close();
  });
});
