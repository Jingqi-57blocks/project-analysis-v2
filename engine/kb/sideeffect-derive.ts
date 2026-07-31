/**
 * Unifying data access, transactions and external interactions into side-effect
 * facts (PI-12).
 *
 * A side effect is what a behaviour does to the world outside its own decision —
 * a row written, a transaction opened, a request sent, a message published, a
 * notification fired. Those already come from several readers (outbound, uicalls,
 * datamodel usage, conventions); this is the adapter that lifts them into the
 * shared behaviour contract (PI-62) under one identity, not a second side-effect
 * model. Its kinds are exactly PI-12's owned set — outbound-call, data-access,
 * notification-call, transaction-boundary — disjoint from PI-11's decision/state
 * kinds by the contract's ownership check, so one fact is never extracted twice.
 *
 * An external library call (`ExternalCallRecord`) is unified under `outbound-call`
 * with a `category` of `external-package`, distinct from a `service` HTTP/RPC call
 * — a call leaving the process is a call leaving the process, whether it crosses a
 * network or a package boundary, and keeping it one kind is the point of the task.
 *
 * Each fact keeps its source record's own resolution and confidence, and carries
 * the caller symbol so a later pass can connect the effect to the entry, decision
 * or state that triggers it. A dynamic target or an undetermined operation is kept
 * as an unresolved finding, never dropped.
 */

import type { EvidenceRecord, ProviderAttribution } from "../contracts/shared-fact/evidence.js";
import { factId } from "../contracts/shared-fact/identity.js";
import type { Provenance } from "../contracts/shared-fact/provenance.js";
import {
  BEHAVIOR_SCHEMA_VERSION,
  type BehaviorFact,
  type BehaviorModel,
  type BehaviorPayload,
  type BehaviorScope,
} from "../contracts/behavior/schema.js";
import type { DataAccessRecord, ExternalCallRecord, OutboundCallRecord } from "../structural/boundaries.js";
import type { NotificationCallRecord, TransactionBoundaryRecord } from "../structural/rules.js";

const DATAMODEL: ProviderAttribution = { providerId: "datamodel-usage", providerVersion: "1.0.0" };
const OUTBOUND: ProviderAttribution = { providerId: "outbound", providerVersion: "1.0.0" };
const CONVENTIONS: ProviderAttribution = { providerId: "conventions", providerVersion: "1.0.0" };

export interface SideEffectDeriveInput {
  readonly dataAccess: readonly DataAccessRecord[];
  readonly transactions: readonly TransactionBoundaryRecord[];
  readonly outbound: readonly OutboundCallRecord[];
  readonly external: readonly ExternalCallRecord[];
  readonly notifications: readonly NotificationCallRecord[];
}

function ev(attribution: ProviderAttribution, provenance: Provenance): EvidenceRecord {
  return { attribution, provenance };
}

function pl<T extends BehaviorPayload>(payload: T): BehaviorPayload {
  return payload;
}

function scopeOf(symbolId: string | null): BehaviorScope {
  return symbolId !== null ? "symbol" : "module";
}

function loc(p: Provenance): string {
  return `${p.source.relPath}:${p.source.startLine ?? "?"}`;
}

function dataAccessFact(d: DataAccessRecord): BehaviorFact {
  return {
    factId: factId({
      family: "behavioral",
      kind: "data-access",
      discriminators: [d.rootName, loc(d.provenance), d.operation, d.mechanism, d.entity ?? ""],
    }),
    family: "behavioral",
    kind: "data-access",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(DATAMODEL, d.provenance)],
    rawIdentities: [],
    payload: pl({
      scope: scopeOf(d.symbolId),
      activation: "always",
      symbol: d.symbolId,
      entity: d.entity,
      operation: d.operation,
      mechanism: d.mechanism,
      // A dynamically-built table name is a real unresolved finding, kept.
      link: d.entity !== null ? "resolved" : "unresolved",
    }),
  };
}

