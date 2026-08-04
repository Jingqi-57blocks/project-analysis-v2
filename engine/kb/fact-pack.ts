/**
 * Bounded fact packs.
 *
 * The skill never sees the knowledge base — it sees a pack cut to one scope and
 * to exactly the kinds its spec declares. That boundary is the only reliable one:
 * the three-model trial showed that an agent handed the whole store decides for
 * itself what to look at, so "only generate the leave module" cannot be enforced
 * by wording in a prompt.
 *
 * The pack also carries its own coverage accounting, so the audit can compute
 * what share of the available facts a report actually used, and expands set-valued
 * kinds into member-level subjects so a claim about "one role" has something
 * stable to attach to.
 */

import {
  KB_TABLES,
  SET_VALUED_KINDS,
  isLineAnchored,
  isReadableKind,
  isWorkspaceLevelKind,
  tablesFor,
} from "../contracts/kb/read-contract.js";
import type { Store } from "../store/types.js";

export interface PackRow {
  readonly table: string;
  readonly kind: string;
  /** `record_key` or `fact_id`, per the read contract's identity column. */
  readonly key: string;
  readonly payload: unknown;
  readonly rootName: string | null;
  readonly relPath: string | null;
  readonly startLine: number | null;
  readonly subjectKey: string | null;
}

export interface KindCoverage {
  readonly kind: string;
  readonly table: string;
  /** Rows of this kind in the snapshot, before scoping. */
  readonly inSnapshot: number;
  /** Rows that survived the scope filter, and so are in the pack. */
  readonly inScope: number;
}

/**
 * Something a claim may take as its subject. Never line-anchored: a subject whose
 * identity moves when lines shift cannot carry a stable claimId.
 */
export interface SubjectRef {
  readonly type: string;
  readonly ref: string;
  /** The row that evidences the subject exists. */
  readonly factKey: string;
}

export interface FactPack {
  readonly snapshotIdentity: string;
  readonly scope: string;
  /** The report-level module id as requested, or null for project scope. */
  readonly moduleId: string | null;
  /** The knowledge-base module id it resolved to, or null when unresolved. */
  readonly kbModuleId: string | null;
  readonly requires: readonly string[];
  readonly rows: readonly PackRow[];
  readonly coverage: readonly KindCoverage[];
  readonly subjects: readonly SubjectRef[];
}

export interface PackRequest {
  readonly scope: string;
  readonly requires: readonly string[];
  /** Required when scope is not "project". */
  readonly moduleId?: string;
  /** Files, qualified `root/relPath`, that make up the module. */
  readonly moduleFiles?: ReadonlySet<string>;
  /**
   * Identities the module owns: its own module ids and its feature ids. Derived
   * rows describe a subject rather than a place, so they carry no file path and
   * would otherwise be excluded wholesale — taking the module's own shape, flows
   * and traces out of exactly the report that is about it.
   */
  readonly subjectKeys?: ReadonlySet<string>;
  readonly kbModuleId?: string | null;
}

function parsePayload(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * Expands a set-valued row into one subject per member.
 *
 * A `value-set` row is one declaration site holding many members, so without this
 * "how many roles are there" has no member-level subject to disagree about, and
 * two reports counting differently produce no detectable conflict. The row itself
 * stays in the pack as the supporting fact.
 */
function membersOf(payload: unknown): readonly string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const record = payload as Record<string, unknown>;
  const candidates = [record["values"], record["members"], record["entries"]];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map((item) => {
          if (typeof item === "string") return item;
          if (typeof item === "object" && item !== null) {
            const entry = item as Record<string, unknown>;
            return text(entry["name"]) ?? text(entry["value"]) ?? text(entry["label"]);
          }
          return null;
        })
        .filter((name): name is string => name !== null && name.length > 0);
    }
  }
  return [];
}

/**
 * Provenance a row carries in its payload rather than in a column.
 *
 * `behavior_facts` has no `rel_path` column, so without this every behaviour fact
 * in the workspace passes a module scope filter untouched. That leak is invisible
 * to a check that only inspects rows which already have a path — the rows without
 * one are exactly the ones escaping.
 */
function provenanceOf(payload: unknown): { rootName: string | null; relPath: string | null } {
  if (typeof payload !== "object" || payload === null) return { rootName: null, relPath: null };
  const record = payload as Record<string, unknown>;
  const direct = record["source"];
  const viaProvenance =
    typeof record["provenance"] === "object" && record["provenance"] !== null
      ? (record["provenance"] as Record<string, unknown>)["source"]
      : undefined;
  for (const candidate of [direct, viaProvenance]) {
    if (typeof candidate === "object" && candidate !== null) {
      const source = candidate as Record<string, unknown>;
      const relPath = text(source["relPath"]);
      if (relPath !== null) return { rootName: text(source["rootName"]), relPath };
    }
  }
  return { rootName: text(record["rootName"]), relPath: null };
}

