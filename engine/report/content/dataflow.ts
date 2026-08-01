/**
 * The developer report's data model, side effects, integrations and control boundaries.
 *
 * This renders the effects a developer must see to reason about impact: the data
 * entities and their reads/writes/transactions, the external interactions (HTTP,
 * queue, event, notification), and the control boundaries (authentication,
 * authorization, validation, exception handling). Each entry keeps its operation
 * kind, its triggering fact id, its source location and its resolution — a read is
 * never shown as a write, a configured dependency is kept distinct from a
 * reachable call, and an unresolved target or unknown operation is preserved as
 * such rather than smoothed into a definite one.
 *
 * Pure — facts in, structured content out. Nothing re-scans source, swaps an
 * operation kind, or resolves an unknown by guessing.
 */

import type { FactKind } from "../../contracts/shared-fact/families.js";
import { stableStringify } from "../../contracts/shared-fact/merge.js";
import type { Confidence, SourceRef } from "../../contracts/shared-fact/provenance.js";

export const DATA_EFFECTS_SCHEMA = "data-effects.v1";
export const MODULE_DATA_CONTROL_SCHEMA = "module-data-control.v1";
export const CONTROL_SCHEMA = "control.v1";

function hasCitation(ref: SourceRef): boolean {
  return ref.rootName.length > 0 && ref.relPath.length > 0;
}

// id-primary for a readable order, then a stable fallback on the whole record so
// two records that collide on id (a tracked possibility) still order totally.
const byId = <T extends { readonly id: string }>(xs: readonly T[]): T[] =>
  [...xs].sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    const ak = stableStringify(a);
    const bk = stableStringify(b);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

// ---------------------------------------------------------------------------
// Data model — entities, reads/writes, transactions.
// ---------------------------------------------------------------------------

/** Read, write, or unknown — never inferred, never swapped. */
export type DataOperation = "read" | "write" | "unknown";

export interface EntityRecord {
  readonly id: string;
  readonly name: string;
  readonly datastore: string;
  readonly citation: SourceRef;
}

export interface EntityRelationRecord {
  readonly id: string;
  readonly fromEntity: string;
  readonly toEntity: string;
  readonly kind: string;
  readonly citation: SourceRef;
}

export interface DataAccessRecord {
  readonly id: string;
  readonly entity: string;
  readonly operation: DataOperation;
  /** raw-sql, orm, key-value, … — the access mechanism, kept verbatim. */
  readonly mechanism: string;
  /** Whether the access is inside a transaction boundary. */
  readonly transactional: boolean;
  /** The transaction boundary the access belongs to — accesses sharing one span it together; null when not transactional. */
  readonly transactionId: string | null;
  /** The entry / trace step / decision / state transition this effect is triggered by, when known. */
  readonly triggeredBy: string | null;
  readonly confidence: Confidence;
  readonly citation: SourceRef;
}

export interface TransactionBoundary {
  readonly transactionId: string;
  /** The accesses that share this boundary — its read/write span. */
  readonly accessIds: readonly string[];
}

export interface DataModel {
  readonly entities: readonly EntityRecord[];
  readonly relations: readonly EntityRelationRecord[];
  readonly accesses: readonly DataAccessRecord[];
  readonly counts: Readonly<Record<DataOperation, number>>;
  readonly transactionalAccesses: number;
  /** Which accesses share a transaction boundary — the begin/commit spans. */
  readonly transactionBoundaries: readonly TransactionBoundary[];
  readonly datastores: readonly string[];
}

const sortStrings = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

export function renderDataModel(
  entities: readonly EntityRecord[],
  relations: readonly EntityRelationRecord[],
  accesses: readonly DataAccessRecord[],
): DataModel {
  const counts: Record<DataOperation, number> = { read: 0, write: 0, unknown: 0 };
  for (const a of accesses) counts[a.operation] += 1;

  const spanByTx = new Map<string, string[]>();
  for (const a of byId(accesses)) {
    if (a.transactionId === null) continue;
    (spanByTx.get(a.transactionId) ?? spanByTx.set(a.transactionId, []).get(a.transactionId)!).push(a.id);
  }
  const transactionBoundaries = [...spanByTx.keys()]
    .sort()
    .map((transactionId) => ({ transactionId, accessIds: [...spanByTx.get(transactionId)!].sort() }));

  return {
    entities: byId(entities),
    relations: byId(relations),
    accesses: byId(accesses),
    counts,
    transactionalAccesses: accesses.filter((a) => a.transactional).length,
    transactionBoundaries,
    datastores: sortStrings(entities.map((e) => e.datastore)),
  };
}

