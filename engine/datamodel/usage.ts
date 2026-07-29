/**
 * Resolves which physical table a piece of code reads or writes.
 *
 * A data-access record naming `models.leave` or `constant.TbLv` names an
 * indirection, not a table — and a flow that ends at "leave" has not reached
 * the database. Both indirections are declared in the same repository: an ORM
 * model file states its `tableName`, and a Go constant block states its
 * literal. Reading those declarations is the difference between a flow that
 * ends at the handler and one that ends where the data actually lives.
 *
 * A query assembled at runtime stays unresolved with the reason kept. Naming
 * a table there would be a guess, and a guess in a schema diagram is worse
 * than a gap.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseCalls, positionAt, scanSource } from "../text/scan.js";
import { inferred, resolved, unresolved } from "../structural/provenance.js";
import { emptyRecords } from "../structural/kinds.js";
import type { DataAccessRecord, DataOperation } from "../structural/boundaries.js";
import {
  ANY_LANGUAGE,
  declaredKinds,
  type ExtractionFailure,
  type ProviderCapabilities,
  type StructuralContribution,
  type StructuralProvider,
  type StructuralRootInput,
} from "../structural/provider.js";
import type { PreflightResult } from "../providers/types.js";

export const PROVIDER_ID = "data-usage";
export const PROVIDER_VERSION = "1.0.0";

const ORM_PATTERN = /\b(?:models|db|sequelize)\.([A-Za-z_$][\w$]*)\.(\w+)\s*\(/g;
const GO_TABLE_PATTERN = /\.Table\s*\(\s*([\w.]+)/g;

const OPERATIONS: Record<string, DataOperation> = {
  find: "read",
  findall: "read",
  findone: "read",
  findbypk: "read",
  findandcountall: "read",
  count: "read",
  aggregate: "read",
  create: "write",
  bulkcreate: "write",
  update: "write",
  upsert: "write",
  save: "write",
  increment: "write",
  decrement: "write",
  destroy: "delete",
  truncate: "delete",
};

/** `tableName: 'wcp_leave'` in a Sequelize model, keyed by the model's name. */
export function ormTableNames(relPath: string, content: string): Map<string, string> {
  const tables = new Map<string, string>();
  const match = /tableName:\s*['"]([^'"]+)['"]/.exec(content);
  if (match === null) return tables;

  const fileName = relPath.split("/").pop()!.replace(/\.[jt]s$/, "");
  tables.set(fileName.toLowerCase(), match[1]!);

  const defined = /(?:sequelize\.define|define)\s*\(\s*['"]([^'"]+)['"]/.exec(content);
  if (defined) tables.set(defined[1]!.toLowerCase(), match[1]!);

  return tables;
}

/** `TbLv TableName = "wcp_leave"` in a Go constant block, keyed by the constant. */
export function goTableConstants(content: string): Map<string, string> {
  const tables = new Map<string, string>();
  for (const match of content.matchAll(/\b([A-Z]\w*)\s+(?:\w+\s*)?=\s*"([\w.$-]+)"/g)) {
    tables.set(match[1]!, match[2]!);
  }
  return tables;
}

export function dataUsageCapabilities(): ProviderCapabilities {
  return {
    declarations: [
      {
        kind: "data-access",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: [
          "ORM model access and Go table constants are resolved to physical table names; a query assembled at runtime is recorded as unresolved",
          "raw SQL passed as a string to a driver is not parsed here",
          "the operation is read from the ORM method name; a method this reader does not know is recorded as an unknown operation rather than guessed",
          "for a Go chain the verb is read from the same statement as the table, so a query assembled across statements is unclassified",
          "access through a model whose table name is not declared in the repository stays at the model's name",
        ],
      },
    ],
  };
}

interface TableIndex {
  readonly orm: Map<string, string>;
  readonly go: Map<string, string>;
}

function buildTableIndex(root: StructuralRootInput): TableIndex {
  const orm = new Map<string, string>();
  const go = new Map<string, string>();

  for (const relPath of root.analyzedFiles) {
    try {
      if (/\bmodels?\//.test(relPath) && /\.[jt]s$/.test(relPath)) {
        const content = readFileSync(join(root.path, relPath), "utf8");
        for (const [name, table] of ormTableNames(relPath, content)) orm.set(name, table);
      } else if (relPath.endsWith(".go") && /table|constant/i.test(relPath)) {
        const content = readFileSync(join(root.path, relPath), "utf8");
        for (const [name, table] of goTableConstants(content)) go.set(name, table);
      }
    } catch {
      // A file that cannot be read contributes no names; the access records
      // that would have used them stay unresolved, which is visible.
    }
  }

  return { orm, go };
}

/**
 * What a `.Table(...)` call goes on to do with the table.
 *
 * The verb sits further along the same chain — `.Table(x).Where(...).Updates(...)`
 * — so reading only the Table call leaves every Go access unclassified, and a
 * service that writes a table then reads as one that merely reads it. That is
 * a false statement about ownership, not just a missing one.
 *
 * Bounded to the statement, so the next statement's verb is never borrowed.
 */
export function goOperationNear(content: string, index: number): DataOperation {
  const statement = content.slice(index, index + 400).split("\n\n")[0] ?? "";
  if (/\.(Create|Save|Updates?|FirstOrCreate|Insert)\s*\(/.test(statement)) return "write";
  if (/\.(Delete|Unscoped)\s*\(/.test(statement)) return "delete";
  if (/\.(Find|First|Last|Take|Scan|Pluck|Count|Rows|Select)\s*\(/.test(statement)) return "read";
  return "unknown";
}

function scanFile(
  root: StructuralRootInput,
  relPath: string,
  index: TableIndex,
  records: DataAccessRecord[],
  failures: ExtractionFailure[],
): void {
  const content = readFileSync(join(root.path, relPath), "utf8");
  const isGo = relPath.endsWith(".go");
  const map = scanSource(content, { hashLineComments: false });

  if (!isGo) {
    for (const call of parseCalls(content, map, ORM_PATTERN)) {
      const model = call.receiver.toLowerCase();
      const operation = OPERATIONS[call.method.toLowerCase()];
      if (operation === undefined) continue;

      const table = index.orm.get(model) ?? null;
      const source = {
        rootName: root.name,
        relPath,
        startLine: call.line,
        endLine: call.line,
        startColumn: positionAt(map, call.index).column,
        endColumn: null,
      };

      records.push({
        rootName: root.name,
        entity: table ?? model,
        operation,
        mechanism: "sequelize",
        symbolId: null,
        provenance: table === null ? inferred(source, "low") : resolved(source, "high"),
      });
      if (table === null) {
        failures.push({
          scope: `${relPath}:${call.line}`,
          reason: `no table name is declared for model "${model}"; the model name is kept in its place`,
        });
      }
    }
    return;
  }

  for (const match of content.matchAll(GO_TABLE_PATTERN)) {
    if (map.comment[match.index] === 1) continue;
    const expression = match[1]!;
    // `constant.TbWLog.String` names the constant in the middle: the last
    // segment is the method turning it into a string, so the lookup walks
    // back until a segment is one the repository declares.
    const table =
      expression
        .split(".")
        .reverse()
        .map((segment) => index.go.get(segment))
        .find((found) => found !== undefined) ?? null;
    const { line, column } = positionAt(map, match.index);
    const source = {
      rootName: root.name,
      relPath,
      startLine: line,
      endLine: line,
      startColumn: column,
      endColumn: null,
    };

    if (table === null) {
      records.push({
        rootName: root.name,
        entity: null,
        operation: "unknown",
        mechanism: "gorm",
        symbolId: null,
        provenance: unresolved(source, `"${expression}" does not resolve to a declared table name`),
      });
      continue;
    }

    records.push({
      rootName: root.name,
      entity: table,
      operation: goOperationNear(content, match.index),
      mechanism: "gorm",
      symbolId: null,
      provenance: resolved(source, "high"),
    });
  }
}

export function createDataUsageProvider(): StructuralProvider {
  const capabilities = dataUsageCapabilities();

  return {
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,
    capabilities: () => declaredKinds(capabilities),
    preflight: (): PreflightResult => ({ available: true, version: PROVIDER_VERSION }),
    structuralCapabilities: () => capabilities,

    extract(root: StructuralRootInput): StructuralContribution {
      const index = buildTableIndex(root);
      const records: DataAccessRecord[] = [];
      const failures: ExtractionFailure[] = [];

      for (const relPath of root.analyzedFiles) {
        if (!/\.(go|js|ts|cjs|mjs)$/.test(relPath)) continue;
        try {
          scanFile(root, relPath, index, records, failures);
        } catch (error) {
          failures.push({
            scope: relPath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        providerId: PROVIDER_ID,
        providerVersion: PROVIDER_VERSION,
        rootName: root.name,
        records: { ...emptyRecords(), "data-access": records },
        gaps: [],
        failures,
      };
    },
  };
}
