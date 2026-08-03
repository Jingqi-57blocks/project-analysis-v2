/**
 * The knowledge-base read contract.
 *
 * What a report-generating agent is allowed to read, and how. In the three-model
 * trial every agent had to discover the payload shapes by probing — 13 to 198
 * queries of exploration, with no guarantee any of them found the same thing.
 * Without a versioned contract a schema change makes the skill fail silently:
 * it still produces a well-formatted report, just one missing whatever it can no
 * longer see.
 *
 * This module fixes the vocabulary. It does not query anything, and it never
 * reads a target folder, so it loads in CI with no targets present.
 */

import { BEHAVIOR_KINDS } from "../behavior/schema.js";
import { DERIVED_KINDS } from "../../kb/kinds.js";
import { STRUCTURAL_KINDS } from "../../structural/kinds.js";

export const KB_CONTRACT_ID = "kb-read";
export const KB_CONTRACT_VERSION = "1.0.0";

/**
 * Which layer a kind belongs to. The distinction is load-bearing for readers:
 * `derived` rows are conclusions the engine already computed, `raw` rows are the
 * evidence underneath them.
 */
export type FactLayer = "raw" | "derived";

export interface KbTable {
  readonly table: string;
  /** The column that makes a row unique within a snapshot. */
  readonly identityColumn: string;
  readonly layer: FactLayer;
  readonly kinds: readonly string[];
  /** Columns a reader may depend on. Anything else is an implementation detail. */
  readonly publicColumns: readonly string[];
  readonly note: string;
}

export const KB_TABLES: readonly KbTable[] = [
  {
    table: "structural_records",
    identityColumn: "record_key",
    layer: "raw",
    kinds: [...STRUCTURAL_KINDS],
    publicColumns: ["kind", "record_key", "payload", "resolution_class", "confidence", "rel_path", "start_line"],
    note: "Structure read straight from source: symbols, routes, entities, call edges, guards, data accesses.",
  },
  {
    table: "behavior_facts",
    identityColumn: "fact_id",
    layer: "raw",
    kinds: [...BEHAVIOR_KINDS],
    publicColumns: ["fact_id", "kind", "family", "scope", "activation", "schema_version", "payload", "quarantined"],
    note: "Behaviour observed over the structure: rules, validations, states, transitions, value sets, test relations.",
  },
  {
    table: "derived_records",
    identityColumn: "record_key",
    layer: "derived",
    kinds: [...DERIVED_KINDS],
    publicColumns: ["kind", "record_key", "payload", "subject_key", "root_name", "severity", "rel_path", "start_line"],
    note: "Conclusions the engine already computed, plus the coverage ledger.",
  },
];

/**
 * Reading order, stated rather than left for the model to discover.
 *
 * In the trial the agents that produced accurate reports read the derived layer
 * first and drilled into raw facts on demand; the one that fabricated never
 * queried `structural-finding`, `health-signal` or `coverage-note` at all and
 * still filled in the chapters they feed. Making the order part of the contract
 * removes the dependence on the model noticing.
 */
export const READING_ORDER: readonly string[] = [
  "run-context — the snapshot, the roots and what was read",
  "coverage-note — the coverage ledger; read before writing any coverage statement",
  "health-signal — computed coverage and reachability signals",
  "structural-finding — computed cross-cutting findings, each with its own evidence list",
  "module, feature, feature-flow, trace — the computed shape of the system",
  "raw structural and behaviour records — the evidence under any of the above",
];

/** Every kind a reader may name, across all three tables. */
export const READABLE_KINDS: readonly string[] = [
  ...new Set([...STRUCTURAL_KINDS, ...BEHAVIOR_KINDS, ...DERIVED_KINDS]),
].sort();

const READABLE = new Set(READABLE_KINDS);

export function isReadableKind(kind: string): boolean {
  return READABLE.has(kind);
}

