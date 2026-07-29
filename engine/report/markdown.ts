/**
 * The report as Markdown, for an agent reading rather than querying.
 *
 * The JSON carries the same facts in a shape a program walks; this carries
 * them in a shape a model reads, which is a different job. Diagrams go in
 * ```mermaid fences so they survive into any viewer, and every claim that
 * came from a specific place in the source keeps that place beside it — a
 * rebuild spec whose statements cannot be checked is a rumour.
 *
 * English regardless of the report's display language: this file is written
 * for a machine, and translating a specification would only put its terms out
 * of step with the identifiers it describes.
 */

import type { DataModelRecords } from "../datamodel/types.js";
import type { ReportFeature, ReportFlow, ReportModel } from "./model.js";
import { composeIntroduction } from "./intro.js";

export interface MarkdownPage {
  readonly filename: string;
  readonly markdown: string;
}

function fence(diagram: string): string {
  return ["```mermaid", diagram, "```"].join("\n");
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  const escape = (cell: string): string => cell.replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ].join("\n");
}

/** A filename-safe slug, and the anchor a feature is linked by. */
export function featureSlug(feature: ReportFeature): string {
  const base = feature.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // The id keeps two features that slug identically apart, which matters
  // because a collision would silently overwrite one file with the other.
  return `${base || "feature"}-${feature.id.slice(-6)}`;
}

function flowSection(flow: ReportFlow): string {
  const lines = [`#### ${flow.method ?? "ANY"} ${flow.path}`, ""];
  if (flow.partial) {
    lines.push("> Some hops in this flow could not be established; each is marked below.", "");
  }

  lines.push(
    table(
      ["Step", "What", "Service", "Conditions", "Source", "Not established"],
      flow.steps.map((step) => [
        step.kind,
        step.label,
        step.rootName ?? "—",
        step.conditions.join("; ") || "—",
        step.location ?? "—",
        step.unresolvedReason ?? "—",
      ]),
    ),
    "",
    fence(flow.diagram),
    "",
  );

  return lines.join("\n");
}

export function renderFeaturePage(feature: ReportFeature): string {
  const lines = [
    `# ${feature.name}`,
    "",
    `Services: ${feature.rootNames.join(", ") || "—"}`,
    "",
    `Evidence: ${feature.signals.join(" · ") || "—"}`,
    "",
    "## At a glance",
    "",
    fence(feature.overviewDiagram),
    "",
  ];

  if (feature.endpoints.length > 0) {
    lines.push(
      "## Endpoints",
      "",
      table(
        ["Method", "Path", "Service"],
        feature.endpoints.map((endpoint) => [
          endpoint.method ?? "ANY",
          endpoint.path,
          endpoint.rootName,
        ]),
      ),
      "",
    );
  }

  if (feature.tables.length > 0 || feature.dataEntities.length > 0) {
    lines.push("## Data", "");
    if (feature.tables.length > 0) {
      lines.push(`Tables its handlers touch: ${feature.tables.join(", ")}`, "");
    }
    if (feature.dataEntities.length > 0) {
      lines.push(`Entities named after it: ${feature.dataEntities.join(", ")}`, "");
    }
  }

  if (feature.findings.length > 0) {
    lines.push(
      "## What to look at",
      "",
      table(
        ["Severity", "Observation", "Examples"],
        feature.findings.map((finding) => [
          finding.severity,
          finding.finding,
          finding.evidence.join(", ") || "—",
        ]),
      ),
      "",
    );
  }

  lines.push("## Flows", "");
  if (feature.flows.length === 0) {
    lines.push("No flow could be assembled for this feature's endpoints.", "");
  } else {
    if (feature.totalFlowCount > feature.flows.length) {
      lines.push(
        `${feature.flows.length} of ${feature.totalFlowCount} flows are detailed here.`,
        "",
      );
    }
    if (feature.partialFlowCount > 0) {
      lines.push(
        `${feature.partialFlowCount} of ${feature.totalFlowCount} flows have at least one hop that could not be established.`,
        "",
      );
    }
    for (const flow of feature.flows) lines.push(flowSection(flow));
  }

  return lines.join("\n");
}

