/**
 * The facts the analysis concludes, as opposed to the ones a provider reads.
 *
 * Everything here is derived: a feature is worked out from terms appearing in
 * more than one kind of place, a map edge from calls that resolved across
 * roots, a coverage note from a capability nobody claimed. They are still
 * facts — each one is checkable against records that have locations — but they
 * belong to this layer rather than to any provider, which is why they are
 * defined here and not imported from one.
 *
 * None of them carries wording meant for a reader. A sentence about a feature
 * is a template's business; what lives here is what such a sentence would have
 * to be true of.
 */

import type { DispositionCounts } from "../modules/form.js";
import type { FeatureFlow } from "../flows/types.js";

/** An endpoint as the derived layer refers to one, without the full record. */
export interface EndpointRef {
  readonly method: string | null;
  readonly path: string;
  readonly rootName: string;
}

/**
 * A product capability.
 *
 * Distinct from a module: a module is a unit of code, a feature is something
 * the product does. One feature can span three services and one service can
 * serve two features, so collapsing them would lose whichever the reader was
 * after.
 *
 * Its flows, rules and findings are their own records, linked rather than
 * nested — a template asking only for rules should not have to load every
 * flow's every step to get them.
 */
export interface FeatureFact {
  readonly id: string;
  readonly name: string;
  /** The word the codebase itself uses, before capitalization. */
  readonly term: string;
  /** entities × 3 + endpoints — how much of the product this accounts for. */
  readonly weight: number;
  readonly rootNames: readonly string[];
  /** What made this a feature: which kinds of evidence named it, and how much. */
  readonly signals: readonly string[];
  readonly endpoints: readonly EndpointRef[];
  readonly dataEntities: readonly string[];
  /** Tables its handlers were observed to touch. */
  readonly tables: readonly string[];
  /** Files it owns, qualified as `root/relPath`. */
  readonly filePaths: readonly string[];
  readonly flowCount: number;
  readonly partialFlowCount: number;
  /** How many conditions were observed in its files, so the scale is visible. */
  readonly conditionCount: number;
  /** The feature at a glance: callers, endpoints, tables. Mermaid source. */
  readonly overviewDiagram: string;
}

/**
 * One request path through a feature, with its shape.
 *
 * The diagram is stored rather than recomputed because a mermaid string *is*
 * the fact — the shape of the flow, written down. A template embeds it; it
 * does not assemble one, and two templates embedding the same flow must show
 * the same picture.
 */
export interface FeatureFlowFact extends FeatureFlow {
  readonly diagram: string;
}

/** A unit of code, grouped by what its traces have in common. */
export interface ModuleFact {
  readonly id: string;
  readonly name: string;
  readonly rootNames: readonly string[];
  readonly entryKeys: readonly string[];
  readonly endpoints: readonly EndpointRef[];
  readonly symbolCount: number;
  readonly dataEntities: readonly string[];
  readonly outboundTargets: readonly string[];
  /** Which behavioural signal justified grouping these traces. */
  readonly groupingSignal: string;
  /** Prose the developers already wrote, quoted rather than paraphrased. */
  readonly evidence: readonly string[];
}

/**
 * One edge of the project map.
 *
 * `kind` separates a call between our own roots from a call to something
 * outside, because a reader needs to see the boundary of the system before
 * anything inside it makes sense.
 */
export interface MapEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: "internal" | "external" | "datastore";
  readonly detail: string | null;
}

/**
 * Something this run could not establish, in words.
 *
 * Stored as a record rather than left to whoever queries the database: a
 * reader deciding on this analysis needs to know what was not measured, and a
 * gap visible only to someone who thinks to ask for it is a gap nobody sees.
 */
export interface CoverageNote {
  readonly subject: string;
  readonly note: string;
}

export interface RootSummaryFact {
  readonly name: string;
  readonly language: string | null;
  readonly analyzed: number;
  readonly excluded: number;
}

/**
 * What this run was, and what it covered.
 *
 * A singleton per snapshot. Carries the run id so an overview and a module
 * report produced separately are recognizably the same analysis — without it,
 * two documents could describe two different states of the same project and
 * nothing would say so.
 */
export interface RunContext {
  readonly runId: string;
  readonly generatedAt: string;
  readonly workspacePath: string;
  readonly projectName: string;
  /** Quoted from the project's own prose where it has any, never composed. */
  readonly description: string | null;
  readonly roots: readonly RootSummaryFact[];
  /** The system's shape as one picture. Mermaid source, like a flow's. */
  readonly mapDiagram: string;
  readonly dispositions: DispositionCounts;
  /** Endpoints belonging to no detected feature, so the count stays honest. */
  readonly unassignedEndpointCount: number;
}

/** A finding about one capability, carried with the capability it is about. */
export interface FeatureFindingFact {
  readonly featureId: string;
  readonly featureName: string;
  readonly id: string;
  readonly title: string;
  readonly finding: string;
  readonly severity: string;
  readonly evidence: readonly string[];
}
