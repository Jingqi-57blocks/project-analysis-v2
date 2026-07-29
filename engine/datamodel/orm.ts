/**
 * Reads the data model from ORM migration declarations.
 *
 * Sequelize-style `queryInterface.createTable(...)` and friends. These are
 * declarations, but reading them means recognizing one framework's
 * conventions, so support is per-framework and anything unrecognized is a
 * declared gap.
 *
 * Only the `up` direction is read. A `down` migration describes how to undo a
 * change; treating its `dropTable` as a schema fact would delete every table
 * the moment it was created.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";

import { declared, inferred, lineRef } from "../structural/provenance.js";
import { findCalls, literalText, parseSource } from "../text/ast.js";
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

export const PROVIDER_ID = "orm-migrations";
export const PROVIDER_VERSION = "1.0.0";

const MAX_FILE_BYTES = 2_000_000;

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === "\n") line += 1;
  return line;
}

function matchBrace(content: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    const char = content[i]!;
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The `up` half of a migration module.
 *
 * Everything after a `down:` key is discarded, since a down migration states
 * how to reverse a change rather than what the schema is.
 */
export function upSection(content: string): string {
  const down = /(^|[\s,{])down\s*[:(]/m.exec(content);
  return down ? content.slice(0, down.index) : content;
}

export interface ParsedOrmColumn {
  readonly name: string;
  readonly declaredType: string | null;
  readonly nullable: boolean | null;
  readonly isPrimaryKey: boolean;
  readonly references: { entity: string; field: string | null } | null;
}

/** Column definitions inside a `createTable` object literal. */
export function parseOrmColumns(body: string): readonly ParsedOrmColumn[] {
  const columns: ParsedOrmColumn[] = [];
  // Each `name: { ... }` entry at the top level of the object.
  const pattern = /(?:^|[\s,{])['"`]?([A-Za-z_][A-Za-z0-9_]*)['"`]?\s*:\s*\{/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const open = body.indexOf("{", match.index + match[0].length - 1);
    const close = matchBrace(body, open, "{", "}");
    if (close === -1) continue;

    const definition = body.slice(open + 1, close);
    // Nested braces mean this entry contained another object — a `references`
    // block, for instance — which is fine; the fields below read through it.
    const type = /type\s*:\s*(?:Sequelize|DataTypes)\.([A-Za-z0-9_]+(?:\([^)]*\))?)/.exec(definition);
    const referencesModel = /references\s*:\s*\{[^}]*model\s*:\s*['"`]([^'"`]+)['"`]/.exec(definition);
    const referencesKey = /references\s*:\s*\{[^}]*key\s*:\s*['"`]([^'"`]+)['"`]/.exec(definition);

    columns.push({
      name: match[1]!,
      declaredType: type ? type[1]! : null,
      nullable: /allowNull\s*:\s*false/.test(definition)
        ? false
        : /allowNull\s*:\s*true/.test(definition)
          ? true
          : null,
      isPrimaryKey: /primaryKey\s*:\s*true/.test(definition),
      references: referencesModel
        ? { entity: referencesModel[1]!, field: referencesKey ? referencesKey[1]! : null }
        : null,
    });

    pattern.lastIndex = close;
  }

  return columns;
}

interface ParsedOrmTable {
  readonly name: string;
  readonly columns: readonly ParsedOrmColumn[];
  readonly line: number;
}

export function parseCreateTableCalls(content: string): readonly ParsedOrmTable[] {
  const parsed = parseSource("javascript", content);
  if (parsed.root !== null) {
    const tables: ParsedOrmTable[] = [];
    for (const call of findCalls(parsed.root)) {
      if (call.method !== "createTable") continue;
      const name = literalText(call.args[0]);
      const body = call.args[1];
      if (name === null || body === undefined) continue;

      const text = body.text();
      tables.push({
        name,
        columns: parseOrmColumns(text.startsWith("{") ? text.slice(1, -1) : text),
        line: call.line,
      });
    }
    return tables;
  }

  const tables: ParsedOrmTable[] = [];
  const pattern = /createTable\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{/g;

  for (const match of content.matchAll(pattern)) {
    const open = content.indexOf("{", match.index + match[0].length - 1);
    const close = matchBrace(content, open, "{", "}");
    if (close === -1) continue;

    tables.push({
      name: match[1]!,
      columns: parseOrmColumns(content.slice(open + 1, close)),
      line: lineAt(content, match.index),
    });
  }

  return tables;
}

export interface OrmChange {
  readonly table: string;
  readonly column: string;
}

/**
 * Columns a migration adds, with the definition it adds them under.
 *
 * Parsed rather than matched, for two reasons the source made plain: a
 * commented-out `createTable('users', ...)` example is not a declaration, and
 * an `addColumn` wrapped in `.transaction(tx => { ... })` is an ordinary one.
 * A comment is not a call node, and nesting is just depth.
 */
export function addedColumns(
  content: string,
): readonly (OrmChange & { line: number; definition: ParsedOrmColumn | null })[] {
  const parsed = parseSource("javascript", content);
  if (parsed.root === null) {
    // Falling back keeps a file the grammar rejects from vanishing silently.
    return [...content.matchAll(/addColumn\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]/g)].map(
      (match) => ({
        table: match[1]!,
        column: match[2]!,
        line: lineAt(content, match.index),
        definition: null,
      }),
    );
  }

  const added: (OrmChange & { line: number; definition: ParsedOrmColumn | null })[] = [];
  for (const call of findCalls(parsed.root)) {
    if (call.method !== "addColumn") continue;
    const table = literalText(call.args[0]);
    const column = literalText(call.args[1]);
    if (table === null || column === null) continue;

    const definitionNode = call.args[2];
    const definition =
      definitionNode === undefined
        ? null
        : (parseOrmColumns(`${column}: ${definitionNode.text()}`)[0] ?? null);

    added.push({ table, column, line: call.line, definition });
  }
  return added;
}

export function removedColumns(content: string): readonly OrmChange[] {
  return [...content.matchAll(/removeColumn\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]/g)].map(
    (match) => ({ table: match[1]!, column: match[2]! }),
  );
}

export function droppedTablesOrm(content: string): readonly string[] {
  return [...content.matchAll(/dropTable\s*\(\s*['"`]([^'"`]+)['"`]/g)].map((match) => match[1]!);
}

function isMigrationFile(relPath: string): boolean {
  const extension = extname(relPath).toLowerCase();
  if (![".js", ".cjs", ".mjs", ".ts"].includes(extension)) return false;
  const segments = relPath.split(sep);
  return segments.includes("migrations") || segments.includes("migrate");
}

function capabilities(): DataModelCapabilities {
  const limits = [
    "Sequelize-style queryInterface migrations only; other ORMs are not recognized",
    "only the up direction is read, since a down migration reverses rather than declares",
    "migrations are applied in filename order, which is the convention but not guaranteed",
    "column type changes and raw SQL inside a migration are not interpreted",
  ];
  return {
    declarations: [
      { kind: "entity", language: "javascript", support: "partial", limits },
      { kind: "field", language: "javascript", support: "partial", limits },
      { kind: "relation", language: "javascript", support: "partial", limits },
      { kind: "constraint", language: "javascript", support: "partial", limits },
    ],
  };
}

export function createOrmMigrationProvider(): DataModelProvider {
  return {
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,
    capabilities,

    extract(root: DataModelRootInput): DataModelContribution {
      const files = [...root.analyzedFiles.filter(isMigrationFile)].sort((a, b) =>
        basename(a).localeCompare(basename(b)),
      );
      const failures: DataModelFailure[] = [];
      const gaps: DataModelGap[] = [];

      if (files.length === 0) {
        return {
          providerId: PROVIDER_ID,
          providerVersion: PROVIDER_VERSION,
          rootName: root.name,
          records: emptyDataModel(),
          gaps: [
            {
              kind: "entity",
              language: "javascript",
              reason: "no ORM migration files were found in this root",
            },
          ],
          failures: [],
        };
      }

      const entities = new Map<string, EntityRecord>();
      const fields = new Map<string, FieldRecord>();
      const relations: DataRelationRecord[] = [];
      const constraints: ConstraintRecord[] = [];

      for (const relPath of files) {
        try {
          const full = join(root.path, relPath);
          if (statSync(full).size > MAX_FILE_BYTES) {
            failures.push({ scope: relPath, reason: "file exceeds the read size limit" });
            continue;
          }
          const content = upSection(readFileSync(full, "utf8"));

          for (const table of parseCreateTableCalls(content)) {
            const source = lineRef(root.name, relPath, table.line);
            entities.set(table.name, {
              rootName: root.name,
              name: table.name,
              kind: "table",
              qualifier: null,
              provenance: declared(source),
            });

            for (const column of table.columns) {
              fields.set(`${table.name}.${column.name}`, {
                rootName: root.name,
                entityName: table.name,
                name: column.name,
                declaredType: column.declaredType,
                nullable: column.nullable,
                defaultValue: null,
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
            }
          }

          for (const added of addedColumns(content)) {
            const key = `${added.table}.${added.column}`;
            if (fields.has(key)) continue;
            fields.set(key, {
              rootName: root.name,
              entityName: added.table,
              name: added.column,
              declaredType: added.definition?.declaredType ?? null,
              nullable: added.definition?.nullable ?? null,
              defaultValue: null,
              isPrimaryKey: added.definition?.isPrimaryKey ?? false,
              provenance: declared(lineRef(root.name, relPath, added.line)),
            });
          }

          for (const removed of removedColumns(content)) {
            fields.delete(`${removed.table}.${removed.column}`);
          }
          for (const table of droppedTablesOrm(content)) {
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

      gaps.push({
        kind: "entity",
        language: "javascript",
        reason:
          "schema accumulated from migrations in filename order; a project applying them in another order would differ",
      });

      const surviving = new Set(entities.keys());

      return {
        providerId: PROVIDER_ID,
        providerVersion: PROVIDER_VERSION,
        rootName: root.name,
        records: {
          entities: [...entities.values()],
          // A field added to a table that never appears in a createTable is
          // still a real column; keeping it would be right, but it has no
          // entity to hang from, so it is dropped along with a recorded gap
          // rather than being attached to an entity that does not exist.
          fields: [...fields.values()].filter((f) => surviving.has(f.entityName)),
          relations: relations.filter((r) => surviving.has(r.fromEntity)),
          constraints: constraints.filter((c) => surviving.has(c.entityName)),
        },
        gaps,
        failures,
      };
    },
  };
}
