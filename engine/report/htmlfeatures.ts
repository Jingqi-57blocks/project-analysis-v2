/**
 * The feature pages: what the product does, one capability at a time.
 *
 * Separate from the overview renderer because they answer a different
 * question. The overview says what the system is; these say what happens when
 * someone submits a leave request — which is the question a reader actually
 * arrived with, and the one the report could not answer before.
 */

import { escapeHtml } from "./html.js";
import type { ReportFeature, ReportFlow, ReportModel } from "./model.js";
import { stringsFor } from "./strings.js";

export interface FeaturePage {
  readonly filename: string;
  readonly title: string;
  readonly body: string;
}

/** A filename-safe name for a feature, unique by construction. */
export function featurePageName(feature: ReportFeature): string {
  const base = feature.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `feature-${base || "unnamed"}-${feature.id.slice(-6)}.html`;
}

function diagram(source: string): string {
  return `<div class="scroll"><pre class="mermaid">${escapeHtml(source)}</pre></div>`;
}

function conditionList(conditions: readonly string[]): string {
  if (conditions.length === 0) return "";
  return `<ul class="conditions">${conditions
    .map((condition) => `<li>${escapeHtml(condition)}</li>`)
    .join("")}</ul>`;
}

function flowSection(flow: ReportFlow, index: number): string {
  const rows = flow.steps
    .map((step) => {
      const unresolved =
        step.unresolvedReason === null
          ? ""
          : `<div class="gap">${escapeHtml(step.unresolvedReason)}</div>`;
      return `<tr>
        <td class="kind">${escapeHtml(step.kind)}</td>
        <td><strong>${escapeHtml(step.label)}</strong>${conditionList(step.conditions)}${unresolved}</td>
        <td class="where">${step.rootName === null ? "—" : escapeHtml(step.rootName)}</td>
      </tr>`;
    })
    .join("");

  const badge = flow.partial
    ? '<span class="badge partial">incomplete</span>'
    : '<span class="badge complete">end to end</span>';

  return `<section class="flow" id="flow-${index}">
  <h3>${escapeHtml(`${flow.method ?? "ANY"} ${flow.path}`)} ${badge}</h3>
  ${diagram(flow.diagram)}
  <table class="steps"><tbody>${rows}</tbody></table>
</section>`;
}

export function renderFeaturePage(model: ReportModel, feature: ReportFeature): FeaturePage {
  const s = stringsFor(model.language);
  const parts: string[] = [
    `<h1>${escapeHtml(feature.name)}</h1>`,
    `<p class="meta">${escapeHtml(feature.rootNames.join(" · "))} — ${escapeHtml(
      feature.signals.join(" · "),
    )}</p>`,
    // On every page, so a reader who arrived at one directly still knows
    // which analysis they are reading.
    `<p class="meta">${escapeHtml(s.run)}: ${escapeHtml(model.runId)}</p>`,
    `<h2>${escapeHtml(s.featureShape)}</h2>`,
    diagram(feature.overviewDiagram),
  ];

  if (feature.endpoints.length > 0) {
    const rows = feature.endpoints
      .map(
        (endpoint) =>
          `<tr><td class="kind">${escapeHtml(endpoint.method ?? "ANY")}</td><td>${escapeHtml(
            endpoint.path,
          )}</td><td class="where">${escapeHtml(endpoint.rootName)}</td></tr>`,
      )
      .join("");
    parts.push(
      `<h2>${escapeHtml(s.featureEndpoints)}</h2>`,
      `<table class="steps"><tbody>${rows}</tbody></table>`,
    );
  }

  if (feature.tables.length > 0) {
    parts.push(
      `<h2>${escapeHtml(s.featureData)}</h2>`,
      `<p>${feature.tables.map((table) => `<code>${escapeHtml(table)}</code>`).join(" ")}</p>`,
    );
  }

  parts.push(`<h2>${escapeHtml(s.featureFlows)}</h2>`);
  if (feature.flows.length === 0) {
    parts.push(`<p class="note">${escapeHtml(s.featureNoFlows)}</p>`);
  } else {
    // Stated before the flows rather than after: a reader scrolling through
    // twenty-five diagrams should know from the outset that some hops are
    // unestablished, not discover it at the bottom.
    const counts = [
      feature.flows.length < feature.totalFlowCount
        ? s.featureFlowsShown(feature.flows.length, feature.totalFlowCount)
        : null,
      feature.partialFlowCount > 0
        ? s.featureFlowsPartial(feature.partialFlowCount, feature.totalFlowCount)
        : null,
    ].filter((note): note is string => note !== null);
    if (counts.length > 0) parts.push(`<p class="note">${escapeHtml(counts.join(" "))}</p>`);
    parts.push(...feature.flows.map(flowSection));
  }

  return {
    filename: featurePageName(feature),
    title: feature.name,
    body: parts.join("\n"),
  };
}

/** The index of features, ordered as the model ordered them. */
export function renderFeatureIndex(model: ReportModel): string {
  const s = stringsFor(model.language);
  const runLine = `<p class="meta">${escapeHtml(s.run)}: ${escapeHtml(model.runId)}</p>`;
  if (model.features.length === 0) {
    return `<h1>${escapeHtml(s.features)}</h1>${runLine}<p class="note">${escapeHtml(
      s.featuresNone,
    )}</p>`;
  }

  const rows = model.features
    .map(
      (feature) => `<tr>
      <td><a href="${escapeHtml(featurePageName(feature))}">${escapeHtml(feature.name)}</a></td>
      <td class="where">${escapeHtml(feature.rootNames.join(", "))}</td>
      <td>${feature.endpoints.length}</td>
      <td>${feature.tables.length}</td>
      <td>${feature.totalFlowCount - feature.partialFlowCount} / ${feature.totalFlowCount}</td>
    </tr>`,
    )
    .join("");

  const unassigned =
    model.unassignedEndpointCount > 0
      ? `<p class="note">${escapeHtml(s.featuresUnassigned(model.unassignedEndpointCount))}</p>`
      : "";

  return `<h1>${escapeHtml(s.features)}</h1>
${runLine}
<p class="note">${escapeHtml(s.featuresIntro)}</p>
<table class="steps"><thead><tr>
  <th>${escapeHtml(s.features)}</th><th>${escapeHtml(s.services)}</th>
  <th>${escapeHtml(s.featureEndpoints)}</th><th>${escapeHtml(s.featureData)}</th>
  <th>${escapeHtml(s.featureFlowsComplete)}</th>
</tr></thead><tbody>${rows}</tbody></table>
${unassigned}`;
}