// ---------------------------------------------------------------------------
// External interactions — HTTP, queue, event, notification.
// ---------------------------------------------------------------------------

export type InteractionKind = "http" | "queue" | "event" | "notification" | "other";
export type TargetResolution = "resolved" | "heuristic" | "unresolved";
/** A configured dependency, a reachable call, or one whose production use is unconfirmed. */
export type Activation = "declared-config" | "reachable" | "unconfirmed";

export interface ExternalInteractionRecord {
  readonly id: string;
  readonly kind: InteractionKind;
  readonly target: string;
  readonly operation: string;
  readonly resolution: TargetResolution;
  readonly activation: Activation;
  readonly triggeredBy: string | null;
  readonly confidence: Confidence;
  /** Why the target could not be resolved — required when resolution is `unresolved`. */
  readonly unresolvedReason: string | null;
  readonly citation: SourceRef;
}

export interface InteractionSet {
  readonly interactions: readonly ExternalInteractionRecord[];
  readonly byKind: Readonly<Record<InteractionKind, number>>;
  readonly byResolution: Readonly<Record<TargetResolution, number>>;
  readonly byActivation: Readonly<Record<Activation, number>>;
  readonly total: number;
}

export function renderExternalInteractions(records: readonly ExternalInteractionRecord[]): InteractionSet {
  const interactions = byId(records);
  const byKind: Record<InteractionKind, number> = { http: 0, queue: 0, event: 0, notification: 0, other: 0 };
  const byResolution: Record<TargetResolution, number> = { resolved: 0, heuristic: 0, unresolved: 0 };
  const byActivation: Record<Activation, number> = { "declared-config": 0, reachable: 0, unconfirmed: 0 };
  for (const i of interactions) {
    byKind[i.kind] += 1;
    byResolution[i.resolution] += 1;
    byActivation[i.activation] += 1;
  }
  return { interactions, byKind, byResolution, byActivation, total: interactions.length };
}

// ---------------------------------------------------------------------------
// Control boundaries — auth, validation, exception handling.
// ---------------------------------------------------------------------------

export type ControlKind = "authentication" | "authorization" | "validation" | "exception-handling";

export interface ControlRecord {
  readonly id: string;
  readonly kind: ControlKind;
  readonly subject: string;
  /** The requirement (a role, a rule), kept verbatim; null when none is declared. */
  readonly requirement: string | null;
  /** The branch this control guards, when it guards one. */
  readonly guardedBranch: string | null;
  /** A swallowed/discarded error — surfaced, not hidden. */
  readonly discarded: boolean;
  readonly citation: SourceRef;
}

export interface ControlSet {
  readonly controls: readonly ControlRecord[];
  readonly byKind: Readonly<Record<ControlKind, number>>;
  readonly discardedErrors: number;
  readonly total: number;
}

export function renderControlBoundaries(records: readonly ControlRecord[]): ControlSet {
  const controls = byId(records);
  const byKind: Record<ControlKind, number> = { authentication: 0, authorization: 0, validation: 0, "exception-handling": 0 };
  for (const c of controls) byKind[c.kind] += 1;
  return { controls, byKind, discardedErrors: controls.filter((c) => c.discarded).length, total: controls.length };
}

// ---------------------------------------------------------------------------
// Validators.
// ---------------------------------------------------------------------------

export type ContentValidation = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Every data access keeps a definite operation kind and a citation; a read is
 * never a write. The operation counts reconcile with the accesses, and entity,
 * access and relation ids are unique — so nothing is dropped, miscounted, or
 * carried twice under one id.
 */
