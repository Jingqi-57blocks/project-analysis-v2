import { beforeEach, describe, expect, it } from "vitest";

import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { declared, inferred, lineRef } from "../../engine/structural/provenance.js";
import { readRecords, readCapabilityResults, wasAttempted } from "../../engine/structural/persist.js";
import { recordDataModel, toStructuralContribution } from "../../engine/datamodel/persist.js";
import { emptyDataModel, type DataModelContribution } from "../../engine/datamodel/types.js";

let store: Store;
let snapshotId: number;
let rootId: number;

const where = lineRef("svc", "001_init.sql", 3, 1);

function contribution(overrides: Partial<DataModelContribution> = {}): DataModelContribution {
  return {
    providerId: "sql-schema",
    providerVersion: "1.0.0",
    rootName: "svc",
    records: emptyDataModel(),
    gaps: [],
    failures: [],
    ...overrides,
  };
}

function withLeaves(providerId: string, relPath: string): DataModelContribution {
  return contribution({
    providerId,
    records: {
      ...emptyDataModel(),
      entities: [
        {
          rootName: "svc",
          name: "leaves",
          kind: "table",
          qualifier: null,
          provenance: declared(lineRef("svc", relPath, 3, 1)),
        },
      ],
      fields: [
        {
          rootName: "svc",
          entityName: "leaves",
          name: "hours",
          declaredType: "int",
          nullable: false,
          defaultValue: null,
          isPrimaryKey: false,
          provenance: declared(lineRef("svc", relPath, 5, 1)),
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

describe("schema readers agreeing", () => {
  it("records one table when two readers declare it, with both attributions", () => {
    // The SQL migration that creates `leaves` and the Go struct that maps it
    // are two readings of one table. Concatenating them counted it twice and
    // recorded nothing about the agreement.
    recordDataModel(store, snapshotId, rootId, withLeaves("sql-schema", "001_init.sql"));
    recordDataModel(store, snapshotId, rootId, withLeaves("go-model", "model/leave.go"));

    const entities = readRecords(store, snapshotId, "entity");
    expect(entities).toHaveLength(1);
    expect(entities[0]!.attributions.map((a) => a.providerId).sort()).toEqual([
      "go-model",
      "sql-schema",
    ]);
  });

  it("keeps two tables of the same name declared by different services apart", () => {
    recordDataModel(store, snapshotId, rootId, withLeaves("sql-schema", "001_init.sql"));
    const other = withLeaves("sql-schema", "001_init.sql");
    recordDataModel(store, snapshotId, rootId, {
      ...other,
      rootName: "other",
      records: {
        ...other.records,
        entities: other.records.entities.map((entity) => ({ ...entity, rootName: "other" })),
        fields: [],
      },
    });

    expect(readRecords(store, snapshotId, "entity")).toHaveLength(2);
  });

  it("keeps two unique constraints on one table apart", () => {
    // UNIQUE(email) and UNIQUE(tenant, email) are different rules. A key on
    // the table and the kind alone would have stored one.
    recordDataModel(
      store,
      snapshotId,
      rootId,
      contribution({
        records: {
          ...emptyDataModel(),
          constraints: [
            {
              rootName: "svc",
              entityName: "users",
              fields: ["email"],
              kind: "unique",
              expression: null,
              provenance: declared(where),
            },
            {
              rootName: "svc",
              entityName: "users",
              fields: ["tenant", "email"],
              kind: "unique",
              expression: null,
              provenance: declared(where),
            },
          ],
        },
      }),
    );

    expect(readRecords(store, snapshotId, "entity-constraint")).toHaveLength(2);
  });

  it("keeps a declared relation apart from an inferred one of another kind", () => {
    recordDataModel(
      store,
      snapshotId,
      rootId,
      contribution({
        records: {
          ...emptyDataModel(),
          relations: [
            {
              rootName: "svc",
              fromEntity: "orders",
              fromField: "user_id",
              toEntity: "users",
              toField: "id",
              kind: "foreign-key",
              provenance: declared(where),
            },
            {
              rootName: "svc",
              fromEntity: "orders",
              fromField: "user_id",
              toEntity: "users",
              toField: "id",
              kind: "many-to-many",
              provenance: inferred(where, "low"),
            },
          ],
        },
      }),
    );

    expect(readRecords(store, snapshotId, "entity-relation")).toHaveLength(2);
  });
});

describe("what a reader could not read", () => {
  it("accounts for a declared capability, so an empty schema is not silence", () => {
    recordDataModel(store, snapshotId, rootId, contribution(), {
      declarations: [
        { kind: "entity", language: "sql", support: "full", limits: [] },
        { kind: "relation", language: "sql", support: "partial", limits: ["no cross-schema keys"] },
      ],
    });

    const results = readCapabilityResults(store, snapshotId);
    expect(results.map((r) => [r.kind, r.outcome, r.recordCount])).toEqual([
      ["entity", "supplied", 0],
      ["entity-relation", "partial", 0],
    ]);
    // "Nobody looked" and "looked and found none" must stay different answers.
    expect(wasAttempted(store, snapshotId, "entity", "sql")).toBe(true);
    expect(wasAttempted(store, snapshotId, "entity", "go")).toBe(false);
  });

  it("files a gap the model has no name for rather than dropping it", () => {
    const converted = toStructuralContribution(
      contribution({ gaps: [{ kind: "sequence", language: "sql", reason: "not read" }] }),
    );
    expect(converted.gaps).toEqual([
      { kind: "entity", language: "sql", reason: "sequence: not read" },
    ]);
  });

  it("carries a reader's failures through unchanged", () => {
    const counts = recordDataModel(
      store,
      snapshotId,
      rootId,
      contribution({ failures: [{ scope: "003_alter.sql", reason: "unparsable statement" }] }),
    );
    expect(counts.failures).toBe(1);
    expect(
      store.get<{ n: number }>("SELECT COUNT(*) AS n FROM extraction_failures")!.n,
    ).toBe(1);
  });
});

describe("table identity", () => {
  it("records one table when one reader knows its schema and another does not", () => {
    // Only the SQL reader can supply a qualifier; the ORM and Go readers
    // always leave it null. Keying on it stored the same table twice — one
    // row per reader, which is the duplication this move exists to end.
    const withQualifier = withLeaves("sql-schema", "001_init.sql");
    recordDataModel(store, snapshotId, rootId, {
      ...withQualifier,
      records: {
        ...withQualifier.records,
        entities: withQualifier.records.entities.map((entity) => ({
          ...entity,
          qualifier: "public",
        })),
      },
    });
    recordDataModel(store, snapshotId, rootId, withLeaves("go-model", "model/leave.go"));

    const entities = readRecords(store, snapshotId, "entity");
    expect(entities).toHaveLength(1);
    expect(entities[0]!.attributions.map((a) => a.providerId).sort()).toEqual([
      "go-model",
      "sql-schema",
    ]);
  });
});
