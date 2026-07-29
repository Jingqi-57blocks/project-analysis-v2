/**
 * The report as structured data, for an agent rebuilding the project.
 *
 * A different reader with a different need: a person wants prose and a
 * diagram, a program wants every field, every relation and every gap in a
 * shape it can walk. So this is not a serialization of the HTML — it carries
 * the full data model and the per-flow detail the pages summarize.
 *
 * Two properties matter more than completeness. Keys are emitted in a fixed
 * order, so two runs over unchanged code produce byte-identical files and a
 * diff means something. And every gap is a field rather than an absence: a
 * consumer must be able to tell "this project has none" from "nobody looked",
 * which is exactly the distinction a plain dump destroys.
 */

import type { DataModelRecords } from "../datamodel/types.js";
import type { Provenance } from "../structural/provenance.js";
import type { ReportModel } from "./model.js";

export const SPEC_VERSION = "1.0";

/**
 * The published shape of a report.
 *
 * This is the artifact everything else is made from. HTML is rendered from it,
 * and a DOCX or PDF renderer would be too — so a wording change or a new
 * format never means re-analyzing the project, and a format can only show what
 * the spec actually contains.
 */
export interface ReportSpec {
  readonly specVersion: string;
  readonly run: { readonly id: string; readonly generatedAt: string; readonly workspacePath: string };
  readonly display: { readonly language: string };
  readonly project: {
    readonly name: string;
    readonly description: string | null;
    readonly services: readonly {
      readonly name: string;
      readonly language: string | null;
      readonly filesAnalyzed: number;
      readonly filesExcluded: number;
    }[];
    readonly map: {
      readonly edges: readonly {
        readonly from: string;
        readonly to: string;
        readonly kind: string;
        readonly detail: string | null;
      }[];
      readonly diagram: string;
    };
    readonly integrations: readonly {
      readonly from: string;
      readonly to: string;
      readonly calls: number;
    }[];
  };
  /** Client-side routes: what the application shows, not what it serves. */
  readonly screens: readonly {
    readonly service: string;
    readonly path: string;
    readonly pathComplete: boolean;
  }[];
  readonly features: readonly SpecFeature[];
  readonly modules: readonly SpecModule[];
  readonly dataModel: { readonly entityNames: readonly string[]; readonly entities: readonly unknown[] };
  readonly health: {
    readonly signals: readonly {
      readonly id: string;
      readonly severity: string;
      readonly title: string;
      readonly finding: string;
      readonly evidence: readonly string[];
      readonly value: number;
    }[];
  };
  readonly accounting: { readonly dispositions: unknown; readonly unassignedEndpoints: number };
  readonly limitations: {
    readonly coverage: readonly { readonly subject: string; readonly note: string }[];
    readonly additional: readonly string[];
  };
}

export interface SpecEndpoint {
  readonly method: string | null;
  readonly path: string;
  readonly service: string;
}

export interface SpecFlowStep {
  readonly kind: string;
  readonly label: string;
  readonly service: string | null;
  readonly conditions: readonly string[];
  readonly location: string | null;
  readonly unresolved: string | null;
  readonly truncated: boolean;
  readonly indirect: boolean;
}

export interface SpecFlow {
  readonly entry: string;
  readonly method: string | null;
  readonly path: string;
  readonly complete: boolean;
  readonly diagram: string;
  readonly steps: readonly SpecFlowStep[];
}

export interface SpecFeature {
  readonly id: string;
  readonly name: string;
  readonly services: readonly string[];
  readonly evidence: readonly string[];
  readonly endpoints: readonly SpecEndpoint[];
  readonly dataEntities: readonly string[];
  readonly tables: readonly string[];
  readonly flows: readonly SpecFlow[];
  readonly flowCount: number;
  readonly flowsDetailed: number;
  readonly partialFlows: number;
  readonly overviewDiagram: string;
}

export interface SpecModule {
  readonly id: string;
  readonly name: string;
  readonly services: readonly string[];
  readonly symbolCount: number;
  readonly endpoints: readonly SpecEndpoint[];
  readonly dataEntities: readonly string[];
  readonly outboundTargets: readonly string[];
  readonly evidence: readonly string[];
}

export interface JsonReportInput {
  readonly model: ReportModel;
  /** The full data model, which the pages reduce to a list of names. */
  readonly dataModel: DataModelRecords;
  /** Everything the run could not establish, already worded for a reader. */
  readonly limitations: readonly string[];
}

function sourceOf(provenance: Provenance): string {
  return `${provenance.source.rootName}/${provenance.source.relPath}:${provenance.source.startLine}`;
}

/**
 * Nests the four flat record lists into one entity per table.
 *
 * Flat lists are right for storage — each record has its own provenance and
 * merges independently — but an agent rebuilding a schema needs the table with
 * its columns, not four lists to join. Fields keyed by (entity, name) within a
 * root, so two roots declaring the same table stay separate.
 */
