/**
 * Reads the data model from SQL DDL.
 *
 * `CREATE TABLE` states types, nullability, keys and foreign keys outright —
 * the strongest evidence available, needing no interpretation.
 *
 * A migrations directory is a *history*, not a state: reading each file
 * independently would report columns that were later dropped as though they
 * still exist. Files are therefore applied in order and later statements
 * revise earlier ones.
 */

import { readFileSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";

import { declared, inferred, lineRef } from "../structural/provenance.js";
import {
  emptyDataModel,
  type ConstraintRecord,
  type DataModelCapabilities,
  type DataModelContribution,
  type DataModelFailure,
  type DataModelGap,
  type DataModelProvider,
  type DataModelRootInput,
  type DataRelationRecord,
  type EntityRecord,
  type FieldRecord,
} from "./types.js";

export const PROVIDER_ID = "sql-schema";
export const PROVIDER_VERSION = "1.0.0";

const MAX_FILE_BYTES = 5_000_000;

/** A column type followed by its modifiers, as written. */
interface ParsedColumn {
  readonly name: string;
  readonly declaredType: string | null;
  readonly nullable: boolean | null;
  readonly defaultValue: string | null;
  readonly isPrimaryKey: boolean;
  readonly references: { entity: string; field: string | null } | null;
  readonly unique: boolean;
}

function unquote(identifier: string): string {
  return identifier.replace(/^[`"'\[]/, "").replace(/[`"'\]]$/, "");
}

/**
 * Splits a CREATE TABLE body on commas that are not inside parentheses.
 *
 * A naive split breaks `DECIMAL(10, 2)` and `CHECK (a IN (1, 2))` in half,
 * producing a column named `2)` — visible nonsense in a report, and the kind
 * of thing a regex-only reader gets wrong quietly.
 */
export function splitDefinitions(body: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let quote: string | null = null;

  for (const char of body) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

const TABLE_LEVEL_KEYWORDS = /^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT|INDEX|KEY)\b/i;

export function parseColumn(definition: string): ParsedColumn | null {
  if (TABLE_LEVEL_KEYWORDS.test(definition)) return null;

  const match = /^([`"'\[]?[A-Za-z_][A-Za-z0-9_]*[`"'\]]?)\s+(.+)$/s.exec(definition.trim());
  if (!match) return null;

  const rest = match[2]!;
  const typeMatch = /^([A-Za-z_][A-Za-z0-9_ ]*(?:\([^)]*\))?)/.exec(rest);
  const references = /REFERENCES\s+([`"'\[]?[\w.]+[`"'\]]?)\s*(?:\(\s*([\w]+)\s*\))?/i.exec(rest);
  const defaultValue = /DEFAULT\s+('(?:[^']|'')*'|[^\s,]+)/i.exec(rest);

  return {
    name: unquote(match[1]!),
    declaredType: typeMatch ? typeMatch[1]!.trim() : null,
    // Absent NOT NULL is not the same as declared NULL, but SQL's default is
    // nullable, so this is a declared fact of the dialect rather than a guess.
    nullable: /\bNOT\s+NULL\b/i.test(rest) ? false : true,
    defaultValue: defaultValue ? defaultValue[1]! : null,
    isPrimaryKey: /\bPRIMARY\s+KEY\b/i.test(rest),
    references: references
      ? { entity: unquote(references[1]!), field: references[2] ? unquote(references[2]) : null }
      : null,
    unique: /\bUNIQUE\b/i.test(rest),
  };
}

interface ParsedTable {
  readonly name: string;
  readonly qualifier: string | null;
  readonly columns: readonly ParsedColumn[];
  readonly tableConstraints: readonly string[];
  readonly line: number;
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === "\n") line += 1;
  return line;
}

/** Finds the matching close paren for the open paren at `open`. */
function matchParen(content: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < content.length; i++) {
    const char = content[i]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function parseCreateTables(content: string): readonly ParsedTable[] {
  const tables: ParsedTable[] = [];
  const pattern = /CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"'\[]?[\w.]+[`"'\]]?)\s*\(/gi;

  for (const match of content.matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    const close = matchParen(content, open);
    if (close === -1) continue;

    const raw = unquote(match[1]!);
    const dot = raw.lastIndexOf(".");
    const definitions = splitDefinitions(content.slice(open + 1, close));

    tables.push({
      name: dot === -1 ? raw : raw.slice(dot + 1),
      qualifier: dot === -1 ? null : raw.slice(0, dot),
      columns: definitions.map(parseColumn).filter((c): c is ParsedColumn => c !== null),
      tableConstraints: definitions.filter((d) => TABLE_LEVEL_KEYWORDS.test(d)),
      line: lineAt(content, match.index),
    });
  }

  return tables;
}

/** Columns dropped by a later migration must not survive into the reported schema. */
export function droppedColumns(content: string): readonly { table: string; column: string }[] {
  const dropped: { table: string; column: string }[] = [];
  const pattern = /ALTER\s+TABLE\s+([`"'\[]?[\w.]+[`"'\]]?)\s+DROP\s+(?:COLUMN\s+)?([`"'\[]?\w+[`"'\]]?)/gi;
  for (const match of content.matchAll(pattern)) {
    const raw = unquote(match[1]!);
    const dot = raw.lastIndexOf(".");
    dropped.push({ table: dot === -1 ? raw : raw.slice(dot + 1), column: unquote(match[2]!) });
  }
  return dropped;
}

export function droppedTables(content: string): readonly string[] {
  return [...content.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([`"'\[]?[\w.]+[`"'\]]?)/gi)].map(
    (match) => {
      const raw = unquote(match[1]!);
      const dot = raw.lastIndexOf(".");
      return dot === -1 ? raw : raw.slice(dot + 1);
    },
  );
}

function isSqlFile(relPath: string): boolean {
  return extname(relPath).toLowerCase() === ".sql";
}

/** Migration files sort lexically by convention, which is how they are applied. */
function migrationOrder(files: readonly string[]): readonly string[] {
  return [...files].sort((a, b) => a.localeCompare(b));
}

function capabilities(): DataModelCapabilities {
  const limits = [
    "SQL DDL only; a schema declared in application code is not read here",
    "migrations are applied in filename order, which is the common convention but not guaranteed",
    "ALTER TABLE ... ALTER COLUMN type changes are not applied",
    "dialect-specific syntax beyond CREATE TABLE, DROP TABLE and DROP COLUMN is not interpreted",
  ];
  return {
    declarations: [
      { kind: "entity", language: "sql", support: "partial", limits },
      { kind: "field", language: "sql", support: "partial", limits },
      { kind: "relation", language: "sql", support: "partial", limits },
      { kind: "constraint", language: "sql", support: "partial", limits },
    ],
  };
}

export function createSqlSchemaProvider(): DataModelProvider {
  return {
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,
    capabilities,

    extract(root: DataModelRootInput): DataModelContribution {
      const sqlFiles = migrationOrder(root.analyzedFiles.filter(isSqlFile));
      const failures: DataModelFailure[] = [];
      const gaps: DataModelGap[] = [];

      if (sqlFiles.length === 0) {
        // Many projects legitimately store no data, or declare their schema
        // somewhere this reader does not look. Either way it is a stated fact
        // rather than an empty success.
        return {
          providerId: PROVIDER_ID,
          providerVersion: PROVIDER_VERSION,
          rootName: root.name,
          records: emptyDataModel(),
          gaps: [
            { kind: "entity", language: "sql", reason: "no .sql files were found in this root" },
          ],
          failures: [],
        };
      }

      // Accumulated rather than per-file: a migrations directory is a history,
      // and reading each file independently would report dropped columns as
      // though they still exist.
      const entities = new Map<string, EntityRecord>();
      const fields = new Map<string, FieldRecord>();
      const relations: DataRelationRecord[] = [];
      const constraints: ConstraintRecord[] = [];
      let sawMigrations = false;

      for (const relPath of sqlFiles) {
        if (relPath.split(sep).includes("migrations")) sawMigrations = true;

        try {
          const full = join(root.path, relPath);
          if (statSync(full).size > MAX_FILE_BYTES) {
            failures.push({ scope: relPath, reason: "file exceeds the read size limit" });
            continue;
          }
          const content = readFileSync(full, "utf8");

          for (const table of parseCreateTables(content)) {
            const source = lineRef(root.name, relPath, table.line);
            // Keyed with the schema, so `public.users` and `audit.users` both
            // reach the merge instead of the second silently replacing the
            // first — which attributed one table's columns to the other.
            const qualified = table.qualifier === null ? table.name : `${table.qualifier}.${table.name}`;
            entities.set(qualified, {
              rootName: root.name,
              name: table.name,
              kind: "table",
              qualifier: table.qualifier,
              provenance: declared(source),
            });

            for (const column of table.columns) {
              fields.set(`${qualified}.${column.name}`, {
                rootName: root.name,
                entityName: table.name,
                name: column.name,
                declaredType: column.declaredType,
                nullable: column.nullable,
                defaultValue: column.defaultValue,
                isPrimaryKey: column.isPrimaryKey,
                provenance: declared(source),
              });

              if (column.references) {
                relations.push({
                  rootName: root.name,
                  fromEntity: table.name,
                  fromField: column.name,
                  toEntity: column.references.entity,
                  toField: column.references.field,
                  kind: "foreign-key",
                  provenance: declared(source),
                });
              } else if (/_id$/i.test(column.name)) {
                // A naming convention is evidence, not a constraint. Recorded
                // as inferred so nothing can present a guessed relation as an
                // enforced one.
                relations.push({
                  rootName: root.name,
                  fromEntity: table.name,
                  fromField: column.name,
                  toEntity: column.name.replace(/_id$/i, ""),
                  toField: null,
                  kind: "unknown",
                  provenance: inferred(source, "low"),
                });
              }

              if (column.isPrimaryKey) {
                constraints.push({
                  rootName: root.name,
                  entityName: table.name,
                  fields: [column.name],
                  kind: "primary-key",
                  expression: null,
                  provenance: declared(source),
                });
              }
              if (column.unique) {
                constraints.push({
                  rootName: root.name,
                  entityName: table.name,
                  fields: [column.name],
                  kind: "unique",
                  expression: null,
                  provenance: declared(source),
                });
              }
            }

            for (const definition of table.tableConstraints) {
              constraints.push({
                rootName: root.name,
                entityName: table.name,
                fields: [],
                kind: /PRIMARY\s+KEY/i.test(definition)
                  ? "primary-key"
                  : /FOREIGN\s+KEY/i.test(definition)
                    ? "foreign-key"
                    : /UNIQUE/i.test(definition)
                      ? "unique"
                      : /CHECK/i.test(definition)
                        ? "check"
                        : "unknown",
                expression: definition,
                provenance: declared(source),
              });
            }
          }

          for (const dropped of droppedColumns(content)) {
            fields.delete(`${dropped.table}.${dropped.column}`);
          }
          for (const table of droppedTables(content)) {
            entities.delete(table);
            for (const key of [...fields.keys()]) {
              if (key.startsWith(`${table}.`)) fields.delete(key);
            }
          }
        } catch (error) {
          failures.push({
            scope: relPath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (sawMigrations) {
        gaps.push({
          kind: "entity",
          language: "sql",
          reason:
            "schema accumulated from migrations in filename order; a project applying them in another order would differ",
        });
      }

      const survivingEntities = new Set(entities.keys());

      return {
        providerId: PROVIDER_ID,
        providerVersion: PROVIDER_VERSION,
        rootName: root.name,
        records: {
          entities: [...entities.values()],
          fields: [...fields.values()],
          // A relation whose table was dropped is no longer a relation.
          relations: relations.filter((r) => survivingEntities.has(r.fromEntity)),
          constraints: constraints.filter((c) => survivingEntities.has(c.entityName)),
        },
        gaps,
        failures,
      };
    },
  };
}
