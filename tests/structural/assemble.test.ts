import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { assemble, extractAll } from "../../engine/structural/assemble.js";
import { emptyRecords } from "../../engine/structural/kinds.js";
import { symbolId } from "../../engine/structural/identity.js";
import { declared, inferred, lineRef } from "../../engine/structural/provenance.js";
import { readConflicts, readRecords, recordAssembledModel } from "../../engine/structural/persist.js";
import type { StructuralContribution } from "../../engine/structural/provider.js";
import { createFakeProvider } from "../../engine/providers/fake/provider.js";

const handlerId = symbolId({
  rootName: "svc",
  relPath: "user.go",
  kind: "function",
  qualifiedName: "CreateUser",
  signature: null,
});

function routeContribution(
  providerId: string,
  overrides: { handlerName?: string | null; confidence?: "declared" | "inferred" } = {},
): StructuralContribution {
  const provenance =
    overrides.confidence === "inferred"
      ? inferred(lineRef("svc", "routes.go", 40), "low")
      : declared(lineRef("svc", "routes.go", 40));

  return {
    providerId,
    providerVersion: "1.0.0",
    rootName: "svc",
    records: {
      ...emptyRecords(),
      route: [
        {
          rootName: "svc",
          method: "POST",
          path: "/users",
          handlerSymbolId: handlerId,
          handlerName:
            overrides.handlerName === undefined ? "CreateUser" : overrides.handlerName,
          handlerCandidates: [],
          middleware: [],
          provenance,
        },
      ],
    },
    gaps: [],
    failures: [],
  };
}

describe("assemble — identical facts", () => {
  it("merges the same fact from two providers into one record with both attributions", () => {
    const model = assemble("svc", [routeContribution("a"), routeContribution("b")]);

    expect(model.records).toHaveLength(1);
    expect(model.records[0]!.attributions.map((x) => x.providerId)).toEqual(["a", "b"]);
    expect(model.records[0]!.conflicts).toEqual([]);
    expect(model.records[0]!.precedenceReason).toBeNull();
  });

  it("does not treat differing provenance alone as a conflict", () => {
    // Two providers finding the same route at the same place, one having
    // resolved it and one having read it, agree about the route itself.
    const model = assemble("svc", [
      routeContribution("a"),
      routeContribution("b", { confidence: "inferred" }),
    ]);

    expect(model.records[0]!.conflicts).toEqual([]);
  });
});

describe("assemble — conflicting facts", () => {
  it("keeps the more directly observed value and says why", () => {
    const model = assemble("svc", [
      routeContribution("guesser", { handlerName: "GuessedHandler", confidence: "inferred" }),
      routeContribution("reader", { handlerName: "CreateUser" }),
    ]);

    const record = model.records[0]!;
    expect((record.record as { handlerName: string }).handlerName).toBe("CreateUser");
    expect(record.precedenceReason).toContain("declared");
    expect(record.precedenceReason).toContain("inferred");
  });

  it("retains the losing value rather than discarding it", () => {
    const model = assemble("svc", [
      routeContribution("guesser", { handlerName: "GuessedHandler", confidence: "inferred" }),
      routeContribution("reader", { handlerName: "CreateUser" }),
    ]);

    expect(model.records[0]!.conflicts).toEqual([
      { providerId: "guesser", field: "handlerName", value: '"GuessedHandler"' },
    ]);
  });

  it("keeps the direct value even when the inference arrives second", () => {
    const model = assemble("svc", [
      routeContribution("reader", { handlerName: "CreateUser" }),
      routeContribution("guesser", { handlerName: "GuessedHandler", confidence: "inferred" }),
    ]);

    expect((model.records[0]!.record as { handlerName: string }).handlerName).toBe("CreateUser");
    expect(model.records[0]!.conflicts[0]!.providerId).toBe("guesser");
  });

  it("refuses to silently resolve a disagreement at equal directness", () => {
    // Both read the same route directly and disagree. Picking a winner on
    // authority nobody granted would produce a confidently wrong report.
    const model = assemble("svc", [
      routeContribution("a", { handlerName: "HandlerA" }),
      routeContribution("b", { handlerName: "HandlerB" }),
    ]);

    const record = model.records[0]!;
    expect(record.precedenceReason).toContain("disagree at equal directness");
    expect(record.conflicts).toEqual([{ providerId: "b", field: "handlerName", value: '"HandlerB"' }]);
  });

  it("ranks providers by how the fact was established, never by which provider it was", () => {
    // The order of providers must not change the outcome — anything else
    // would bake a vendor preference into the model.
    const forward = assemble("svc", [
      routeContribution("a", { handlerName: "Guessed", confidence: "inferred" }),
      routeContribution("b", { handlerName: "Read" }),
    ]);
    const reversed = assemble("svc", [
      routeContribution("b", { handlerName: "Read" }),
      routeContribution("a", { handlerName: "Guessed", confidence: "inferred" }),
    ]);

    expect((forward.records[0]!.record as { handlerName: string }).handlerName).toBe("Read");
    expect((reversed.records[0]!.record as { handlerName: string }).handlerName).toBe("Read");
  });
});

