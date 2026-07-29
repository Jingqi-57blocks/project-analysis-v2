/**
 * A feature's request path, end to end.
 *
 * The question a reader actually has is "what happens when someone submits a
 * leave request", and answering it means crossing four boundaries that no
 * single provider sees: the browser call, the route that receives it, the
 * handler behind that route, and the tables it touches.
 *
 * Every hop that could not be established is present as a step carrying the
 * reason it is missing, rather than absent. A diagram with a gap in it is
 * honest; a diagram that quietly skips the hop it could not find implies a
 * directness that was never observed.
 */

import type { Provenance } from "../structural/provenance.js";

export const FLOW_STEP_KINDS = [
  "frontend-call",
  "route",
  "handler",
  "service",
  "data-access",
  "outbound",
] as const;

export type FlowStepKind = (typeof FLOW_STEP_KINDS)[number];

export interface FlowStep {
  readonly kind: FlowStepKind;
  /** What a reader sees: a path, a function name, a table. */
  readonly label: string;
  /** The service this step happens in, or null for the browser. */
  readonly rootName: string | null;
  /** Conditions that apply at this step — middleware, validation, auth. */
  readonly conditions: readonly string[];
  /**
   * Null when the step was established. Otherwise why it could not be, in
   * words a reader can act on.
   */
  readonly unresolvedReason: string | null;
  readonly provenance: Provenance | null;
}

export interface FeatureFlow {
  readonly featureId: string;
  readonly featureName: string;
  /** `POST /v2/leaves` — the flow's identity within its feature. */
  readonly entryKey: string;
  readonly method: string | null;
  readonly path: string;
  readonly steps: readonly FlowStep[];
  /** True when any step is unresolved, so a reader knows before reading. */
  readonly partial: boolean;
}

export interface FlowSet {
  readonly flows: readonly FeatureFlow[];
  /** Routes that produced no flow at all, each with a reason. */
  readonly skipped: readonly { readonly entryKey: string; readonly reason: string }[];
}