/** Every table serving a kind, in declaration order. Empty when unreadable. */
export function tablesFor(kind: string): readonly KbTable[] {
  return KB_TABLES.filter((table) => table.kinds.includes(kind));
}

/**
 * Kinds served by more than one table.
 *
 * This is the contract's sharpest trap. `structural_records` holds what was read
 * straight from source; `behavior_facts` holds the behavioural view of the same
 * kind, which for several of them contains additional rows. On the reference
 * snapshot, `condition` is 1957 structural against 5780 behavioural,
 * `auth-annotation` 113 against 434, `decision` 983 against 1842 — while
 * `data-access`, `guard`, `error-handling`, `transaction-boundary` and
 * `discarded-error` are identical in both.
 *
 * A report that states a count for one of these **MUST** name the table it
 * counted. Two chapters counting the same kind from different tables is a
 * contradiction the reader cannot detect and the author did not intend.
 */
export const MULTI_TABLE_KINDS: readonly string[] = READABLE_KINDS.filter(
  (kind) => KB_TABLES.filter((table) => table.kinds.includes(kind)).length > 1,
);

export function isMultiTableKind(kind: string): boolean {
  return MULTI_TABLE_KINDS.includes(kind);
}

/**
 * Kinds whose identity embeds a file line, measured on the reference snapshot.
 *
 * Their `record_key` changes whenever lines shift above them, so a claim MUST
 * NOT take its identity from them and MUST NOT use one as its subject. They are
 * still perfectly good supporting evidence. See
 * docs/pi-110-claim-identity-verification.md.
 */
export const LINE_ANCHORED_KINDS: readonly string[] = [
  "auth-annotation",
  "call-edge",
  "condition",
  "data-access",
  "decision",
  "discarded-error",
  "error-handling",
  "guard",
  "outbound-call",
  "value-set",
];

const LINE_ANCHORED = new Set(LINE_ANCHORED_KINDS);

export function isLineAnchored(kind: string): boolean {
  return LINE_ANCHORED.has(kind);
}

/**
 * Kinds that carry a set whose members have no rows of their own.
 *
 * A `value-set` row is one declaration site holding many members, so "how many
 * roles are there" cannot be pinned to a member-level subject unless the pack
 * expands it. The fact pack does that expansion; this list is what it keys on.
 */
export const SET_VALUED_KINDS: readonly string[] = ["value-set"];

/**
 * Kinds that describe the workspace as a whole, not a place in it.
 *
 * A scoped pack keeps these whatever the scope: a module report that dropped the
 * coverage ledger and the computed findings could not state its own coverage, and
 * the reader would have no way to tell an absent chapter from an empty one. Every
 * other kind must place itself inside the requested scope to be included.
 */
export const WORKSPACE_LEVEL_KINDS: readonly string[] = [
  "coverage-note",
  "health-signal",
  "run-context",
  "structural-finding",
];

const WORKSPACE_LEVEL = new Set(WORKSPACE_LEVEL_KINDS);

export function isWorkspaceLevelKind(kind: string): boolean {
  return WORKSPACE_LEVEL.has(kind);
}

export type KbContractValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

/** Internal consistency of the contract itself. */
export function validateKbContract(): KbContractValidation {
  const reasons: string[] = [];
  for (const table of KB_TABLES) {
    if (table.kinds.length === 0) reasons.push(`${table.table}: declares no kinds`);
    if (!table.publicColumns.includes(table.identityColumn)) {
      reasons.push(`${table.table}: identity column "${table.identityColumn}" is not public`);
    }
  }
  for (const kind of READABLE_KINDS) {
    if (tablesFor(kind).length === 0) reasons.push(`readable kind "${kind}" is served by no table`);
  }
  for (const kind of LINE_ANCHORED_KINDS) {
    if (!READABLE.has(kind)) reasons.push(`line-anchored kind "${kind}" is not a readable kind`);
  }
  for (const kind of SET_VALUED_KINDS) {
    if (!READABLE.has(kind)) reasons.push(`set-valued kind "${kind}" is not a readable kind`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