describe("assemble — gaps and failures", () => {
  it("attributes each gap to the provider that reported it", () => {
    const contribution = { ...routeContribution("a"), gaps: [{ kind: "data-access" as const, language: "go", reason: "no ORM knowledge" }] };
    const model = assemble("svc", [contribution]);

    expect(model.gaps).toEqual([
      { kind: "data-access", language: "go", reason: "no ORM knowledge", providerId: "a" },
    ]);
  });

  it("attributes each failure to its provider", () => {
    const contribution = { ...routeContribution("a"), failures: [{ scope: "x.go", reason: "parse error" }] };
    expect(assemble("svc", [contribution]).failures).toEqual([
      { providerId: "a", scope: "x.go", reason: "parse error" },
    ]);
  });
});

describe("extractAll — partial failure", () => {
  const root = { name: "svc", path: "/tmp/svc", analyzedFiles: [] };

  it("isolates a provider whose extract throws, keeping the others' work", () => {
    const good = createFakeProvider({
      id: "good",
      recordsByRoot: { svc: routeContribution("good").records },
    });
    const broken = createFakeProvider({ id: "broken", throwOnExtract: "indexer crashed" });

    const contributions = extractAll([good, broken, good], root);
    const model = assemble("svc", contributions);

    expect(model.records).toHaveLength(1);
    expect(model.failures).toEqual([
      { providerId: "broken", scope: "svc", reason: "indexer crashed" },
    ]);
  });

  it("degrades only the failing provider's capabilities, not the whole run", () => {
    const broken = createFakeProvider({ id: "broken", throwOnExtract: "boom" });
    const contributions = extractAll([broken], root);

    expect(contributions[0]!.records.symbol).toEqual([]);
    expect(contributions[0]!.failures).toHaveLength(1);
  });
});

describe("recordAssembledModel", () => {
  let store: Store;
  let snapshotId: number;
  let rootId: number;

  beforeEach(() => {
    store = openStore(IN_MEMORY);
    store.run("INSERT INTO workspaces (path, created_at) VALUES ('/w', 't0')");
    store.run(
      "INSERT INTO snapshots (workspace_id, identity, created_at, published_at) VALUES (1, 'i', 't0', NULL)",
    );
    snapshotId = store.get<{ id: number }>("SELECT id FROM snapshots")!.id;
    store.run(
      `INSERT INTO source_roots (snapshot_id, name, path, content_digest, vcs)
       VALUES (?, 'svc', '/w/svc', 'd', 'git')`,
      [snapshotId],
    );
    rootId = store.get<{ id: number }>("SELECT id FROM source_roots")!.id;
  });

  afterEach(() => store.close());

  it("writes one record carrying every attribution", () => {
    const model = assemble("svc", [routeContribution("a"), routeContribution("b")]);
    const counts = recordAssembledModel(store, snapshotId, rootId, model);

    expect(counts.inserted).toBe(1);
    expect(readRecords(store, snapshotId, "route")[0]!.attributions.map((x) => x.providerId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("persists retained conflicts so disagreement survives into the knowledge base", () => {
    const model = assemble("svc", [
      routeContribution("a", { handlerName: "HandlerA" }),
      routeContribution("b", { handlerName: "HandlerB" }),
    ]);
    recordAssembledModel(store, snapshotId, rootId, model);

    const conflicts = readConflicts(store, snapshotId, "route", model.records[0]!.key);
    expect(conflicts).toEqual([{ providerId: "b", field: "handlerName", value: '"HandlerB"' }]);
  });

  it("records a failing provider's failure alongside the successful records", () => {
    const model = assemble("svc", [
      routeContribution("a"),
      { ...routeContribution("b"), records: emptyRecords(), failures: [{ scope: "x", reason: "boom" }] },
    ]);
    recordAssembledModel(store, snapshotId, rootId, model);

    expect(readRecords(store, snapshotId, "route")).toHaveLength(1);
    expect(store.all("SELECT * FROM extraction_failures")).toHaveLength(1);
  });
});

describe("the fake provider", () => {
  const root = { name: "svc", path: "/tmp/svc", analyzedFiles: [] };

  it("supplies exactly what it was given, inferring nothing", () => {
    const provider = createFakeProvider({ recordsByRoot: { svc: routeContribution("fake").records } });
    const contribution = provider.extract(root);

    expect(contribution.records.route).toHaveLength(1);
    expect(contribution.records.symbol).toEqual([]);
  });

  it("returns nothing for a root it was given no records for", () => {
    const provider = createFakeProvider({ recordsByRoot: {} });
    expect(provider.extract(root).records.route).toEqual([]);
  });

  it("can drive the model with no vendor tool installed", () => {
    // The reason this provider is a deliverable and not a test fixture.
    const provider = createFakeProvider({ recordsByRoot: { svc: routeContribution("fake").records } });
    expect(provider.preflight()).toEqual({ available: true, version: "1.0.0" });

    const model = assemble("svc", extractAll([provider], root));
    expect(model.records).toHaveLength(1);
  });

  it("can report itself unavailable, for exercising refusal paths", () => {
    const provider = createFakeProvider({ unavailableReason: "not installed" });
    expect(provider.preflight()).toEqual({ available: false, reason: "not installed" });
  });
});
