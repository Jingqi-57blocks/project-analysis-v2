/**
 * What is worth a second look, per capability.
 *
 * Project-wide signals answer "how is the analysis doing"; these answer "what
 * about Leave should someone check", which is the question a reader arrived
 * with. Each finding names the feature it belongs to, so it can be read beside
 * that feature rather than in a list covering everything at once.
 *
 * Every finding is worded as an observation about what was analyzed, never as
 * a claim about what exists. "No authentication was observed on these
 * endpoints" is true and checkable; "these endpoints have no authentication"
 * asserts something this tool cannot establish, since a check written inside a
 * handler body is out of its reach.
 */

import type { ReportFeature } from "../report/model.js";
import type { Severity } from "./signals.js";

export interface FeatureFinding {
  readonly featureId: string;
  readonly featureName: string;
  readonly id: string;
  readonly title: string;
  /** The measured observation, in words a reader can act on. */
  readonly finding: string;
  readonly severity: Severity;
  /** What the observation rests on, so it can be checked rather than trusted. */
  readonly evidence: readonly string[];
}

/** Middleware names that indicate a request is authenticated or authorized. */
const AUTH_HINTS = ["auth", "jwt", "token", "session", "passport", "permission", "guard"];

function looksLikeAuth(condition: string): boolean {
  const lower = condition.toLowerCase();
  return AUTH_HINTS.some((hint) => lower.includes(hint));
}

export interface FeatureFindingLimits {
  /** Endpoints named individually before the finding switches to a count. */
  readonly maxNamed: number;
}

export const DEFAULT_FINDING_LIMITS: FeatureFindingLimits = { maxNamed: 5 };

export function computeFeatureFindings(
  features: readonly ReportFeature[],
  limits: FeatureFindingLimits = DEFAULT_FINDING_LIMITS,
): readonly FeatureFinding[] {
  const findings: FeatureFinding[] = [];

  for (const feature of features) {
    const base = { featureId: feature.id, featureName: feature.name };

    const unauthenticated = feature.flows.filter((flow) => {
      const route = flow.steps.find((step) => step.kind === "route");
      return route !== undefined && !route.conditions.some(looksLikeAuth);
    });

    if (unauthenticated.length > 0 && feature.flows.length > 0) {
      findings.push({
        ...base,
        id: "endpoints-without-observed-auth",
        title: "Endpoints with no authentication observed",
        finding: `${unauthenticated.length} of ${feature.flows.length} endpoints in ${feature.name} were registered without any middleware this analysis recognises as authentication. A check written inside the handler would not be visible here.`,
        severity: unauthenticated.length === feature.flows.length ? "concern" : "notice",
        evidence: unauthenticated
          .slice(0, limits.maxNamed)
          .map((flow) => `${flow.method ?? "ANY"} ${flow.path}`),
      });
    }

    const unreachable = feature.flows.filter((flow) =>
      flow.steps.some((step) => step.kind === "frontend-call" && step.unresolvedReason !== null),
    );
    if (unreachable.length > 0) {
      findings.push({
        ...base,
        id: "endpoints-without-observed-caller",
        title: "Endpoints nothing in the workspace was seen to call",
        finding: `${unreachable.length} of ${feature.flows.length} endpoints in ${feature.name} are not reached by any call found in the analyzed parts. They may serve something outside this workspace, or no longer be used.`,
        severity: "notice",
        evidence: unreachable
          .slice(0, limits.maxNamed)
          .map((flow) => `${flow.method ?? "ANY"} ${flow.path}`),
      });
    }

    const untraced = feature.flows.filter((flow) =>
      flow.steps.some((step) => step.kind === "handler" && step.unresolvedReason !== null),
    );
    if (untraced.length > 0) {
      findings.push({
        ...base,
        id: "endpoints-without-resolved-handler",
        title: "Endpoints whose handler could not be identified",
        finding: `${untraced.length} of ${feature.flows.length} endpoints in ${feature.name} could not be followed into the code behind them, so nothing downstream of the route is described for those.`,
        severity: "info",
        evidence: untraced
          .slice(0, limits.maxNamed)
          .map((flow) => `${flow.method ?? "ANY"} ${flow.path}`),
      });
    }

    if (feature.tables.length === 0 && feature.flows.length > 0) {
      findings.push({
        ...base,
        id: "feature-without-observed-storage",
        title: "No data access observed",
        finding: `No table access was observed for any endpoint in ${feature.name}. The capability may read its data through code this analysis did not follow, or hold none of its own.`,
        severity: "info",
        evidence: [],
      });
    }

    // Evidence that reached the table but not the handler is the weakest kind
    // the report shows, and a feature made entirely of it should say so.
    // Counted over the steps themselves: "every step is indirect" is
    // vacuously true where there are no steps, which would report the
    // weakness of evidence that does not exist.
    const observedAccess = feature.flows.flatMap((flow) =>
      flow.steps.filter((step) => step.kind === "data-access" && step.unresolvedReason === null),
    );
    const indirectOnly =
      observedAccess.length > 0 && observedAccess.every((step) => step.indirect);
    if (indirectOnly) {
      findings.push({
        ...base,
        id: "storage-observed-only-nearby",
        title: "Data access observed near the handlers, not in them",
        finding: `Every table listed for ${feature.name} was observed elsewhere in the handler's package rather than in the handler itself, so which endpoint touches which table is not established.`,
        severity: "info",
        evidence: feature.tables.slice(0, limits.maxNamed),
      });
    }
  }

  const rank: Record<Severity, number> = { concern: 0, notice: 1, info: 2 };
  return findings.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.featureName.localeCompare(b.featureName),
  );
}

/** Findings for one feature, in the order a reader should meet them. */
export function findingsFor(
  findings: readonly FeatureFinding[],
  featureId: string,
): readonly FeatureFinding[] {
  return findings.filter((finding) => finding.featureId === featureId);
}
