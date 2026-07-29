/**
 * Reads a published report back into the shape the renderers draw from.
 *
 * The point is that `report.json` is the artifact, not a by-product. Every
 * format is rendered from it, so changing wording, restyling a page, or adding
 * a DOCX exporter never means re-analyzing the project — and a format can only
 * show what the spec actually contains, which keeps the formats agreeing with
 * each other by construction.
 *
 * Total by design: a spec that parses produces a model. Where a field is
 * missing it becomes an empty list or a null rather than an exception, because
 * a report written by an older version should still render.
 */

import type { ReportSpec } from "./json.js";
import type { DispositionCounts } from "../modules/form.js";
import type {
  ReportFeature,
  ReportFlow,
  ReportModel,
  ReportModule,
} from "./model.js";
import { DEFAULT_LANGUAGE } from "./model.js";
import type { HealthSignal, Severity } from "../health/signals.js";

const SEVERITIES = new Set<string>(["info", "notice", "concern"]);

const EMPTY_DISPOSITIONS: DispositionCounts = {
  behavioralSource: 0,
  technicalOnly: 0,
  sharedInfrastructure: 0,
  unclassified: 0,
  total: 0,
};

function toFlow(flow: ReportSpec["features"][number]["flows"][number]): ReportFlow {
  return {
    entryKey: flow.entry,
    method: flow.method,
    path: flow.path,
    steps: flow.steps.map((step) => ({
      kind: step.kind,
      label: step.label,
      rootName: step.service,
      conditions: step.conditions ?? [],
      unresolvedReason: step.unresolved,
      truncated: step.truncated === true,
      location: step.location,
    })),
    diagram: flow.diagram,
    partial: !flow.complete,
  };
}

function toFeature(feature: ReportSpec["features"][number]): ReportFeature {
  return {
    id: feature.id,
    name: feature.name,
    rootNames: feature.services ?? [],
    signals: feature.evidence ?? [],
    endpoints: (feature.endpoints ?? []).map((endpoint) => ({
      method: endpoint.method,
      path: endpoint.path,
      rootName: endpoint.service,
    })),
    dataEntities: feature.dataEntities ?? [],
    tables: feature.tables ?? [],
    flows: (feature.flows ?? []).map(toFlow),
    totalFlowCount: feature.flowCount ?? (feature.flows ?? []).length,
    overviewDiagram: feature.overviewDiagram,
    partialFlowCount: feature.partialFlows ?? 0,
  };
}

function toModule(module: ReportSpec["modules"][number]): ReportModule {
  return {
    id: module.id,
    name: module.name,
    entryPoints: (module.endpoints ?? []).map(
      (endpoint) => `${endpoint.service}:${endpoint.method ?? "ANY"} ${endpoint.path}`,
    ),
    routes: (module.endpoints ?? []).map((endpoint) => ({
      method: endpoint.method,
      path: endpoint.path,
      rootName: endpoint.service,
    })),
    rootNames: module.services ?? [],
    symbolCount: module.symbolCount ?? 0,
    dataEntities: module.dataEntities ?? [],
    outboundTargets: module.outboundTargets ?? [],
    evidence: module.evidence ?? [],
  };
}

function toSignal(signal: ReportSpec["health"]["signals"][number]): HealthSignal {
  return {
    id: signal.id,
    title: signal.title,
    finding: signal.finding,
    severity: (SEVERITIES.has(signal.severity) ? signal.severity : "info") as Severity,
    evidence: signal.evidence ?? [],
    value: signal.value ?? 0,
  };
}

export function modelFromSpec(spec: ReportSpec): ReportModel {
  const signals = (spec.health?.signals ?? []).map(toSignal);
  const map = (spec.project.map?.edges ?? []).map((edge) => ({
    from: edge.from,
    to: edge.to,
    kind: (edge.kind === "internal" || edge.kind === "external" || edge.kind === "datastore"
      ? edge.kind
      : "internal") as "internal" | "external" | "datastore",
    detail: edge.detail,
  }));

  return {
    runId: spec.run.id,
    generatedAt: spec.run.generatedAt,
    workspacePath: spec.run.workspacePath,
    projectName: spec.project.name,
    description: spec.project.description,
    language: spec.display?.language ?? DEFAULT_LANGUAGE,
    roots: (spec.project.services ?? []).map((service) => ({
      name: service.name,
      language: service.language,
      fileCount: service.filesAnalyzed + service.filesExcluded,
      analyzed: service.filesAnalyzed,
      excluded: service.filesExcluded,
    })),
    modules: (spec.modules ?? []).map(toModule),
    features: (spec.features ?? []).map(toFeature),
    components: [],
    integrations: spec.project.integrations ?? [],
    map,
    mapDiagram: spec.project.map?.diagram ?? "",
    unassignedEndpointCount: spec.accounting?.unassignedEndpoints ?? 0,
    screens: (spec.screens ?? []).map((screen) => ({
      rootName: screen.service,
      path: screen.path,
      pathComplete: screen.pathComplete !== false,
    })),
    dataEntities: spec.dataModel?.entityNames ?? [],
    signals,
    attentionSignals: signals.filter((signal) => signal.severity !== "info"),
    dispositions: (spec.accounting?.dispositions as DispositionCounts | undefined) ?? EMPTY_DISPOSITIONS,
    coverageNotes: spec.limitations?.coverage ?? [],
  };
}

/** Parses a published report, refusing anything that is not one. */
export function parseReportSpec(text: string): ReportSpec {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("specVersion" in parsed) ||
    !("project" in parsed)
  ) {
    throw new Error("not a report specification: expected an object with specVersion and project");
  }
  return parsed as ReportSpec;
}
