/**
 * Schema versioning, compatibility and migration for facts.
 *
 * A contract may evolve, but never silently: a version is either compatible or
 * it needs a migration, and a migration preserves the two things a fact cannot
 * lose across it — its identity and its provenance. Unknown kinds are kept and
 * round-tripped rather than dropped, and surfaced as a capability gap, so a
 * newer producer's fact is never lost by an older consumer.
 */

import type { FactEnvelope } from "./envelope.js";
import type { FactKind } from "./families.js";

export type SchemaVersion = string;

interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parseSemver(version: SchemaVersion): Semver {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`not a semantic version: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareSemver(a: SchemaVersion, b: SchemaVersion): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/**
 * A consumer at `reader` can read data written at `writer` when they share a
 * major version and the reader is at least as new in minor — additive minor
 * changes are backward compatible, a major change is breaking and needs a
 * migration.
 */
export function isCompatible(reader: SchemaVersion, writer: SchemaVersion): boolean {
  const r = parseSemver(reader);
  const w = parseSemver(writer);
  if (r.major !== w.major) return false;
  return r.minor >= w.minor;
}

/**
 * A step from one version to the next. `migrate` must preserve factId and the
 * evidence/provenance chain; it may only change the payload shape.
 */
export interface Migration {
  readonly from: SchemaVersion;
  readonly to: SchemaVersion;
  readonly migrate: (envelope: FactEnvelope) => FactEnvelope;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * Applies the chain of migrations carrying `envelope` from its own version to
 * `target`. Fails closed when no path exists rather than returning stale data,
 * and asserts the identity/provenance invariant after every step.
 */
export function applyMigrations(
  envelope: FactEnvelope,
  target: SchemaVersion,
  migrations: readonly Migration[],
): FactEnvelope {
  let current = envelope;
  const byFrom = new Map(migrations.map((m) => [m.from, m]));
  const guard = migrations.length + 1;
  let steps = 0;

  while (current.schemaVersion !== target) {
    if (steps++ > guard) throw new MigrationError(`migration cycle or dead end reaching ${target}`);
    const step = byFrom.get(current.schemaVersion);
    if (!step) {
      throw new MigrationError(`no migration from ${current.schemaVersion} toward ${target}`);
    }
    const next = step.migrate(current);
    if (next.factId !== current.factId) {
      throw new MigrationError(`migration ${step.from}→${step.to} changed factId`);
    }
    if (next.evidence !== current.evidence && stringifyChain(next) !== stringifyChain(current)) {
      throw new MigrationError(`migration ${step.from}→${step.to} altered the provenance chain`);
    }
    current = next.schemaVersion === step.to ? next : { ...next, schemaVersion: step.to };
  }
  return current;
}

function stringifyChain(envelope: FactEnvelope): string {
  return JSON.stringify(envelope.evidence);
}

/**
 * Whether a kind is one this build knows. An unknown kind is not an error: it is
 * retained, round-tripped and reported as a capability gap (CoverageState
 * `unsupported`), so a fact from a newer producer survives an older consumer.
 */
export function isKnownKind(kind: FactKind, known: ReadonlySet<FactKind>): boolean {
  return known.has(kind);
}
