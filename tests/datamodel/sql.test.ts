import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSqlSchemaProvider,
  parseColumn,
  parseCreateTables,
  splitDefinitions,
} from "../../engine/datamodel/sql.js";

let workDir: string;

function write(relPath: string, content: string): void {
  const full = join(workDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function extract(files: readonly string[]) {
  return createSqlSchemaProvider().extract({ name: "svc", path: workDir, analyzedFiles: files });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-sql-"));
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

describe("splitDefinitions", () => {
  it("does not split inside parentheses", () => {
    // A naive comma split turns DECIMAL(10, 2) into a column named "2)" —
    // visible nonsense in a report.
    expect(splitDefinitions("id INT, price DECIMAL(10, 2), name TEXT")).toEqual([
      "id INT",
      "price DECIMAL(10, 2)",
      "name TEXT",
    ]);
  });

  it("does not split inside a nested check expression", () => {
    expect(splitDefinitions("a INT, CHECK (a IN (1, 2, 3)), b INT")).toEqual([
      "a INT",
      "CHECK (a IN (1, 2, 3))",
      "b INT",
    ]);
  });

  it("does not split inside a quoted default", () => {
    expect(splitDefinitions("a TEXT DEFAULT 'x, y', b INT")).toEqual(["a TEXT DEFAULT 'x, y'", "b INT"]);
  });
});

describe("parseColumn", () => {
  it("reads the type as written rather than normalizing it", () => {
    expect(parseColumn("price DECIMAL(10, 2)")?.declaredType).toBe("DECIMAL(10, 2)");
  });

  it("reads NOT NULL, defaults and primary keys", () => {
    const column = parseColumn("id INT NOT NULL PRIMARY KEY DEFAULT 0")!;
    expect(column.nullable).toBe(false);
    expect(column.isPrimaryKey).toBe(true);
    expect(column.defaultValue).toBe("0");
  });

  it("treats a column with no NOT NULL as nullable, which is SQL's declared default", () => {
    expect(parseColumn("name TEXT")?.nullable).toBe(true);
  });

  it("reads a foreign key reference with its target column", () => {
    const column = parseColumn("user_id INT REFERENCES users(id)")!;
    expect(column.references).toEqual({ entity: "users", field: "id" });
  });

  it("rejects a table-level constraint rather than reading it as a column", () => {
    expect(parseColumn("PRIMARY KEY (a, b)")).toBeNull();
    expect(parseColumn("FOREIGN KEY (a) REFERENCES b(c)")).toBeNull();
    expect(parseColumn("CONSTRAINT x UNIQUE (a)")).toBeNull();
  });

  it("unquotes identifiers", () => {
    expect(parseColumn('`name` VARCHAR(10)')?.name).toBe("name");
    expect(parseColumn('"name" VARCHAR(10)')?.name).toBe("name");
  });
});

describe("parseCreateTables", () => {
  it("reads a table, its schema qualifier, and its columns", () => {
    const tables = parseCreateTables(
      "CREATE TABLE app.users (\n  id INT PRIMARY KEY,\n  email TEXT NOT NULL\n);",
    );
    expect(tables).toHaveLength(1);
    expect(tables[0]!.name).toBe("users");
    expect(tables[0]!.qualifier).toBe("app");
    expect(tables[0]!.columns.map((c) => c.name)).toEqual(["id", "email"]);
  });

  it("handles IF NOT EXISTS and multiple tables", () => {
    const tables = parseCreateTables(
      "CREATE TABLE IF NOT EXISTS a (id INT);\nCREATE TABLE b (id INT);",
    );
    expect(tables.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("records the line a table was declared on", () => {
    expect(parseCreateTables("\n\nCREATE TABLE a (id INT);")[0]!.line).toBe(3);
  });
});

describe("migrations are a history, not a state", () => {
  it("does not report a column a later migration dropped", () => {
    // Reading each file independently would report dropped columns as though
    // they still exist.
    write("migrations/001_create.sql", "CREATE TABLE users (id INT, legacy_flag INT);");
    write("migrations/002_drop.sql", "ALTER TABLE users DROP COLUMN legacy_flag;");

    const fields = extract(["migrations/001_create.sql", "migrations/002_drop.sql"]).records.fields;
    expect(fields.map((f) => f.name)).toEqual(["id"]);
  });

  it("does not report a table a later migration dropped", () => {
    write("migrations/001.sql", "CREATE TABLE temp_thing (id INT);");
    write("migrations/002.sql", "DROP TABLE temp_thing;");

    const records = extract(["migrations/001.sql", "migrations/002.sql"]).records;
    expect(records.entities).toEqual([]);
    expect(records.fields).toEqual([]);
  });

  it("applies migrations in filename order regardless of the order given", () => {
    write("migrations/001_create.sql", "CREATE TABLE users (id INT, gone INT);");
    write("migrations/002_drop.sql", "ALTER TABLE users DROP COLUMN gone;");

    // Reversed input: order must come from the filenames, not the caller.
    const fields = extract(["migrations/002_drop.sql", "migrations/001_create.sql"]).records.fields;
    expect(fields.map((f) => f.name)).toEqual(["id"]);
  });

  it("says the schema was accumulated in filename order", () => {
    write("migrations/001.sql", "CREATE TABLE a (id INT);");
    expect(extract(["migrations/001.sql"]).gaps.some((g) => g.reason.includes("filename order"))).toBe(
      true,
    );
  });
});

describe("relations", () => {
  it("records a declared foreign key as declared", () => {
    write("schema.sql", "CREATE TABLE orders (id INT, user_id INT REFERENCES users(id));");

    const relation = extract(["schema.sql"]).records.relations.find((r) => r.kind === "foreign-key")!;
    expect(relation.toEntity).toBe("users");
    expect(relation.provenance.resolutionClass).toBe("declared");
  });

  it("records a naming-convention relation as inferred, never as a constraint", () => {
    // A `user_id` column with no foreign key is evidence, not enforcement.
    write("schema.sql", "CREATE TABLE orders (id INT, customer_id INT);");

    const relations = extract(["schema.sql"]).records.relations;
    expect(relations).toHaveLength(1);
    expect(relations[0]!.kind).not.toBe("foreign-key");
    expect(relations[0]!.provenance.resolutionClass).toBe("inferred");
  });

  it("drops relations belonging to a dropped table", () => {
    write("migrations/001.sql", "CREATE TABLE orders (id INT, user_id INT REFERENCES users(id));");
    write("migrations/002.sql", "DROP TABLE orders;");

    expect(extract(["migrations/001.sql", "migrations/002.sql"]).records.relations).toEqual([]);
  });
});

describe("constraints", () => {
  it("records table-level constraints with their expression verbatim", () => {
    write("schema.sql", "CREATE TABLE t (a INT, b INT, PRIMARY KEY (a, b), CHECK (a > 0));");

    const kinds = extract(["schema.sql"]).records.constraints.map((c) => c.kind);
    expect(kinds).toContain("primary-key");
    expect(kinds).toContain("check");
  });
});

describe("absence", () => {
  it("says why it found nothing rather than returning a silent empty result", () => {
    write("main.go", "package main");
    const contribution = extract(["main.go"]);

    expect(contribution.records.entities).toEqual([]);
    expect(contribution.gaps[0]!.reason).toContain("no .sql files");
  });

  it("records a failure for one unreadable file without losing the others", () => {
    write("a.sql", "CREATE TABLE a (id INT);");
    const contribution = extract(["a.sql", "missing.sql"]);

    expect(contribution.records.entities.map((e) => e.name)).toEqual(["a"]);
    expect(contribution.failures).toHaveLength(1);
  });
});

describe("declared capabilities", () => {
  it("claims partial support and names what it does not interpret", () => {
    const declarations = createSqlSchemaProvider().capabilities().declarations;
    expect(declarations.every((d) => d.support === "partial")).toBe(true);
    expect(declarations[0]!.limits.join(" ")).toContain("schema declared in application code");
  });
});

describe("two schemas, one table name", () => {
  it("keeps both tables and gives each its own columns", () => {
    // Keyed by bare name, the second CREATE replaced the first — one table
    // vanished, and its columns were published as the other's, with a
    // provenance pointing at a line that does not declare them.
    write(
      "migrations/001_init.sql",
      `CREATE TABLE public.users (id INT PRIMARY KEY, email TEXT);
CREATE TABLE audit.users (id INT PRIMARY KEY, changed_at TIMESTAMP);
`,
    );
    const { records } = extract(["migrations/001_init.sql"]);

    expect(records.entities.map((entity) => entity.qualifier).sort()).toEqual([
      "audit",
      "public",
    ]);
    expect(records.fields.map((field) => field.name).sort()).toEqual([
      "changed_at",
      "email",
      "id",
      "id",
    ]);
  });
});