export function validateDataModel(model: DataModel, accesses: readonly DataAccessRecord[]): ContentValidation {
  const reasons: string[] = [];
  const summed = model.counts.read + model.counts.write + model.counts.unknown;
  if (summed !== accesses.length) reasons.push(`operation counts sum to ${summed}, not ${accesses.length}`);
  for (const a of model.accesses) {
    if (!hasCitation(a.citation)) reasons.push(`data access ${a.id} has no citation`);
  }
  if (model.entities.length !== new Set(model.entities.map((e) => e.id)).size) reasons.push("duplicate entity");
  if (model.accesses.length !== new Set(model.accesses.map((a) => a.id)).size) reasons.push("duplicate data access");
  if (model.relations.length !== new Set(model.relations.map((r) => r.id)).size) reasons.push("duplicate relation");
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function validateInteractions(set: InteractionSet): ContentValidation {
  const reasons: string[] = [];
  const byKind = set.byKind.http + set.byKind.queue + set.byKind.event + set.byKind.notification + set.byKind.other;
  if (byKind !== set.total) reasons.push(`kinds sum to ${byKind}, not ${set.total}`);
  const byRes = set.byResolution.resolved + set.byResolution.heuristic + set.byResolution.unresolved;
  if (byRes !== set.total) reasons.push(`resolutions sum to ${byRes}, not ${set.total}`);
  const byAct = set.byActivation["declared-config"] + set.byActivation.reachable + set.byActivation.unconfirmed;
  if (byAct !== set.total) reasons.push(`activations sum to ${byAct}, not ${set.total}`);
  if (set.interactions.length !== new Set(set.interactions.map((i) => i.id)).size) reasons.push("duplicate interaction");
  for (const i of set.interactions) {
    if (!hasCitation(i.citation)) reasons.push(`interaction ${i.id} has no citation`);
    // An unresolved target must carry a structured reason — nothing unlocatable
    // slips through as a bare "unresolved".
    if (i.resolution === "unresolved" && (i.unresolvedReason === null || i.unresolvedReason.length === 0)) {
      reasons.push(`interaction ${i.id} is unresolved with no structured reason`);
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export function validateControls(set: ControlSet): ContentValidation {
  const reasons: string[] = [];
  const summed = set.byKind.authentication + set.byKind.authorization + set.byKind.validation + set.byKind["exception-handling"];
  if (summed !== set.total) reasons.push(`control kinds sum to ${summed}, not ${set.total}`);
  if (set.controls.length !== new Set(set.controls.map((c) => c.id)).size) reasons.push("duplicate control");
  for (const c of set.controls) if (!hasCitation(c.citation)) reasons.push(`control ${c.id} has no citation`);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// Authored-block contracts.
// ---------------------------------------------------------------------------

export interface AuthoredBlockContract {
  readonly blockId: string;
  readonly outputSchemaId: string;
  readonly promptId: string;
  readonly citationRule: "required";
  readonly validatorId: string;
  readonly inputFactKinds: readonly FactKind[];
  readonly prompt: string;
}

const DEVELOPER_RULES = [
  "Write for a developer: keep real entity, table, endpoint, symbol names and source locations verbatim, and cite every claim by its fact id.",
  "Keep a read distinct from a write, and a configured dependency distinct from a reachable call; never swap an operation kind or resolve an unknown by guessing.",
  "Mark unresolved targets, unknown operations, discarded errors and activation state rather than smoothing them over.",
  "Do not infer production version, traffic, capacity, incidents or alerting from repository configuration; say unknown.",
].join("\n");

/** project-control-boundaries.notes — the auth/permission/validation control notes. */
export const CONTROL_NOTES_BLOCK: AuthoredBlockContract = {
  blockId: "project-control-boundaries.notes",
  outputSchemaId: "control-notes.v1",
  promptId: "control-notes.v1",
  citationRule: "required",
  validatorId: "control-notes.v1",
  inputFactKinds: ["auth-annotation"],
  prompt: `Explain the authentication, authorization and validation control boundaries you are given, and the branches they guard.\n\n${DEVELOPER_RULES}`,
};

/** module-data-control-errors.notes — the error-path notes for the module. */
export const MODULE_ERROR_NOTES_BLOCK: AuthoredBlockContract = {
  blockId: "module-data-control-errors.notes",
  outputSchemaId: "module-error-notes.v1",
  promptId: "module-error-notes.v1",
  citationRule: "required",
  validatorId: "module-error-notes.v1",
  inputFactKinds: ["error-handling"],
  prompt: `Explain the error and exception paths you are given, including any discarded/swallowed errors.\n\n${DEVELOPER_RULES}`,
};

export const DEV_DATAFLOW_AUTHORED_BLOCKS: readonly AuthoredBlockContract[] = [CONTROL_NOTES_BLOCK, MODULE_ERROR_NOTES_BLOCK];

/** The deterministic renderer → catalog block-id bindings, verifiable against the catalog. */
export const DATAFLOW_SCHEMA_BLOCKS: readonly { readonly blockId: string; readonly outputSchemaId: string }[] = [
  { blockId: "project-data-effects.model", outputSchemaId: DATA_EFFECTS_SCHEMA },
  { blockId: "project-control-boundaries.facts", outputSchemaId: CONTROL_SCHEMA },
  { blockId: "module-data-control-errors.facts", outputSchemaId: MODULE_DATA_CONTROL_SCHEMA },
];
