/**
 * What a reader gets back, apart from how it is fetched.
 *
 * Split from `query.ts` as a move: the class there is 60 read methods and cannot
 * reach the readable ceiling without being delegated into several readers, which is
 * a design change rather than a move. These shapes come out cleanly, and a caller
 * reading one no longer has to open a thousand-line file to find it.
 */

import type { BusinessRule } from "../semantics/rules.js";
import type { FeatureFact, FeatureFlowFact, FeatureFindingFact, ModuleFact } from "./facts.js";
import type {
  ConstraintRecord,
  DataRelationRecord,
  EntityRecord,
  FieldRecord,
} from "../datamodel/types.js";

export interface Coverage {
  readonly attempted: boolean;
  readonly outcomes: readonly {
    readonly providerId: string;
    readonly rootName: string;
    readonly language: string;
    readonly outcome: string;
    readonly reason: string | null;
    readonly recordCount: number;
  }[];
}

export interface EntityModel {
  readonly entity: EntityRecord;
  readonly fields: readonly FieldRecord[];
  readonly relations: readonly DataRelationRecord[];
  readonly constraints: readonly ConstraintRecord[];
}

export interface DataOwnership {
  readonly table: string;
  readonly writers: readonly string[];
  /** Roots that read but were not seen to write — reading across a boundary. */
  readonly readers: readonly string[];
  readonly sharing: "single-owner" | "read-across-a-boundary" | "written-by-several";
}

export interface ReliabilitySignal {
  readonly rootName: string;
  readonly errorHandlingSites: number;
  readonly transactionBoundaries: number;
  readonly discardedErrors: number;
}

export interface TestPresence {
  readonly rootName: string;
  readonly testCount: number;
  readonly sample: readonly string[];
}

export interface EndpointPermission {
  readonly rootName: string;
  readonly method: string | null;
  readonly path: string;
  /** The middleware declared on the route — auth checks, validation, and more. */
  readonly middleware: readonly string[];
}

export interface FeatureDetail {
  readonly feature: FeatureFact;
  readonly flows: readonly FeatureFlowFact[];
  readonly rules: readonly BusinessRule[];
  readonly findings: readonly FeatureFindingFact[];
}

/**
 * What one kind of fact yielded, per repository.
 *
 * The dimensions of the analysis itself: which kinds of fact were looked for,
 * where, and what came back. A kind with no records and no attempt is a
 * different statement from one that was looked for and found nothing, and this
 * is where a reader can tell them apart.
 */
export interface DimensionCoverage {
  readonly kind: string;
  /** True for kinds any codebase has — an empty one means something failed. */
  readonly expected: boolean;
  readonly records: number;
  readonly attempted: boolean;
  readonly byRoot: readonly {
    readonly rootName: string;
    readonly records: number;
    readonly attempted: boolean;
    /** Why nothing was found, where a reader said. */
    readonly reason: string | null;
  }[];
}

export interface ModuleDetail {
  readonly module: ModuleFact;
  /** The capabilities this unit of code serves. Often more than one. */
  readonly features: readonly FeatureFact[];
}

export interface ModuleDetail {
  readonly module: ModuleFact;
  /** The capabilities this unit of code serves. Often more than one. */
  readonly features: readonly FeatureFact[];
}