function dataModelSection(records: DataModelRecords): string {
  if (records.entities.length === 0) {
    return "No entity declarations were found in the analyzed roots.\n";
  }

  const lines: string[] = [];
  for (const entity of [...records.entities].sort(
    (a, b) => a.rootName.localeCompare(b.rootName) || a.name.localeCompare(b.name),
  )) {
    const fields = records.fields.filter(
      (field) => field.rootName === entity.rootName && field.entityName === entity.name,
    );
    const relations = records.relations.filter(
      (relation) => relation.rootName === entity.rootName && relation.fromEntity === entity.name,
    );
    const constraints = records.constraints.filter(
      (constraint) =>
        constraint.rootName === entity.rootName && constraint.entityName === entity.name,
    );

    lines.push(
      `### ${entity.name}`,
      "",
      `${entity.kind} in ${entity.rootName} — ${entity.provenance.source.relPath}:${entity.provenance.source.startLine}`,
      "",
    );

    if (fields.length > 0) {
      lines.push(
        table(
          ["Field", "Type", "Nullable", "Primary key", "Default"],
          fields.map((field) => [
            field.name,
            field.declaredType ?? "—",
            field.nullable === null ? "unknown" : field.nullable ? "yes" : "no",
            field.isPrimaryKey ? "yes" : "no",
            field.defaultValue ?? "—",
          ]),
        ),
        "",
      );
    }
    if (relations.length > 0) {
      lines.push(
        table(
          ["From field", "To entity", "To field", "Kind"],
          relations.map((relation) => [
            relation.fromField ?? "—",
            relation.toEntity,
            relation.toField ?? "—",
            relation.kind,
          ]),
        ),
        "",
      );
    }
    if (constraints.length > 0) {
      lines.push(
        table(
          ["Constraint", "Fields", "Expression"],
          constraints.map((constraint) => [
            constraint.kind,
            constraint.fields.join(", ") || "—",
            constraint.expression ?? "—",
          ]),
        ),
        "",
      );
    }
  }

  return lines.join("\n");
}

export function renderOverviewPage(model: ReportModel): string {
  const lines = [
    `# ${model.projectName}`,
    "",
    `Run \`${model.runId}\`, generated ${model.generatedAt}.`,
    "",
  ];

  const intro = composeIntroduction(model);
  lines.push("## What this is", "");
  if (intro.quoted !== null) {
    lines.push(
      ...intro.quoted.split("\n").map((line) => (line.trim() === "" ? ">" : `> ${line}`)),
      "",
      `— quoted from ${intro.quotedFrom ?? "the source"}, which describes that part rather than the whole.`,
      "",
    );
  }
  lines.push(...intro.paragraphs.flatMap((paragraph) => [paragraph, ""]));

  lines.push(
    "## Services",
    "",
    table(
      ["Service", "Files analyzed", "Files excluded"],
      model.roots.map((root) => [root.name, String(root.analyzed), String(root.excluded)]),
    ),
    "",
    "## Project map",
    "",
    fence(model.mapDiagram),
    "",
    "## Features",
    "",
    table(
      ["Feature", "Services", "Endpoints", "Tables", "Flows", "Incomplete flows"],
      model.features.map((feature) => [
        `[${feature.name}](modules/${featureSlug(feature)}.md)`,
        feature.rootNames.join(", "),
        String(feature.endpoints.length),
        String(feature.tables.length),
        String(feature.totalFlowCount),
        String(feature.partialFlowCount),
      ]),
    ),
    "",
  );

  if (model.unassignedEndpointCount > 0) {
    lines.push(
      `${model.unassignedEndpointCount} endpoints name no detected feature and appear only under their service.`,
      "",
    );
  }

  if (model.screens.length > 0) {
    lines.push(
      "## Screens",
      "",
      "Client-side routes the application declares. These are what it shows, not what it serves.",
      "",
      table(
        ["Path", "Application", "Full path known"],
        model.screens.map((screen) => [
          screen.path,
          screen.rootName,
          screen.pathComplete ? "yes" : "no — mounted under a parent declared elsewhere",
        ]),
      ),
      "",
    );
  }

  if (model.integrations.length > 0) {
    lines.push(
      "## Integrations",
      "",
      table(
        ["From", "To", "Calls"],
        model.integrations.map((integration) => [
          integration.from,
          integration.to,
          String(integration.calls),
        ]),
      ),
      "",
    );
  }

  lines.push(
    "## Data model",
    "",
    `${model.dataEntities.length} tables are described in [data-model.md](data-model.md).`,
    "",
  );

  if (model.signals.length > 0) {
    lines.push(
      "## Health",
      "",
      table(
        ["Severity", "Signal", "Finding"],
        model.signals.map((signal) => [signal.severity, signal.title, signal.finding]),
      ),
      "",
    );
  }

  lines.push(
    "## What this report cannot tell you",
    "",
    ...(model.coverageNotes.length === 0
      ? ["No coverage limits were recorded for this run."]
      : model.coverageNotes.map((note) => `- **${note.subject}** — ${note.note}`)),
    "",
  );

  return lines.join("\n");
}

/** The whole bundle: one overview and one page per feature. */
export function renderMarkdownReport(
  model: ReportModel,
  records: DataModelRecords,
): readonly MarkdownPage[] {
  return [
    { filename: "overview.md", markdown: renderOverviewPage(model) },
    { filename: "data-model.md", markdown: `# Data model\n\n${dataModelSection(records)}` },
    ...model.features.map((feature) => ({
      filename: `modules/${featureSlug(feature)}.md`,
      markdown: renderFeaturePage(feature),
    })),
  ];
}
