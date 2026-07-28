import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createOrmMigrationProvider,
  parseCreateTableCalls,
  parseOrmColumns,
  upSection,
} from "../../engine/datamodel/orm.js";

let workDir: string;

function write(relPath: string, content: string): void {
  const full = join(workDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function extract(files: readonly string[]) {
  return createOrmMigrationProvider().extract({ name: "svc", path: workDir, analyzedFiles: files });
}

const CREATE = `'use strict';
module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.createTable('users', {
      id: { allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.BIGINT },
      email: { type: Sequelize.STRING, allowNull: false },
      team_id: { type: Sequelize.BIGINT },
    });
  },
  down: (queryInterface) => queryInterface.dropTable('users'),
};
`;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-orm-"));
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

describe("upSection", () => {
  it("discards the down migration", () => {
    // A down migration states how to reverse a change. Treating its dropTable
    // as a schema fact would delete every table the moment it was created.
    const up = upSection(CREATE);
    expect(up).toContain("createTable");
    expect(up).not.toContain("dropTable");
  });

  it("keeps everything when there is no down section", () => {
    expect(upSection("queryInterface.createTable('a', {});")).toContain("createTable");
  });
});

describe("parseOrmColumns", () => {
  it("reads type, nullability and primary key", () => {
    const columns = parseOrmColumns(
      "id: { allowNull: false, primaryKey: true, type: Sequelize.BIGINT }, name: { type: Sequelize.STRING }",
    );
    expect(columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(columns[0]).toMatchObject({ declaredType: "BIGINT", nullable: false, isPrimaryKey: true });
  });

  it("leaves nullability unknown when the declaration does not state it", () => {
    // Unlike SQL, an ORM column with no allowNull has no declared default here,
    // so null is the honest answer rather than a guess either way.
    expect(parseOrmColumns("name: { type: Sequelize.STRING }")[0]!.nullable).toBeNull();
  });

  it("reads a declared references block", () => {
    const columns = parseOrmColumns(
      "team_id: { type: Sequelize.BIGINT, references: { model: 'teams', key: 'id' } }",
    );
    expect(columns[0]!.references).toEqual({ entity: "teams", field: "id" });
  });

  it("does not treat a nested object as another column", () => {
    const columns = parseOrmColumns(
      "team_id: { type: Sequelize.BIGINT, references: { model: 'teams', key: 'id' } }",
    );
    expect(columns.map((c) => c.name)).toEqual(["team_id"]);
  });
});

describe("parseCreateTableCalls", () => {
  it("reads the table name and its columns", () => {
    const tables = parseCreateTableCalls(CREATE);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.name).toBe("users");
    expect(tables[0]!.columns.map((c) => c.name)).toEqual(["id", "email", "team_id"]);
  });
});

describe("the provider", () => {
  it("recovers entities, fields and constraints from a migration", () => {
    write("migrations/001-create-users.js", CREATE);

    const records = extract(["migrations/001-create-users.js"]).records;
    expect(records.entities.map((e) => e.name)).toEqual(["users"]);
    expect(records.fields.map((f) => f.name)).toEqual(["id", "email", "team_id"]);
    expect(records.constraints.map((c) => c.kind)).toEqual(["primary-key"]);
  });

  it("marks a naming-convention relation as inferred, not as a foreign key", () => {
    write("migrations/001.js", CREATE);

    const relations = extract(["migrations/001.js"]).records.relations;
    expect(relations).toHaveLength(1);
    expect(relations[0]!.kind).not.toBe("foreign-key");
    expect(relations[0]!.provenance.resolutionClass).toBe("inferred");
  });

  it("marks a declared references block as a declared foreign key", () => {
    write(
      "migrations/001.js",
      "module.exports = { up: (q, Sequelize) => q.createTable('orders', { user_id: { type: Sequelize.BIGINT, references: { model: 'users', key: 'id' } } }) };",
    );

    const relation = extract(["migrations/001.js"]).records.relations[0]!;
    expect(relation.kind).toBe("foreign-key");
    expect(relation.toEntity).toBe("users");
    expect(relation.provenance.resolutionClass).toBe("declared");
  });

  it("applies later migrations over earlier ones", () => {
    write("migrations/001-create.js", CREATE);
    write(
      "migrations/002-drop-col.js",
      "module.exports = { up: (q) => q.removeColumn('users', 'email') };",
    );

    const fields = extract(["migrations/001-create.js", "migrations/002-drop-col.js"]).records.fields;
    expect(fields.map((f) => f.name)).toEqual(["id", "team_id"]);
  });

  it("adds a column an later migration introduced", () => {
    write("migrations/001-create.js", CREATE);
    write(
      "migrations/002-add.js",
      "module.exports = { up: (q, Sequelize) => q.addColumn('users', 'archived', { type: Sequelize.BOOLEAN }) };",
    );

    const fields = extract(["migrations/001-create.js", "migrations/002-add.js"]).records.fields;
    expect(fields.map((f) => f.name)).toContain("archived");
  });

  it("orders by filename, not by the order it was given", () => {
    write("migrations/001-create.js", CREATE);
    write("migrations/002-drop.js", "module.exports = { up: (q) => q.dropTable('users') };");

    expect(extract(["migrations/002-drop.js", "migrations/001-create.js"]).records.entities).toEqual([]);
  });

  it("says why it found nothing rather than returning a silent empty result", () => {
    write("index.js", "console.log('hi')");
    const contribution = extract(["index.js"]);

    expect(contribution.records.entities).toEqual([]);
    expect(contribution.gaps[0]!.reason).toContain("no ORM migration files");
  });

  it("records a failure for one unreadable file without losing the others", () => {
    write("migrations/001.js", CREATE);
    const contribution = extract(["migrations/001.js", "migrations/missing.js"]);

    expect(contribution.records.entities.map((e) => e.name)).toEqual(["users"]);
    expect(contribution.failures).toHaveLength(1);
  });

  it("names the frameworks it does not recognize", () => {
    const limits = createOrmMigrationProvider().capabilities().declarations[0]!.limits.join(" ");
    expect(limits).toContain("other ORMs are not recognized");
    expect(limits).toContain("only the up direction is read");
  });
});