function readKind(store: Store, snapshotId: number, kind: string): readonly PackRow[] {
  const rows: PackRow[] = [];
  for (const table of tablesFor(kind)) {
    const identity = table.identityColumn;
    const columns =
      table.table === "behavior_facts"
        ? `${identity} as key, kind, payload, scope as subject_key, null as root_name, null as rel_path, null as start_line`
        : table.table === "derived_records"
          ? `${identity} as key, kind, payload, subject_key, root_name, rel_path, start_line`
          : `${identity} as key, kind, payload, null as subject_key, null as root_name, rel_path, start_line`;
    const result = store.all(
      `select ${columns} from ${table.table} where snapshot_id = ? and kind = ?`,
      [snapshotId, kind],
    ) as readonly Record<string, unknown>[];
    for (const raw of result) {
      const payload = parsePayload(raw["payload"]);
      const carried = provenanceOf(payload);
      rows.push({
        table: table.table,
        kind,
        key: String(raw["key"]),
        payload,
        rootName: text(raw["root_name"]) ?? carried.rootName,
        relPath: text(raw["rel_path"]) ?? carried.relPath,
        startLine: integer(raw["start_line"]),
        subjectKey: text(raw["subject_key"]),
      });
    }
  }
  return rows;
}

export class UnknownFactKindError extends Error {
  constructor(readonly kind: string) {
    super(`fact kind is not served by the knowledge-base read contract: ${kind}`);
    this.name = "UnknownFactKindError";
  }
}

/**
 * Cuts a pack for one scope and one spec's declared kinds.
 *
 * Module scoping filters on the membership file set the caller resolved. Only the
 * kinds the read contract marks workspace-level bypass that filter; a row of any
 * other kind that cannot say where it lives is excluded rather than admitted.
 */
export function buildFactPack(store: Store, snapshotId: number, snapshotIdentity: string, request: PackRequest): FactPack {
  for (const kind of request.requires) {
    if (!isReadableKind(kind)) throw new UnknownFactKindError(kind);
  }
  const scoped = request.scope === "project" ? undefined : (request.moduleFiles ?? new Set<string>());
  const subjectKeys = request.subjectKeys ?? new Set<string>();
  const rows: PackRow[] = [];
  const coverage: KindCoverage[] = [];
  const subjects: SubjectRef[] = [];
  const seenSubjects = new Set<string>();

  for (const kind of [...new Set(request.requires)].sort()) {
    const all = readKind(store, snapshotId, kind);
    const kept = all.filter((row) => inScope(kind, row, scoped, subjectKeys));
    rows.push(...kept);
    for (const table of tablesFor(kind)) {
      coverage.push({
        kind,
        table: table.table,
        inSnapshot: all.filter((row) => row.table === table.table).length,
        inScope: kept.filter((row) => row.table === table.table).length,
      });
    }
    if (SET_VALUED_KINDS.includes(kind)) {
      for (const row of kept) {
        for (const member of membersOf(row.payload)) {
          const ref = `${kind}:${member}`;
          if (seenSubjects.has(ref)) continue;
          seenSubjects.add(ref);
          subjects.push({ type: kind, ref: member, factKey: row.key });
        }
      }
      continue;
    }
    if (isLineAnchored(kind)) continue;
    for (const row of kept) {
      const ref = `${kind}:${row.key}`;
      if (seenSubjects.has(ref)) continue;
      seenSubjects.add(ref);
      subjects.push({ type: kind, ref: row.key, factKey: row.key });
    }
  }

  return {
    snapshotIdentity,
    scope: request.scope,
    moduleId: request.moduleId ?? null,
    kbModuleId: request.kbModuleId ?? null,
    requires: [...request.requires],
    rows,
    coverage,
    subjects,
  };
}

/**
 * Whether a row belongs in a scoped pack.
 *
 * Workspace-level kinds are kept whatever the scope — dropping the coverage
 * ledger and the computed findings from every module report would leave the
 * report unable to state its own coverage. Everything else must place itself
 * inside the module's files; a row that cannot say where it is does not qualify.
 */
function inScope(
  kind: string,
  row: PackRow,
  files: ReadonlySet<string> | undefined,
  subjectKeys: ReadonlySet<string>,
): boolean {
  if (files === undefined) return true;
  if (isWorkspaceLevelKind(kind)) return true;
  if (row.subjectKey !== null && subjectKeys.has(row.subjectKey)) return true;
  if (subjectKeys.has(row.key)) return true;
  if (row.rootName === null || row.relPath === null) return false;
  return files.has(`${row.rootName}/${row.relPath}`);
}

/** Total rows in the pack — the denominator the audit divides usage by. */
export function packSize(pack: FactPack): number {
  return pack.rows.length;
}

/** Kinds the spec asked for that the pack has no rows of, in scope. */
export function emptyKinds(pack: FactPack): readonly string[] {
  const nonEmpty = new Set(pack.rows.map((row) => row.kind));
  return pack.requires.filter((kind) => !nonEmpty.has(kind)).sort();
}

/** Every table this pack drew a given kind from — see MULTI_TABLE_KINDS. */
export function tablesUsedFor(pack: FactPack, kind: string): readonly string[] {
  return [...new Set(pack.rows.filter((row) => row.kind === kind).map((row) => row.table))].sort();
}

/** The tables the read contract declares, for a caller building its own reader. */
export const PACK_TABLES = KB_TABLES;
