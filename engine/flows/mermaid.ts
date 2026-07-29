/**
 * Renders flows as Mermaid, for the diagram a reader actually looks at.
 *
 * Two rules carry the honesty of the picture into the drawing: an unresolved
 * step is drawn as a dashed node with its reason attached, and no edge is ever
 * drawn between two steps that were not observed to connect. A clean-looking
 * diagram that skipped its gaps would be the most persuasive lie the tool
 * could tell.
 */

import type { FeatureFlow, FlowStep } from "./types.js";

/**
 * Mermaid has no escape syntax inside node labels: a `"` ends the label and a
 * `[` or `(` changes the node's shape. Substituting look-alikes keeps the text
 * readable and the diagram parseable, which matters because route paths and
 * table names routinely contain both.
 */
export function escapeLabel(text: string): string {
  return text
    .replaceAll("\\", "＼")
    .replaceAll('"', "'")
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .replaceAll("{", "(")
    .replaceAll("}", ")")
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replaceAll("\n", " ");
}

function nodeId(index: number): string {
  return `s${index}`;
}

function shapeFor(step: FlowStep, id: string, label: string): string {
  switch (step.kind) {
    case "frontend-call":
      return `${id}(["${label}"])`;
    case "data-access":
      return `${id}[("${label}")]`;
    case "route":
      return `${id}["${label}"]`;
    default:
      return `${id}("${label}")`;
  }
}

function labelFor(step: FlowStep): string {
  const parts = [step.label];
  if (step.rootName !== null && step.kind !== "frontend-call") parts.push(`(${step.rootName})`);
  return escapeLabel(parts.join(" "));
}

/**
 * One flow as a left-to-right chart.
 *
 * Conditions ride on the edge into a step rather than inside the node: a
 * middleware or a validation is something that happens on the way in, and
 * putting it on the arrow says that without a legend.
 */
export function flowToMermaid(flow: FeatureFlow): string {
  const lines = ["flowchart LR"];
  const dashed: string[] = [];

  flow.steps.forEach((step, index) => {
    const id = nodeId(index);
    lines.push(`  ${shapeFor(step, id, labelFor(step))}`);
    if (step.unresolvedReason !== null) dashed.push(id);
  });

  // Tables and outbound calls all hang off the handler rather than off each
  // other. Chaining them would draw an order the code never states — that
  // wcp_leave is written before wcp_leave_detail — and a reader would believe
  // the sequence because the arrows said so.
  const parallel = new Set(["data-access", "outbound"]);
  let anchor = 0;

  for (let index = 1; index < flow.steps.length; index++) {
    const step = flow.steps[index]!;
    const isParallel = parallel.has(step.kind);
    const from = nodeId(isParallel ? anchor : index - 1);
    if (!isParallel) anchor = index;
    const to = nodeId(index);

    // A step that was not established is joined by a dotted edge: the
    // connection is as unobserved as the step itself.
    if (step.unresolvedReason !== null) {
      lines.push(`  ${from} -.->|"${escapeLabel(step.unresolvedReason)}"| ${to}`);
      continue;
    }
    // Evidence from the handler's package rather than the handler itself is
    // drawn as a weaker edge. A solid arrow from this endpoint to a table
    // asserts that this endpoint touches it, which is more than was observed.
    const arrow = step.indirect === true ? "-.->" : "-->";
    if (step.conditions.length > 0) {
      lines.push(`  ${from} ${arrow}|"${escapeLabel(step.conditions.join(", "))}"| ${to}`);
      continue;
    }
    lines.push(`  ${from} ${arrow} ${to}`);
  }

  for (const id of dashed) {
    lines.push(`  style ${id} stroke-dasharray: 4 3`);
  }

  return lines.join("\n");
}

/**
 * A feature's endpoints as one chart, callers on the left and tables on the
 * right, so the shape of the feature is visible without reading every flow.
 */
export function featureOverviewMermaid(
  featureName: string,
  flows: readonly FeatureFlow[],
  maxEndpoints = 14,
): string {
  const lines = ["flowchart LR"];
  const shown = flows.slice(0, maxEndpoints);

  const callers = new Set<string>();
  const tables = new Set<string>();
  const edges = new Set<string>();

  shown.forEach((flow, index) => {
    const endpoint = `e${index}`;
    lines.push(`  ${endpoint}["${escapeLabel(`${flow.method ?? "ANY"} ${flow.path}`)}"]`);

    for (const step of flow.steps) {
      if (step.unresolvedReason !== null) continue;
      if (step.kind === "frontend-call") {
        for (const caller of step.label.split(", ")) {
          callers.add(caller);
          edges.add(`  c_${slug(caller)} --> ${endpoint}`);
        }
      }
      if (step.kind === "data-access") {
        tables.add(step.label);
        edges.add(
          `  ${endpoint} ${step.indirect === true ? "-.->" : "-->"} t_${slug(step.label)}`,
        );
      }
    }
  });

  for (const caller of [...callers].sort()) {
    lines.push(`  c_${slug(caller)}(["${escapeLabel(caller)}"])`);
  }
  for (const table of [...tables].sort()) {
    lines.push(`  t_${slug(table)}[("${escapeLabel(table)}")]`);
  }
  lines.push(...[...edges].sort());

  if (flows.length > shown.length) {
    lines.push(`  more["${escapeLabel(`${flows.length - shown.length} more endpoints`)}"]`);
    lines.push(`  style more stroke-dasharray: 4 3`);
  }

  return lines.length > 1 ? lines.join("\n") : `flowchart LR\n  none["${escapeLabel(featureName)}: nothing observed"]`;
}

/** A Mermaid-safe identifier for arbitrary text. */
function slug(text: string): string {
  return text.replaceAll(/[^\w]/g, "_");
}
