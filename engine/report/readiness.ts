/**
 * Whether a snapshot holds enough for the report someone is about to write.
 *
 * The analysis publishes what it managed to read. That is right: a reader that
 * was unavailable is a declared gap, not a reason to throw away everything the
 * others found. But it means a knowledge base can be published with no call
 * graph at all — the indexer was missing, or its index could not be read — and
 * nothing downstream noticed. A capability report written from that base has
 * every chapter, cites real rows in each, and describes a system in which
 * nothing calls anything.
 *
 * So the requirement is stated per report type, before the report is written
 * and again before it is delivered. What each type needs is a property of that
 * type, and the set is open: a new report type declares its own, and a type
 * that needs nothing in particular says so by having no entry.
 */

import type { Store } from "../store/types.js";

/**
 * What a report type cannot be written without.
 *
 * A project overview is deliberately absent. It describes shape — parts, roots,
 * files, entities — and stays truthful on a base with no call graph, provided
 * the coverage chapter says so. A capability report is the opposite: it is
 * about how one flow moves through the system, and without edges, routes, data
 * access or behaviour there is no flow to describe, only a list.
 */
const REQUIRED_BY_SPEC: Readonly<Record<string, readonly string[]>> = {
  "feature-product": ["call-edge", "route", "data-access", "behavior-fact"],
};

/** Every signal reported, required or not, so a thin base is legible either way. */
const REPORTED_SIGNALS: readonly string[] = [
  "call-edge",
  "route",
  "data-access",
  "entity",
  "outbound-call",
  "behavior-fact",
];

export interface ReadinessSignal {
  readonly kind: string;
  readonly count: number;
  readonly required: boolean;
}

export interface Readiness {
  readonly specId: string;
  /** False when something this report type cannot be written without is absent. */
  readonly ready: boolean;
  /** Required kinds the snapshot holds none of. */
  readonly missing: readonly string[];
  readonly signals: readonly ReadinessSignal[];
}

function countOf(store: Store, snapshotId: number, kind: string): number {
  if (kind === "behavior-fact") {
    return store.get<{ n: number }>("select count(*) as n from behavior_facts where snapshot_id = ?", [snapshotId])?.n ?? 0;
  }
  return (
    store.get<{ n: number }>("select count(*) as n from structural_records where snapshot_id = ? and kind = ?", [
      snapshotId,
      kind,
    ])?.n ?? 0
  );
}

export function reportReadiness(store: Store, snapshotId: number, specId: string): Readiness {
  const required = new Set(REQUIRED_BY_SPEC[specId] ?? []);
  const kinds = [...new Set([...REPORTED_SIGNALS, ...required])];

  const signals = kinds.map((kind) => ({
    kind,
    count: countOf(store, snapshotId, kind),
    required: required.has(kind),
  }));

  const missing = signals.filter((signal) => signal.required && signal.count === 0).map((signal) => signal.kind);
  return { specId, ready: missing.length === 0, missing, signals };
}

/** A short account of what the snapshot holds, and of what it does not. */
export function explainReadiness(readiness: Readiness): string {
  const lines = readiness.signals.map(
    (signal) => `  ${signal.count === 0 ? "—" : String(signal.count).padStart(7)}  ${signal.kind}${signal.required ? " (required)" : ""}`,
  );

  if (readiness.ready) return [`ready for ${readiness.specId}`, ...lines].join("\n");

  return [
    `not ready for ${readiness.specId}: the snapshot holds no ${readiness.missing.join(", ")}`,
    ...lines,
    "",
    "A report of this type describes how a capability moves through the system, and this",
    "base records no such movement. Re-run the analysis with the code index available, or",
    "write the report that says what is missing rather than one that reads as complete.",
  ].join("\n");
}
