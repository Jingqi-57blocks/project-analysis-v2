/**
 * The knowledge base as one JSON document, for a reader that is a program.
 *
 * Not a report and not a rendering: a report is a template's output, worded by
 * prompts a person can edit. This is the facts, in a shape something else can
 * walk — an agent rebuilding the project, a diff between two runs, a check
 * that a document's claims are supported.
 *
 * Two properties matter more than completeness. Keys come out in a fixed
 * order, so two runs over unchanged code produce byte-identical files and a
 * diff means something. And every gap is a field rather than an absence: a
 * consumer must be able to tell "this project has none" from "nobody looked",
 * which is exactly the distinction a plain dump destroys.
 */

import type { KnowledgeBase } from "./query.js";
import type { EntityRecord } from "../datamodel/types.js";
import type { Provenance } from "../structural/provenance.js";

export const EXPORT_VERSION = "2.0";

function sourceOf(provenance: Provenance): string {
  return `${provenance.source.rootName}/${provenance.source.relPath}:${provenance.source.startLine}`;
}

/**
 * The entity with everything declared about it, nested.
 *
 * Flat lists are right for storage — each record merges independently and
 * carries its own provenance — but something rebuilding a schema needs the
 * table with its columns, not four lists to join.
 */
function nestEntity(kb: KnowledgeBase, entity: EntityRecord) {
  const model = kb.entityModel(entity.name, entity.rootName);
  return {
    name: entity.name,
    kind: entity.kind,
    service: entity.rootName,
    qualifier: entity.qualifier,
    fields: (model?.fields ?? [])
      .map((field) => ({
        name: field.name,
        declaredType: field.declaredType,
        nullable: field.nullable,
        primaryKey: field.isPrimaryKey,
        defaultValue: field.defaultValue,
        source: sourceOf(field.provenance),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    relations: (model?.relations ?? []).map((relation) => ({
      fromField: relation.fromField,
      toEntity: relation.toEntity,
      toField: relation.toField,
      kind: relation.kind,
      source: sourceOf(relation.provenance),
    })),
    constraints: (model?.constraints ?? []).map((constraint) => ({
      kind: constraint.kind,
      fields: constraint.fields,
      expression: constraint.expression,
      source: sourceOf(constraint.provenance),
    })),
    source: sourceOf(entity.provenance),
    confidence: entity.provenance.resolutionClass,
  };
}

/**
 * Builds the export.
 *
 * The top-level order is the order something reading it would need: what this
 * is, what it is made of, what it does, what it stores, and last what is not
 * known — which is deliberately not buried at the end of a section nobody
 * reads.
 */
export function buildExport(kb: KnowledgeBase): unknown {
  const context = kb.runContext();
  const features = kb.features();

  return {
    exportVersion: EXPORT_VERSION,
    run: {
      id: context?.runId ?? kb.snapshot.runId,
      generatedAt: context?.generatedAt ?? kb.snapshot.publishedAt,
      identity: kb.snapshot.identity,
      workspacePath: context?.workspacePath ?? kb.snapshot.workspacePath,
    },
    project: {
      name: context?.projectName ?? null,
      // Quoted from the project's own prose, never composed. Null means the
      // code carries no description — which is a fact, not a hole to fill.
      description: context?.description ?? null,
      services: (context?.roots ?? []).map((root) => ({
        name: root.name,
        language: root.language,
        filesAnalyzed: root.analyzed,
        filesExcluded: root.excluded,
      })),
      map: {
        edges: kb
          .mapEdges()
          .map((edge) => ({
            from: edge.from,
            to: edge.to,
            kind: edge.kind,
            detail: edge.detail,
          }))
          .sort(
            (a, b) =>
              a.from.localeCompare(b.from) ||
              a.to.localeCompare(b.to) ||
              a.kind.localeCompare(b.kind),
          ),
        diagram: context?.mapDiagram ?? "",
      },
      integrations: kb
        .integrations()
        .map((edge) => ({ from: edge.from, to: edge.to, detail: edge.detail }))
        .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    },
    screens: {
      // Client routes and endpoints are the same kind of record, so their
      // coverage is the same answer: an empty list here means nobody read
      // routes at all, not that the product has no screens.
      coverage: kb.coverageFor("route"),
      items: kb
        .screens()
        .map((screen) => ({
          service: screen.rootName,
          path: screen.path,
          // False when the screen sits under a parent declared in another
          // file: a real path fragment, not the address a user visits.
          pathComplete: screen.provenance.resolutionClass !== "inferred",
        }))
        .sort((a, b) => a.service.localeCompare(b.service) || a.path.localeCompare(b.path)),
    },
    // Capabilities are worked out from routes and entities. With neither read,
    // "no capabilities" describes the run rather than the product.
    featureCoverage: { routes: kb.coverageFor("route"), entities: kb.coverageFor("entity") },
    features: features.map((feature) => {
      const detail = kb.featureDetail(feature.id);
      return {
        id: feature.id,
        name: feature.name,
        term: feature.term,
        services: feature.rootNames,
        evidence: feature.signals,
        endpoints: feature.endpoints.map((endpoint) => ({
          method: endpoint.method,
          path: endpoint.path,
          service: endpoint.rootName,
        })),
        dataEntities: feature.dataEntities,
        tables: feature.tables,
        // Observed in a handler's package rather than in the handler: the
        // weaker evidence, kept where a consumer can weigh it as such.
        tablesNearby: feature.tablesNearby,
        flows: (detail?.flows ?? []).map((flow) => ({
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
            location:
              step.provenance === null
                ? null
                : sourceOf(step.provenance),
            // Null when established. A consumer branching on this is branching
            // on whether the hop was observed, which is the point.
            unresolved: step.unresolvedReason,
            // Shortened for display, rather than not established — a consumer
            // must not read the two as the same thing.
            truncated: step.truncated === true,
            // Observed in the handler's package rather than in the handler, so
            // a consumer can weigh it as the weaker evidence it is.
            indirect: step.indirect === true,
          })),
        })),
        flowCount: feature.flowCount,
        partialFlows: feature.partialFlowCount,
        overviewDiagram: feature.overviewDiagram,
        conditionCount: feature.conditionCount,
        rules: (detail?.rules ?? []).map((rule) => ({
          statement: rule.statement,
          text: rule.text,
          service: rule.rootName,
          location: `${rule.rootName}/${rule.relPath}:${rule.startLine}`,
          // What the value means where the project names it, and the set that
          // said so — a rule stated in a bare number is left as written.
          meanings: rule.meanings,
          valueSet: rule.valueSetName,
          guarded: rule.guarded,
        })),
        findings: (detail?.findings ?? []).map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          title: finding.title,
          finding: finding.finding,
          evidence: finding.evidence,
        })),
      };
    }),
    // Modules are grouped from traces, which need the call graph.
    moduleCoverage: kb.coverageFor("call-edge"),
    modules: kb.modules().map((module) => ({
      id: module.id,
      name: module.name,
      services: module.rootNames,
      symbolCount: module.symbolCount,
      groupingSignal: module.groupingSignal,
      endpoints: module.endpoints.map((endpoint) => ({
        method: endpoint.method,
        path: endpoint.path,
        service: endpoint.rootName,
      })),
      dataEntities: module.dataEntities,
      outboundTargets: module.outboundTargets,
      evidence: module.evidence,
      features: kb.moduleDetail(module.id)?.features.map((feature) => feature.id) ?? [],
    })),
    dataModel: {
      entityNames: [...new Set(kb.entities().map((entity) => entity.name))].sort(),
      entities: kb
        .entities()
        .slice()
        .sort((a, b) => a.rootName.localeCompare(b.rootName) || a.name.localeCompare(b.name))
        .map((entity) => nestEntity(kb, entity)),
      // Whether anything looked at all. An empty entity list means nothing
      // without this.
      coverage: kb.coverageFor("entity"),
    },
    vocabulary: {
      // Value sets are read from files directly rather than by a provider, so
      // the honest coverage answer is how many files could not be read.
      unreadFiles: kb.extractionFailures().filter((failure) => failure.providerId === "value-sets")
        .length,
      sets: kb.valueSets().map((set) => ({
        name: set.name,
        service: set.rootName,
        location: `${set.rootName}/${set.relPath}:${set.startLine}`,
        members: set.members,
      })),
    },
    health: {
      structural: kb.structuralFindings().map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        finding: finding.finding,
        evidence: finding.evidence,
      })),
      findings: kb.featureFindings().map((finding) => ({
        capability: finding.featureName,
        capabilityId: finding.featureId,
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        finding: finding.finding,
        evidence: finding.evidence,
      })),
      // These measure the analysis, not the product. Kept apart from the
      // findings above for exactly that reason.
      signals: kb.signals().map((signal) => ({
        id: signal.id,
        severity: signal.severity,
        title: signal.title,
        finding: signal.finding,
        evidence: signal.evidence,
        value: signal.value,
      })),
    },
    accounting: {
      dispositions: context?.dispositions ?? null,
      unassignedEndpoints: context?.unassignedEndpointCount ?? 0,
      failures: kb.extractionFailures(),
    },
    limitations: {
      coverage: kb.coverageNotes().map((note) => ({ subject: note.subject, note: note.note })),
    },
  };
}

/** Stable, indented JSON — a diff between two runs should show real change. */
export function renderExport(kb: KnowledgeBase): string {
  return `${JSON.stringify(buildExport(kb), null, 2)}\n`;
}