function transactionFact(t: TransactionBoundaryRecord): BehaviorFact {
  return {
    factId: factId({
      family: "behavioral",
      kind: "transaction-boundary",
      discriminators: [t.rootName, t.source.relPath, String(t.source.startLine), t.mechanism, t.propagation ?? ""],
    }),
    family: "behavioral",
    kind: "transaction-boundary",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(CONVENTIONS, t.provenance)],
    rawIdentities: [],
    payload: pl({
      scope: scopeOf(t.symbolId),
      activation: "always",
      symbol: t.symbolId,
      mechanism: t.mechanism,
      propagation: t.propagation,
    }),
  };
}

function outboundFact(o: OutboundCallRecord): BehaviorFact {
  return {
    factId: factId({
      family: "behavioral",
      kind: "outbound-call",
      discriminators: [o.rootName, loc(o.provenance), "service", o.kind, o.method ?? "", o.target ?? o.baseIdentifier ?? ""],
    }),
    family: "behavioral",
    kind: "outbound-call",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(OUTBOUND, o.provenance)],
    rawIdentities: [],
    payload: pl({
      scope: scopeOf(o.callerSymbolId),
      activation: "always",
      symbol: o.callerSymbolId,
      category: "service",
      outboundKind: o.kind,
      method: o.method,
      target: o.target,
      baseIdentifier: o.baseIdentifier,
      // A composed base whose service is deployment config is unresolved until bound.
      link: o.target !== null ? "resolved" : "unresolved",
    }),
  };
}

function externalFact(x: ExternalCallRecord): BehaviorFact {
  const target = x.memberName !== null ? `${x.packageName}.${x.memberName}` : x.packageName;
  return {
    factId: factId({
      family: "behavioral",
      kind: "outbound-call",
      discriminators: [x.rootName, loc(x.provenance), "external-package", x.packageName, x.memberName ?? ""],
    }),
    family: "behavioral",
    kind: "outbound-call",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(OUTBOUND, x.provenance)],
    rawIdentities: [],
    payload: pl({
      scope: scopeOf(x.callerSymbolId),
      activation: "always",
      symbol: x.callerSymbolId,
      category: "external-package",
      outboundKind: "library",
      target,
      packageName: x.packageName,
      memberName: x.memberName,
      link: "resolved",
    }),
  };
}

function notificationFact(n: NotificationCallRecord): BehaviorFact {
  return {
    factId: factId({
      family: "behavioral",
      kind: "notification-call",
      discriminators: [n.rootName, n.source.relPath, String(n.source.startLine), n.channel, n.mechanism],
    }),
    family: "behavioral",
    kind: "notification-call",
    schemaVersion: BEHAVIOR_SCHEMA_VERSION,
    evidence: [ev(CONVENTIONS, n.provenance)],
    rawIdentities: [],
    payload: pl({
      scope: "module",
      activation: "always",
      channel: n.channel,
      mechanism: n.mechanism,
    }),
  };
}

/**
 * Derive the side-effect slice of the behaviour model. Every record becomes one
 * fact keyed by canonical id (so a re-read never double-counts), keeping its own
 * resolution; external library calls join HTTP/RPC calls under one outbound-call
 * kind, categorized apart.
 */
export function deriveSideEffectBehavior(input: SideEffectDeriveInput): BehaviorModel {
  const facts: BehaviorFact[] = [];
  const seen = new Set<string>();
  const add = (fact: BehaviorFact): void => {
    if (seen.has(fact.factId)) return;
    seen.add(fact.factId);
    facts.push(fact);
  };

  for (const d of input.dataAccess) add(dataAccessFact(d));
  for (const t of input.transactions) add(transactionFact(t));
  for (const o of input.outbound) add(outboundFact(o));
  for (const x of input.external) add(externalFact(x));
  for (const n of input.notifications) add(notificationFact(n));

  return { schemaVersion: BEHAVIOR_SCHEMA_VERSION, facts, relations: [] };
}
