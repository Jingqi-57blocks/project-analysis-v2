import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { emptyRecords } from "../../engine/structural/kinds.js";
import { symbolId } from "../../engine/structural/identity.js";
import { declared, inferred, lineRef, unresolved } from "../../engine/structural/provenance.js";
import {
  readCapabilityResults,
  readRecords,
  recordContribution,
  summarizeCapabilities,
  wasAttempted,
} from "../../engine/structural/persist.js";
import { ANY_LANGUAGE, type ProviderCapabilities, type StructuralContribution } from "../../engine/structural/provider.js";

let store: Store;
let snapshotId: number;
let rootId: number;

const id = symbolId({
  rootName: "svc",
  relPath: "user.go",
  kind: "function",
  qualifiedName: "CreateUser",
  signature: null,
});

function contribution(overrides: Partial<StructuralContribution> = {}): StructuralContribution {
  return {
    providerId: "provider-a",
    providerVersion: "1.0.0",
    rootName: "svc",
    records: emptyRecords(),
    gaps: [],
    failures: [],
    ...overrides,
  };
}

function withSymbol(providerId: string, name = "CreateUser"): StructuralContribution {
  return contribution({
    providerId,
    records: {
      ...emptyRecords(),
      symbol: [
        {
          id: symbolId({
            rootName: "svc",
            relPath: "user.go",
            kind: "function",
            qualifiedName: name,
            signature: null,
          }),
          name,
          qualifiedName: name,
          kind: "function",
          visibility: "public",
          signature: null,
          containerId: null,
          provenance: declared(lineRef("svc", "user.go", 10, 20)),
        },
      ],
    },
  });
}

beforeEach(() => {
  store = openStore(IN_MEMORY);
  store.run("INSERT INTO workspaces (path, created_at) VALUES ('/w', 't0')");
  store.run(
    "INSERT INTO snapshots (workspace_id, identity, created_at, published_at) VALUES (1, 'i', 't0', NULL)",
  );
  snapshotId = store.get<{ id: number }>("SELECT id FROM snapshots")!.id;
  store.run(
    `INSERT INTO source_roots (snapshot_id, name, path, content_digest, vcs)
     VALUES (?, 'svc', '/w/svc', 'digest', 'git')`,
    [snapshotId],
  );
  rootId = store.get<{ id: number }>("SELECT id FROM source_roots")!.id;
});

afterEach(() => store.close());

describe("the structural-model migration", () => {
  it("is additive, leaving the earlier versions in place", () => {
    // Asserts the earlier migrations are untouched rather than pinning the
    // whole list, which would break on every future migration for no reason.
    const applied = store.all<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    );

    expect(applied.slice(0, 3).map((m) => m.name)).toEqual([
      "base-tables",
      "provider-checks",
      "structural-model",
    ]);
    expect(applied.map((m) => m.version)).toEqual([...applied.map((m) => m.version)].sort((a, b) => a - b));
  });
});

describe("recordContribution", () => {
  it("writes a record with its provenance denormalized for querying", () => {
    recordContribution(store, snapshotId, rootId, withSymbol("provider-a"));

    const row = store.get<{
      kind: string;
      resolution_class: string;
      confidence: string | null;
      rel_path: string;
      start_line: number;
    }>("SELECT kind, resolution_class, confidence, rel_path, start_line FROM structural_records");

    expect(row).toEqual({
      kind: "symbol",
      resolution_class: "declared",
      confidence: null,
      rel_path: "user.go",
      start_line: 10,
    });
  });

  it("round-trips the record through the store unchanged", () => {
    recordContribution(store, snapshotId, rootId, withSymbol("provider-a"));

    const stored = readRecords(store, snapshotId, "symbol");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.record.name).toBe("CreateUser");
    expect(stored[0]!.record.id).toBe(id);
  });

  it("attributes the record to the provider that supplied it", () => {
    recordContribution(store, snapshotId, rootId, withSymbol("provider-a"));

    expect(readRecords(store, snapshotId, "symbol")[0]!.attributions).toEqual([
      { providerId: "provider-a", providerVersion: "1.0.0" },
    ]);
  });

  it("merges the same fact from two providers into one record with both attributions", () => {
    // The claim that two providers produce one model is only true if this
    // holds — otherwise every count downstream is inflated by however many
    // providers happened to see the same thing.
    const first = recordContribution(store, snapshotId, rootId, withSymbol("provider-a"));
    const second = recordContribution(store, snapshotId, rootId, withSymbol("provider-b"));

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.merged).toBe(1);

    const stored = readRecords(store, snapshotId, "symbol");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.attributions.map((a) => a.providerId)).toEqual(["provider-a", "provider-b"]);
  });

  it("keeps genuinely different facts apart", () => {
    recordContribution(store, snapshotId, rootId, withSymbol("provider-a", "CreateUser"));
    recordContribution(store, snapshotId, rootId, withSymbol("provider-a", "DeleteUser"));

    expect(readRecords(store, snapshotId, "symbol")).toHaveLength(2);
  });

  it("records a confidence when the fact was inferred", () => {
    const inferredSymbol = withSymbol("provider-a");
    recordContribution(store, snapshotId, rootId, {
      ...inferredSymbol,
      records: {
        ...inferredSymbol.records,
        symbol: [
          { ...inferredSymbol.records.symbol[0]!, provenance: inferred(lineRef("svc", "user.go", 10), "low") },
        ],
      },
    });

    const row = store.get<{ resolution_class: string; confidence: string | null }>(
      "SELECT resolution_class, confidence FROM structural_records",
    );
    expect(row).toEqual({ resolution_class: "inferred", confidence: "low" });
  });

  it("persists an unresolved fact rather than dropping it", () => {
    // An unresolved call is a fact about the codebase. Dropping it would
    // shrink the graph exactly where the code is hardest to reason about.
    recordContribution(
      store,
      snapshotId,
      rootId,
      contribution({
        records: {
          ...emptyRecords(),
          "call-edge": [
            {
              callerId: id,
              calleeId: null,
              calleeName: "handler",
              provenance: unresolved(lineRef("svc", "user.go", 30), "dynamic dispatch"),
            },
          ],
        },
      }),
    );

    const stored = readRecords(store, snapshotId, "call-edge");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.record.calleeName).toBe("handler");
    expect(stored[0]!.record.calleeId).toBeNull();
  });

  it("records extraction failures without discarding the records that succeeded", () => {
    recordContribution(store, snapshotId, rootId, {
      ...withSymbol("provider-a"),
      failures: [{ scope: "broken.go", reason: "parse error" }],
    });

    expect(readRecords(store, snapshotId, "symbol")).toHaveLength(1);
    const failures = store.all<{ scope: string; reason: string }>(
      "SELECT scope, reason FROM extraction_failures",
    );
    expect(failures).toEqual([{ scope: "broken.go", reason: "parse error" }]);
  });

  it("writes nothing at all if the contribution fails partway", () => {
    expect(() =>
      store.transaction(() => {
        recordContribution(store, snapshotId, rootId, withSymbol("provider-a"));
        throw new Error("later step failed");
      }),
    ).toThrow("later step failed");

    expect(store.all("SELECT * FROM structural_records")).toEqual([]);
    expect(store.all("SELECT * FROM structural_attributions")).toEqual([]);
  });
});