export function nestDataModel(records: DataModelRecords): readonly unknown[] {
  return records.entities
    .map((entity) => {
      const belongs = (rootName: string, entityName: string): boolean =>
        rootName === entity.rootName && entityName === entity.name;

      return {
        name: entity.name,
        kind: entity.kind,
        service: entity.rootName,
        qualifier: entity.qualifier,
        fields: records.fields
          .filter((field) => belongs(field.rootName, field.entityName))
          .map((field) => ({
            name: field.name,
            declaredType: field.declaredType,
            nullable: field.nullable,
            primaryKey: field.isPrimaryKey,
            defaultValue: field.defaultValue,
            source: sourceOf(field.provenance),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        relations: records.relations
          .filter((relation) => belongs(relation.rootName, relation.fromEntity))
          .map((relation) => ({
            fromField: relation.fromField,
            toEntity: relation.toEntity,
            toField: relation.toField,
            kind: relation.kind,
            source: sourceOf(relation.provenance),
          })),
        constraints: records.constraints
          .filter((constraint) => belongs(constraint.rootName, constraint.entityName))
          .map((constraint) => ({
            kind: constraint.kind,
            fields: constraint.fields,
            expression: constraint.expression,
            source: sourceOf(constraint.provenance),
          })),
        source: sourceOf(entity.provenance),
        confidence: entity.provenance.resolutionClass,
      };
    })
    .sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name));
}

/**
 * Builds the machine-facing report.
 *
 * The order of the top-level keys is the order an agent would need them:
 * what this is, what it is made of, what it does, what it stores, and last
 * what is not known — which is deliberately not buried at the end of a
 * section nobody reads.
 */
export function buildJsonReport(input: JsonReportInput): ReportSpec {
  const { model } = input;

  return {
    specVersion: SPEC_VERSION,
    run: {
      id: model.runId,
      generatedAt: model.generatedAt,
      workspacePath: model.workspacePath,
    },
    // Carried so a renderer working from this file alone knows which wording
    // the reader asked for.
    display: { language: model.language },
    project: {
      name: model.projectName,
      description: model.description,
      services: model.roots.map((root) => ({
        name: root.name,
        language: root.language,
        filesAnalyzed: root.analyzed,
        filesExcluded: root.excluded,
      })),
      map: {
        edges: model.map.map((edge) => ({
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          detail: edge.detail,
        })),
        diagram: model.mapDiagram,
      },
      integrations: model.integrations.map((integration) => ({
        from: integration.from,
        to: integration.to,
        calls: integration.calls,
      })),
    },
    screens: model.screens.map((screen) => ({
      service: screen.rootName,
      path: screen.path,
      pathComplete: screen.pathComplete,
    })),
    features: model.features.map((feature) => ({
      id: feature.id,
      name: feature.name,
      services: feature.rootNames,
      evidence: feature.signals,
      endpoints: feature.endpoints.map((endpoint) => ({
        method: endpoint.method,
        path: endpoint.path,
        service: endpoint.rootName,
      })),
      dataEntities: feature.dataEntities,
      tables: feature.tables,
      flows: feature.flows.map((flow) => ({
        entry: flow.entryKey,
        method: flow.method,
        path: flow.path,
        complete: !flow.partial,
        diagram: flow.diagram,
        steps: flow.steps.map((step) => ({
          kind: step.kind,
          label: step.label,
          service: step.rootName,
          conditions: step.conditions,
          location: step.location,
          // Null when established. A consumer branching on this is branching
          // on whether the hop was observed, which is the point.
          unresolved: step.unresolvedReason,
          // A step shortened for display, rather than one that could not be
          // established — a consumer must not read the two as the same thing.
          truncated: step.truncated,
          // Observed in the handler's package rather than the handler itself,
          // so a consumer can weigh it as the weaker evidence it is.
          indirect: step.indirect,
        })),
      })),
      flowCount: feature.totalFlowCount,
      flowsDetailed: feature.flows.length,
      partialFlows: feature.partialFlowCount,
      overviewDiagram: feature.overviewDiagram,
    })),
    modules: model.modules.map((module) => ({
      id: module.id,
      name: module.name,
      services: module.rootNames,
      symbolCount: module.symbolCount,
      endpoints: module.routes.map((route) => ({
        method: route.method,
        path: route.path,
        service: route.rootName,
      })),
      dataEntities: module.dataEntities,
      outboundTargets: module.outboundTargets,
      evidence: module.evidence,
    })),
    dataModel: {
      entityNames: model.dataEntities,
      entities: nestDataModel(input.dataModel),
    },
    health: {
      signals: model.signals.map((signal) => ({
        id: signal.id,
        severity: signal.severity,
        title: signal.title,
        finding: signal.finding,
        evidence: signal.evidence,
        value: signal.value,
      })),
    },
    accounting: {
      dispositions: model.dispositions,
      unassignedEndpoints: model.unassignedEndpointCount,
    },
    limitations: {
      coverage: model.coverageNotes.map((note) => ({
        subject: note.subject,
        note: note.note,
      })),
      additional: input.limitations,
    },
  };
}

/** Stable, indented JSON — a diff between two runs should show real change. */
export function renderJsonReport(input: JsonReportInput): string {
  return `${JSON.stringify(buildJsonReport(input), null, 2)}\n`;
}
