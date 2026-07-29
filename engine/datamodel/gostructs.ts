/**
 * Reads the schema a Go service declares in its models.
 *
 * The migration readers only see projects that keep their schema in
 * migrations, which left two thirds of the tables this workspace actually uses
 * with no columns described at all — a report claiming to be enough to rebuild
 * a project cannot be missing most of its schema.
 *
 * A Go service declares the same facts, just elsewhere: a struct's fields
 * carry `gorm:"column:..."` tags and Go types, and a `TableName()` method says
 * which physical table the struct stands for. Both are read from the syntax
 * tree, and a struct whose table cannot be resolved is skipped rather than
 * guessed at — a column list attached to the wrong table would be worse than
 * none.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SgNode } from "@ast-grep/napi";

import { findCalls, parseSource } from "../text/ast.js";
import { declared, lineRef } from "../structural/provenance.js";
import { goTableConstants } from "./usage.js";
import type {
  ConstraintRecord,
  DataModelCapabilities,
  DataModelContribution,
  DataModelFailure,
  DataModelProvider,
  DataModelRootInput,
  DataRelationRecord,
  EntityRecord,
  FieldRecord,
} from "./types.js";

export const PROVIDER_ID = "go-models";
export const PROVIDER_VERSION = "1.0.0";

interface GormTag {
  readonly column: string | null;
  readonly primaryKey: boolean;
  readonly notNull: boolean;
}

/** `gorm:"column:id;primary_key"` — the parts that describe the column. */
export function parseGormTag(tag: string): GormTag {
  const gorm = /gorm:"([^"]*)"/.exec(tag)?.[1] ?? "";
  const parts = gorm.split(";").map((part) => part.trim().toLowerCase());

  const column = /column:([^;"\s]+)/i.exec(gorm)?.[1] ?? null;
  return {
    column,
    primaryKey: parts.includes("primary_key") || parts.includes("primarykey"),
    notNull: parts.includes("not null") || parts.includes("not_null"),
  };
}

/**
 * A Go type as the column it implies.
 *
 * A pointer is the language's way of saying a value may be absent, which is
 * the same statement a nullable column makes — that inference is stated as an
 * inference, since a non-pointer field can still map to a nullable column.
 */
function fieldTypeOf(declaredType: string): { type: string; nullable: boolean } {
  const nullable = declaredType.startsWith("*");
  return { type: declaredType.replace(/^\*/, ""), nullable };
}

interface GoStruct {
  readonly name: string;
  readonly line: number;
  readonly fields: readonly {
    readonly name: string;
    readonly goType: string;
    readonly tag: string;
    readonly line: number;
  }[];
}

function structsIn(root: SgNode): GoStruct[] {
  const structs: GoStruct[] = [];

  let declarations: SgNode[];
  try {
    declarations = root.findAll({ rule: { kind: "type_declaration" as never } });
  } catch {
    return structs;
  }

  for (const declaration of declarations) {
    for (const spec of declaration.children()) {
      if ((spec.kind() as string) !== "type_spec") continue;
      const name = spec.field("name")?.text();
      const body = spec.field("type");
      if (name === undefined || body === undefined || body === null) continue;
      if ((body.kind() as string) !== "struct_type") continue;

      const fields: GoStruct["fields"] = body
        .findAll({ rule: { kind: "field_declaration" as never } })
        .map((field) => {
          const fieldName = field.field("name")?.text() ?? field.children()[0]?.text() ?? "";
          const goType = field.field("type")?.text() ?? "";
          const tag =
            field.children().find((child) => (child.kind() as string) === "raw_string_literal")
              ?.text() ?? "";
          return { name: fieldName, goType, tag, line: field.range().start.line + 1 };
        })
        .filter((field) => field.name !== "" && field.goType !== "");

      structs.push({ name, line: spec.range().start.line + 1, fields });
    }
  }

  return structs;
}

/**
 * Which table each struct stands for, from its `TableName()` method.
 *
 * The method returns a constant rather than a literal, so the constant's value
 * has to be looked up — the same indirection the data-access reader resolves,
 * and the same table map serves both.
 */
function tableNames(root: SgNode, constants: ReadonlyMap<string, string>): Map<string, string> {
  const tables = new Map<string, string>();

  let functions: SgNode[];
  try {
    functions = root.findAll({ rule: { kind: "method_declaration" as never } });
  } catch {
    return tables;
  }

  for (const method of functions) {
    if ((method.field("name")?.text() ?? "") !== "TableName") continue;

    const receiver = method.field("receiver")?.text() ?? "";
    const structName = /\*?\s*([A-Z]\w*)\s*\)/.exec(receiver)?.[1];
    if (structName === undefined) continue;

    const body = method.field("body");
    if (body === undefined || body === null) continue;

    // Either `return "wcp_leave"` or `return constant.TbLv.String()`.
    const literal = /return\s+"([^"]+)"/.exec(body.text())?.[1];
    if (literal !== undefined) {
      tables.set(structName, literal);
      continue;
    }

    for (const call of findCalls(body)) {
      const resolved = call.receiver
        .split(".")
        .reverse()
        .map((segment) => constants.get(segment))
        .find((found) => found !== undefined);
      if (resolved !== undefined) {
        tables.set(structName, resolved);
        break;
      }
    }
    if (!tables.has(structName)) {
      for (const identifier of body.text().matchAll(/\b([A-Z]\w*)\b/g)) {
        const resolved = constants.get(identifier[1]!);
        if (resolved !== undefined) {
          tables.set(structName, resolved);
          break;
        }
      }
    }
  }

  return tables;
}