describe("capability accounting", () => {
  const capabilities: ProviderCapabilities = {
    declarations: [
      { kind: "symbol", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "route", language: "go", support: "partial", limits: ["misses group prefixes"] },
      { kind: "data-access", language: ANY_LANGUAGE, support: "none", limits: [] },
    ],
  };

  it("distinguishes a capability that was never asked from one that found nothing", () => {
    // The exit criterion for this issue. A kind nobody addressed has no row;
    // a kind that was addressed and came back empty has one saying so.
    recordContribution(store, snapshotId, rootId, withSymbol("provider-a"), capabilities);

    expect(wasAttempted(store, snapshotId, "symbol", ANY_LANGUAGE)).toBe(true);
    expect(wasAttempted(store, snapshotId, "route", "go")).toBe(true);
    // Never declared, never reported as a gap — nobody looked.
    expect(wasAttempted(store, snapshotId, "validation-rule", ANY_LANGUAGE)).toBe(false);
  });

  it("reports a declared gap as absent, carrying its reason", () => {
    recordContribution(
      store,
      snapshotId,
      rootId,
      contribution({ gaps: [{ kind: "route", language: "swift", reason: "no framework knowledge" }] }),
      capabilities,
    );

    const results = readCapabilityResults(store, snapshotId);
    const route = results.find((r) => r.kind === "route" && r.language === "swift");
    expect(route?.outcome).toBe("absent");
    expect(route?.reason).toBe("no framework knowledge");
  });

  it("reports partial support as partial, keeping the declared limits", () => {
    recordContribution(store, snapshotId, rootId, withSymbol("provider-a"), capabilities);

    const route = readCapabilityResults(store, snapshotId).find((r) => r.kind === "route");
    expect(route?.outcome).toBe("partial");
    expect(route?.reason).toBe("misses group prefixes");
  });

  it("reports a full-support capability that returned nothing as supplied with zero records", () => {
    // Not "absent": the provider's claim and its result are both facts, and
    // flattening them would hide a provider whose declaration no longer
    // matches its behaviour.
    recordContribution(store, snapshotId, rootId, contribution(), capabilities);

    const symbolResult = readCapabilityResults(store, snapshotId).find((r) => r.kind === "symbol");
    expect(symbolResult?.outcome).toBe("supplied");
    expect(symbolResult?.recordCount).toBe(0);
  });

  it("does not account for a capability the provider declared as unsupported", () => {
    recordContribution(store, snapshotId, rootId, withSymbol("provider-a"), capabilities);
    expect(wasAttempted(store, snapshotId, "data-access", ANY_LANGUAGE)).toBe(false);
  });

  it("counts the records a capability actually produced", () => {
    recordContribution(store, snapshotId, rootId, withSymbol("provider-a"), capabilities);

    const symbolResult = readCapabilityResults(store, snapshotId).find((r) => r.kind === "symbol");
    expect(symbolResult?.recordCount).toBe(1);
  });
});

describe("summarizeCapabilities", () => {
  it("prefers a reported gap over a declaration for the same kind and language", () => {
    // A provider that declared support but then reported a gap for this run
    // has told us something more specific about what actually happened.
    const results = summarizeCapabilities(
      contribution({ gaps: [{ kind: "symbol", language: "go", reason: "indexer timed out" }] }),
      { declarations: [{ kind: "symbol", language: "go", support: "full", limits: [] }] },
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: "absent", reason: "indexer timed out" });
  });

  it("produces nothing for a provider that declared nothing and reported no gaps", () => {
    expect(summarizeCapabilities(contribution(), null)).toEqual([]);
  });
});
