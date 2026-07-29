/**
 * The paragraph a reader meets first.
 *
 * A README quote alone answers "what is this" for one service and says nothing
 * about a workspace of five — and in a multi-root project the first README
 * found is an arbitrary choice presented as the project's own description. So
 * the quote is kept, attributed, and surrounded by what the analysis itself
 * established: how big the system is, what it does, and what it talks to.
 *
 * Composed from counts rather than written, so it cannot drift from the report
 * it introduces and cannot describe a capability nobody observed.
 */

import type { ReportModel } from "./model.js";

export interface Introduction {
  /** The developers' own words, when they wrote any. Null otherwise. */
  readonly quoted: string | null;
  /** Which root the quote came from, so it is never passed off as the whole. */
  readonly quotedFrom: string | null;
  readonly paragraphs: readonly string[];
}

function list(items: readonly string[], limit: number): string {
  const shown = items.slice(0, limit);
  const rest = items.length - shown.length;
  const joined =
    shown.length <= 1
      ? shown.join("")
      : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]!}`;
  return rest > 0 ? `${joined}, and ${rest} more` : joined;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function composeIntroduction(model: ReportModel): Introduction {
  const paragraphs: string[] = [];

  // The description carries its own attribution line; splitting it keeps the
  // quote quotable and the source visible.
  const [text, attribution] = (model.description ?? "").split("\n\n— ");
  const quoted = model.description === null ? null : (text ?? "").trim();
  const quotedFrom = attribution?.trim() ?? null;

  const endpoints = model.features.reduce((total, feature) => total + feature.endpoints.length, 0);
  const services = model.roots.map((root) => root.name);

  const serves = [
    endpoints > 0 ? `serve ${plural(endpoints, "endpoint", "endpoints")}` : null,
    model.screens.length > 0 ? `present ${plural(model.screens.length, "screen", "screens")}` : null,
  ].filter((part): part is string => part !== null);

  paragraphs.push(
    [
      `${model.projectName} is made of ${plural(services.length, "part", "parts")} — ${list(services, 6)}.`,
      serves.length > 0 ? `Together they ${serves.join(" and ")}.` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" "),
  );

  if (model.features.length > 0) {
    const named = model.features.slice(0, 8).map((feature) => feature.name);
    paragraphs.push(
      `Its capabilities, named after the vocabulary the code itself uses, are ${list(named, 8)}${
        model.features.length > named.length
          ? ` — ${model.features.length} in all`
          : ""
      }. A capability can span several parts; ${list(
        model.features
          .filter((feature) => feature.rootNames.length > 1)
          .slice(0, 3)
          .map((feature) => feature.name),
        3,
      ) || "none"} ${
        model.features.filter((feature) => feature.rootNames.length > 1).length === 1
          ? "does"
          : "do"
      } here.`,
    );
  }

  const external = [
    ...new Set(model.map.filter((edge) => edge.kind === "external").map((edge) => edge.to)),
  ].sort();
  // The map labels a store generically when nothing named one, and repeating
  // that label as if it were a product's name reads as a mistake.
  const stores = [
    ...new Set(
      model.map
        .filter((edge) => edge.kind === "datastore")
        .map((edge) => edge.to)
        .filter((name) => name !== "datastore"),
    ),
  ].sort();
  const hasUnnamedStore = model.map.some(
    (edge) => edge.kind === "datastore" && edge.to === "datastore",
  );

  const reaches = [
    external.length > 0 ? `reaches outside itself to ${list(external, 5)}` : null,
    stores.length > 0
      ? `stores data in ${list(stores, 4)}`
      : hasUnnamedStore
        ? "stores data in a database this analysis could not name"
        : null,
  ].filter((part): part is string => part !== null);

  if (reaches.length > 0) paragraphs.push(`It ${reaches.join(", and ")}.`);

  const described = model.dataEntities.length;
  if (described > 0) {
    paragraphs.push(
      `${plural(described, "table", "tables")} are described here with their columns. What could not be established is listed at the end, and every flow in this report marks the hops that could not be followed.`,
    );
  }

  return {
    quoted: quoted === "" ? null : quoted,
    quotedFrom,
    paragraphs,
  };
}
