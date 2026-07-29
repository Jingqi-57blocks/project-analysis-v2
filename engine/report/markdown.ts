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

import type { SpecEntity } from "./json.js";
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
  const parts = [
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

  // Before the inventory, not after it: what is worth checking is why someone
  // opened this page, and a section below forty endpoints is a section nobody
  // reaches.
  if (feature.findings.length > 0) {
    parts.push(
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

  if (feature.endpoints.length > 0) {
    parts.push(
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
    parts.push("## Data", "");
    if (feature.tables.length > 0) {
      parts.push(`Tables its handlers touch: ${feature.tables.join(", ")}`, "");
    }
    if (feature.dataEntities.length > 0) {
      parts.push(`Entities named after it: ${feature.dataEntities.join(", ")}`, "");
    }
  }

  parts.push("## Flows", "");
  if (feature.flows.length === 0) {
    parts.push("No flow could be assembled for this feature's endpoints.", "");
  } else {
    if (feature.totalFlowCount > feature.flows.length) {
      parts.push(
        `${feature.flows.length} of ${feature.totalFlowCount} flows are detailed here.`,
        "",
      );
    }
    if (feature.partialFlowCount > 0) {
      parts.push(
        `${feature.partialFlowCount} of ${feature.totalFlowCount} flows have at least one hop that could not be established.`,
        "",
      );
    }
    for (const flow of feature.flows) parts.push(flowSection(flow));
  }

  return parts.join("\n");
}

/**
 * Rendered from the specification's own entities rather than the records they
 * came from, so a published report can be re-rendered from the file alone.
 */
function dataModelSection(entities: readonly SpecEntity[]): string {
  if (entities.length === 0) return "No entity declarations were found in the analyzed roots.\n";

  const lines: string[] = [];
  for (const entity of entities) {
    lines.push(
      `### ${entity.name}`,
      "",
      `${entity.kind} in ${entity.service} — ${entity.source}`,
      "",
    );

    if (entity.fields.length > 0) {
      lines.push(
        table(
          ["Field", "Type", "Nullable", "Primary key", "Default"],
          entity.fields.map((field) => [
            field.name,
            field.declaredType ?? "—",
            field.nullable === null ? "unknown" : field.nullable ? "yes" : "no",
            field.primaryKey ? "yes" : "no",
            field.defaultValue ?? "—",
          ]),
        ),
        "",
      );
    }
    if (entity.relations.length > 0) {
      lines.push(
        table(
          ["From field", "To entity", "To field", "Kind"],
          entity.relations.map((relation) => [
            relation.fromField ?? "—",
            relation.toEntity,
            relation.toField ?? "—",
            relation.kind,
          ]),
        ),
        "",
      );
    }
    if (entity.constraints.length > 0) {
      lines.push(
        table(
          ["Constraint", "Fields", "Expression"],
          entity.constraints.map((constraint) => [
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

  // What to look at, in one place. Scattering findings across forty feature
  // pages means a reader has to already suspect something to find it.
  const findings = model.features.flatMap((feature) =>
    feature.findings.map((finding) => ({ feature, finding })),
  );
  const rank: Record<string, number> = { concern: 0, notice: 1, info: 2 };
  findings.sort(
    (a, b) =>
      (rank[a.finding.severity] ?? 3) - (rank[b.finding.severity] ?? 3) ||
      a.feature.name.localeCompare(b.feature.name),
  );

  if (findings.length > 0) {
    const counts = findings.reduce<Record<string, number>>((totals, { finding }) => {
      totals[finding.severity] = (totals[finding.severity] ?? 0) + 1;
      return totals;
    }, {});

    lines.push(
      "## What to look at",
      "",
      `${findings.length} observations across ${
        new Set(findings.map((entry) => entry.feature.id)).size
      } capabilities` +
        `${Object.entries(counts)
          .map(([severity, count]) => ` — ${count} ${severity}`)
          .join("")}.`,
      "",
      table(
        ["Severity", "Capability", "Observation", "Examples"],
        findings.map(({ feature, finding }) => [
          finding.severity,
          `[${feature.name}](modules/${featureSlug(feature)}.md)`,
          finding.finding,
          finding.evidence.slice(0, 3).join(", ") || "—",
        ]),
      ),
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
      // Not "health": these measure how much of the system this run could
      // reach, which is a statement about the analysis rather than about the
      // product a reader is deciding on.
      "## How much this analysis could see",
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
  entities: readonly SpecEntity[],
): readonly MarkdownPage[] {
  return [
    { filename: "overview.md", markdown: renderOverviewPage(model) },
    { filename: "data-model.md", markdown: `# Data model\n\n${dataModelSection(entities)}` },
    ...model.features.map((feature) => ({
      filename: `modules/${featureSlug(feature)}.md`,
      markdown: renderFeaturePage(feature),
    })),
  ];
}