function capabilities(): DataModelCapabilities {
  const limits = [
    "structs with a gorm column tag and a TableName method are read; a struct whose table cannot be resolved is skipped rather than guessed at",
    "a pointer type is taken as a nullable column, which is an inference rather than a declaration",
    "field types are the Go types as written, not the database types they map to",
    "constraints beyond the primary key are not declared in a struct and are not reported here",
    "where several structs name one table, the one declaring the most columns is taken as the schema and the projections are not merged into it",
  ];
  return {
    declarations: [
      { kind: "entity", language: "go", support: "partial", limits },
      { kind: "field", language: "go", support: "partial", limits },
      { kind: "relation", language: "go", support: "none", limits },
      { kind: "constraint", language: "go", support: "partial", limits },
    ],
  };
}

export function createGoModelProvider(): DataModelProvider {
  return {
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,
    capabilities,

    extract(root: DataModelRootInput): DataModelContribution {
      const entities: EntityRecord[] = [];
      const fields: FieldRecord[] = [];
      const constraints: ConstraintRecord[] = [];
      const relations: DataRelationRecord[] = [];
      const failures: DataModelFailure[] = [];

      const goFiles = root.analyzedFiles.filter(
        (relPath) => relPath.endsWith(".go") && !relPath.endsWith("_test.go"),
      );
      if (goFiles.length === 0) {
        return {
          providerId: PROVIDER_ID,
          providerVersion: PROVIDER_VERSION,
          rootName: root.name,
          records: { entities, fields, relations, constraints },
          gaps: [],
          failures,
        };
      }

      // The constant map is workspace-wide: a struct's TableName often names a
      // constant declared in another package.
      const constants = new Map<string, string>();
      for (const relPath of goFiles) {
        if (!/table|constant/i.test(relPath)) continue;
        try {
          for (const [name, table] of goTableConstants(readFileSync(join(root.path, relPath), "utf8"))) {
            constants.set(name, table);
          }
        } catch {
          continue;
        }
      }

      // A table can be claimed by several structs: the model that declares it
      // and any number of DTOs that project a few of its columns. The fullest
      // declaration wins, because publishing a projection as the schema would
      // state a table has three columns when it has thirty.
      interface Candidate {
        readonly relPath: string;
        readonly struct: GoStruct;
        readonly columns: readonly { field: GoStruct["fields"][number]; tag: GormTag }[];
      }
      const best = new Map<string, Candidate>();

      for (const relPath of goFiles) {
        let content: string;
        try {
          content = readFileSync(join(root.path, relPath), "utf8");
        } catch (error) {
          failures.push({
            scope: relPath,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (!content.includes("TableName") || !content.includes("struct")) continue;

        const parsed = parseSource("go", content);
        if (parsed.root === null) {
          failures.push({ scope: relPath, reason: parsed.reason ?? "the file could not be parsed" });
          continue;
        }

        const tables = tableNames(parsed.root, constants);
        if (tables.size === 0) continue;

        for (const struct of structsIn(parsed.root)) {
          const table = tables.get(struct.name);
          if (table === undefined) continue;

          const columns = struct.fields
            .map((field) => ({ field, tag: parseGormTag(field.tag) }))
            .filter((entry) => entry.tag.column !== null);
          if (columns.length === 0) continue;

          const existing = best.get(table);
          if (existing === undefined || columns.length > existing.columns.length) {
            best.set(table, { relPath, struct, columns });
          }
        }
      }

      for (const [table, candidate] of [...best.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        entities.push({
          rootName: root.name,
          name: table,
          kind: "table",
          qualifier: null,
          provenance: declared(lineRef(root.name, candidate.relPath, candidate.struct.line)),
        });

        for (const { field, tag } of candidate.columns) {
          const { type, nullable } = fieldTypeOf(field.goType);
          fields.push({
            rootName: root.name,
            entityName: table,
            name: tag.column!,
            declaredType: type,
            nullable: tag.notNull ? false : nullable ? true : null,
            defaultValue: null,
            isPrimaryKey: tag.primaryKey,
            provenance: declared(lineRef(root.name, candidate.relPath, field.line)),
          });

          if (tag.primaryKey) {
            constraints.push({
              rootName: root.name,
              entityName: table,
              fields: [tag.column!],
              kind: "primary-key",
              expression: null,
              provenance: declared(lineRef(root.name, candidate.relPath, field.line)),
            });
          }
        }
      }

      return {
        providerId: PROVIDER_ID,
        providerVersion: PROVIDER_VERSION,
        rootName: root.name,
        records: { entities, fields, relations, constraints },
        gaps: [],
        failures,
      };
    },
  };
}
