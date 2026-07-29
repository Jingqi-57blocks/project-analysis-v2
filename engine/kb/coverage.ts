/**
 * What this run could not establish, in words a reader can act on.
 *
 * Every note here exists because silence about a gap reads as a finding about
 * the project. "No entry points were found" says the project serves nothing;
 * what actually happened is that no provider in this run reads entry points.
 * Those are different statements, and only one of them is true.
 *
 * Notes are facts about the analysis, so they are stored beside the facts
 * about the code rather than assembled into a document — a limitation only
 * visible to whoever queries the database is a limitation nobody sees.
 */

import type { StructuralKind } from "../structural/kinds.js";
import type { StructuralProvider } from "../structural/provider.js";
import type { AssembledModel } from "../structural/assemble.js";
import type { CoverageNote } from "./facts.js";

/**
 * Kinds whose absence would silently gut the analysis.
 *
 * Not every kind deserves a note: a project with no database is ordinary. But
 * a run that could not read entry points produces a report shaped exactly like
 * one describing a project that has none.
 */
const CRITICAL_KINDS: readonly (readonly [StructuralKind, string])[] = [
  ["route", "entry points, so no features could be formed"],
  ["symbol", "code structure, so nothing could be traced"],
  ["call-edge", "call relationships, so traces could not be followed"],
];

export interface CoverageInput {
  readonly providers: readonly StructuralProvider[];
  /** One per root, for the gaps each provider declared while running. */
  readonly models: readonly AssembledModel[];
  readonly rootCount: number;
}

/**
 * Notes about what nobody in this run was able to look at.
 *
 * Gaps are deduplicated across roots: the same provider reports the same
 * standing limit for every root it runs on, so a ten-root workspace would
 * repeat eight identical sentences ten times and bury anything specific.
 */
export function coverageNotes(input: CoverageInput): readonly CoverageNote[] {
  const notes: CoverageNote[] = [];

  const claimed = new Set<string>(
    input.providers.flatMap((provider) =>
      provider
        .structuralCapabilities()
        .declarations.filter((declaration) => declaration.support !== "none")
        .map((declaration) => declaration.kind),
    ),
  );
  for (const [kind, consequence] of CRITICAL_KINDS) {
    if (claimed.has(kind)) continue;
    notes.push({
      subject: kind,
      note: `No provider in this run supplies ${consequence}. This is a gap in the analysis, not a property of the project.`,
    });
  }

  const gapRoots = new Map<string, Set<string>>();
  for (const model of input.models) {
    for (const gap of model.gaps) {
      const key = `${gap.kind}:${gap.reason}`;
      const existing = gapRoots.get(key);
      if (existing) existing.add(model.rootName);
      else gapRoots.set(key, new Set([model.rootName]));
    }
  }
  for (const [key, roots] of gapRoots) {
    const [kind, ...rest] = key.split(":");
    const where = roots.size === input.rootCount ? "all parts" : [...roots].sort().join(", ");
    notes.push({ subject: `${kind} · ${where}`, note: rest.join(":") });
  }

  // Partial support is where a report is most likely to mislead: a kind that
  // is *mostly* extracted looks complete. Surfacing only fully-unsupported
  // kinds meant the limits that actually distort what a reader sees — route
  // paths missing their framework prefix, routes registered through a closure
  // being missed entirely — never reached the reader at all.
  const seen = new Set<string>();
  for (const provider of input.providers) {
    for (const declaration of provider.structuralCapabilities().declarations) {
      if (declaration.support !== "partial") continue;
      for (const limit of declaration.limits) {
        const key = `${declaration.kind}:${limit}`;
        if (seen.has(key)) continue;
        seen.add(key);
        notes.push({ subject: declaration.kind, note: limit });
      }
    }
  }

  return notes;
}

export interface DataCoverageInput {
  /** Entity names any schema reader declared. */
  readonly describedEntities: ReadonlySet<string>;
  /** Table names the code was observed to touch. */
  readonly touchedTables: ReadonlySet<string>;
}

/**
 * What the data model does not cover.
 *
 * A project with no schema at all is far more likely to be one whose schema
 * this run could not read than one that stores nothing, and silence here reads
 * as the second.
 */
export function dataCoverageNotes(input: DataCoverageInput): readonly CoverageNote[] {
  const notes: CoverageNote[] = [];

  if (input.describedEntities.size === 0) {
    notes.push({
      subject: "data-model",
      note: "no table or column declarations were found by the schema readers available in this run, so no data model is described here; that is a limit of what was read, not evidence the project stores nothing",
    });
    return notes;
  }

  const undescribed = [...input.touchedTables].filter(
    (table) => !input.describedEntities.has(table),
  );
  if (undescribed.length > 0) {
    notes.push({
      subject: "data-model",
      note: `fields and constraints are described for ${input.describedEntities.size} entities, but ${undescribed.length} further tables are used by code without a schema declaration this run could read; their columns are not in this report`,
    });
  }

  return notes;
}
