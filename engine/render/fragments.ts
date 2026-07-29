/**
 * The sections code can fill: tables, diagrams, lists.
 *
 * A fragment gets the slice its section asked for and returns Markdown. It
 * states facts and nothing else — no adjectives, no conclusions, no counts
 * dressed as judgements. Anything that needs a sentence about what the facts
 * mean is an `llm` section with a prompt someone can edit.
 */

import type { KnowledgeBase, Coverage, EntityModel } from "../kb/query.js";
import type { CoverageNote, FeatureFact, MapEdge, ModuleFact, RunContext } from "../kb/facts.js";
import type { RouteRecord } from "../structural/boundaries.js";
import type { BusinessRule } from "../semantics/rules.js";
import type { ValueSet } from "../semantics/enums.js";

export interface FragmentInput {
  /** Selector name → what it resolved to, in the order the section listed. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly params: Readonly<Record<string, string>>;
  readonly kb: KnowledgeBase;
}

export class FragmentError extends Error {
  constructor(name: string) {
    super(`Unknown fragment "${name}". Available: ${fragmentNames().join(", ")}`);
    this.name = "FragmentError";
  }
}

type Fragment = (input: FragmentInput) => string;

function pick<T>(input: FragmentInput, selector: string): T | undefined {
  return input.data[selector] as T | undefined;
}

/** The first of several selectors the section might have used. */
function firstOf<T>(input: FragmentInput, selectors: readonly string[]): T | undefined {
  for (const selector of selectors) {
    const value = input.data[selector];
    if (value !== undefined) return value as T;
  }
  return undefined;
}

interface FlowShape {
  readonly method: string | null;
  readonly path: string;
  readonly diagram: string;
  readonly partial: boolean;
  readonly steps: readonly {
    readonly kind: string;
    readonly label: string;
    readonly rootName: string | null;
    readonly conditions: readonly string[];
    readonly unresolvedReason: string | null;
  }[];
}

function cell(text: unknown): string {
  return String(text ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function table(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  if (rows.length === 0) return "";
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function mermaid(source: string): string {
  return source.trim() === "" ? "" : ["```mermaid", source, "```"].join("\n");
}

/**
 * How to read an empty list — the project has none, or nobody looked.
 *
 * When the readers did supply records of that kind, their standing limits are
 * not the explanation and printing them implies otherwise. That case gets a
 * plain statement of what was read instead.
 */
function coverageLine(coverage: Coverage | undefined, subject: string): string {
  if (coverage === undefined) return "";
  if (!coverage.attempted) {
    return `No reader in this run looked for ${subject}, so nothing here says whether the project has any.`;
  }

  const found = coverage.outcomes.reduce((total, outcome) => total + outcome.recordCount, 0);
  if (found > 0) return `${found} were read. None of them ended up here.`;

  const reasons = coverage.outcomes
    .filter((outcome) => outcome.reason !== null)
    .map((outcome) => `${outcome.providerId}: ${outcome.reason!}`);
  return reasons.length === 0
    ? `Nothing was found, by readers that did look for ${subject}.`
    : "Nothing was found. What the readers said they cannot do:\n\n" +
        reasons.map((reason) => `- ${reason}`).join("\n");
}

const FRAGMENTS: Readonly<Record<string, Fragment>> = {
  "project-summary": (input) => {
    const context = pick<RunContext | null>(input, "run-context");
    if (!context) return "No run context was recorded for this analysis.";

    const parts: string[] = [];
    if (context.description !== null) {
      parts.push(context.description.split("\n\n— ")[0]!.trim(), "");
    }
    parts.push(
      table(
        ["Part", "Language", "Files analyzed", "Files excluded"],
        context.roots.map((root) => [root.name, root.language, root.analyzed, root.excluded]),
      ),
    );
    return parts.filter((part) => part !== "").join("\n\n");
  },

  "project-map": (input) => {
    const context = pick<RunContext | null>(input, "run-context");
    const edges = pick<readonly MapEdge[]>(input, "map-edges") ?? [];
    const parts = [mermaid(context?.mapDiagram ?? "")];
    if (edges.length > 0) {
      parts.push(
        table(
          ["From", "To", "Kind", "Detail"],
          edges.map((edge) => [edge.from, edge.to, edge.kind, edge.detail]),
        ),
      );
    }
    return parts.filter((part) => part !== "").join("\n\n");
  },

  "features-table": (input) => {
    const features = pick<readonly FeatureFact[]>(input, "features") ?? [];
    if (features.length === 0) {
      const coverage = pick<Coverage>(input, "coverage:route");
      const routes = (coverage?.outcomes ?? []).reduce(
        (total, outcome) => total + outcome.recordCount,
        0,
      );
      // A capability needs one term to appear in more than one kind of place.
      // With entry points read and none forming one, the absence is about the
      // grouping, not about whether anything was looked at.
      return routes > 0
        ? `${routes} entry points were read, but no term appeared in enough places to name a capability.`
        : coverageLine(coverage, "entry points");
    }
    return table(
      ["Capability", "Parts", "Endpoints", "Flows", "Tables", "Evidence"],
      features.map((feature) => [
        feature.name,
        feature.rootNames.join(", "),
        feature.endpoints.length,
        feature.partialFlowCount > 0
          ? `${feature.flowCount} (${feature.partialFlowCount} partial)`
          : feature.flowCount,
        feature.tables.join(", "),
        feature.signals.join(" · "),
      ]),
    );
  },

  "screens-table": (input) => {
    const screens = pick<readonly RouteRecord[]>(input, "screens") ?? [];
    if (screens.length === 0) return coverageLine(pick<Coverage>(input, "coverage:route"), "screens");
    return table(
      ["Part", "Path", "Complete"],
      screens.map((screen) => [
        screen.rootName,
        screen.path,
        // A screen under a parent declared elsewhere has a path fragment, not
        // the address a user visits.
        screen.provenance.resolutionClass === "inferred" ? "partial path" : "yes",
      ]),
    );
  },

  "endpoints-table": (input) => {
    const endpoints = pick<readonly RouteRecord[]>(input, "endpoints") ?? [];
    if (endpoints.length === 0) {
      return coverageLine(pick<Coverage>(input, "coverage:route"), "entry points");
    }
    return table(
      ["Method", "Path", "Part", "Middleware"],
      endpoints.map((route) => [
        route.method ?? "ANY",
        route.path,
        route.rootName,
        route.middleware.join(", "),
      ]),
    );
  },

  "data-model": (input) => {
    const models = (pick<readonly (EntityModel | null)[]>(input, "entity-models") ?? []).filter(
      (model): model is EntityModel => model !== null,
    );
    if (models.length === 0) {
      return coverageLine(pick<Coverage>(input, "coverage:entity"), "table declarations");
    }

    return models
      .map((model) => {
        const heading = `**${model.entity.name}** — ${model.entity.rootName}`;
        const columns = table(
          ["Column", "Type", "Nullable", "Key", "Source"],
          model.fields.map((field) => [
            field.name,
            field.declaredType,
            field.nullable === null ? "—" : field.nullable ? "yes" : "no",
            field.isPrimaryKey ? "primary" : "",
            `${field.provenance.source.relPath}:${field.provenance.source.startLine}`,
          ]),
        );
        const relations =
          model.relations.length === 0
            ? ""
            : model.relations
                .map(
                  (relation) =>
                    `- ${relation.fromField ?? "?"} → ${relation.toEntity}.${relation.toField ?? "?"} (${relation.kind})`,
                )
                .join("\n");
        return [heading, columns, relations].filter((part) => part !== "").join("\n\n");
      })
      .join("\n\n");
  },

  "rules-table": (input) => {
    const rules =
      pick<readonly BusinessRule[]>(input, "feature-rules") ??
      pick<readonly BusinessRule[]>(input, "business-rules") ??
      [];
    if (rules.length === 0) return "";
    return table(
      ["Rule", "As written", "Fails the check", "Where"],
      rules.map((rule) => [
        rule.statement,
        `\`${rule.text}\``,
        rule.guarded === "rejects" ? "stops the request" : rule.guarded === "continues" ? "carries on" : "—",
        `${rule.rootName}/${rule.relPath}:${rule.startLine}`,
      ]),
    );
  },

  "value-sets": (input) => {
    const sets = pick<readonly ValueSet[]>(input, "value-sets") ?? [];
    if (sets.length === 0) return "";
    return sets
      .map((set) =>
        [
          `**${set.name}** — ${set.rootName}/${set.relPath}:${set.startLine}`,
          table(
            ["Name", "Value"],
            set.members.map((member) => [member.name, member.value]),
          ),
        ].join("\n\n"),
      )
      .join("\n\n");
  },

  flows: (input) => {
    const flows = firstOf<readonly FlowShape[]>(input, ["module-flows", "feature-flows"]) ?? [];
    if (flows.length === 0) return "";

    return flows
      .map((flow) =>
        [
          `**${flow.method ?? "ANY"} ${flow.path}**${flow.partial ? " — some hops could not be established" : ""}`,
          mermaid(flow.diagram),
          table(
            ["Step", "What", "Part", "Conditions", "Not established"],
            flow.steps.map((step) => [
              step.kind,
              step.label,
              step.rootName,
              step.conditions.join(", "),
              step.unresolvedReason,
            ]),
          ),
        ]
          .filter((part) => part !== "")
          .join("\n\n"),
      )
      .join("\n\n");
  },

  "findings-table": (input) => {
    const structural =
      pick<readonly { id: string; severity: string; title: string; finding: string; evidence: readonly string[] }[]>(
        input,
        "structural-findings",
      ) ?? [];
    const perFeature =
      pick<readonly { featureName: string; severity: string; title: string; finding: string }[]>(
        input,
        "feature-findings",
      ) ?? [];

    const rows = [
      ...structural.map((finding) => [finding.severity, "the architecture", finding.title, finding.finding]),
      ...perFeature.map((finding) => [finding.severity, finding.featureName, finding.title, finding.finding]),
    ];
    if (rows.length === 0) return "Nothing was found that needs a second look.";
    return table(["Severity", "About", "Finding", "What was observed"], rows);
  },

  "signals-table": (input) => {
    const signals =
      pick<readonly { id: string; severity: string; title: string; finding: string; value: number }[]>(
        input,
        "signals",
      ) ?? [];
    if (signals.length === 0) return "";
    return table(
      ["Severity", "Measure", "Value", "What it means"],
      signals.map((signal) => [signal.severity, signal.title, signal.value, signal.finding]),
    );
  },

  "module-surface": (input) => {
    const detail = pick<{ module: ModuleFact } | null>(input, "module-detail:$module");
    if (!detail) return "";
    const module = detail.module;
    return [
      table(
        ["Part", "Symbols", "Grouped by"],
        [[module.rootNames.join(", "), module.symbolCount, module.groupingSignal]],
      ),
      table(
        ["Method", "Path", "Part"],
        module.endpoints.map((endpoint) => [
          endpoint.method ?? "ANY",
          endpoint.path,
          endpoint.rootName,
        ]),
      ),
    ]
      .filter((part) => part !== "")
      .join("\n\n");
  },

  limitations: (input) => {
    const notes = pick<readonly CoverageNote[]>(input, "coverage-notes") ?? [];
    const failures =
      pick<readonly { providerId: string; scope: string; reason: string }[]>(
        input,
        "extraction-failures",
      ) ?? [];

    const parts: string[] = [];
    if (notes.length > 0) {
      parts.push(
        table(
          ["About", "What this analysis could not establish"],
          notes.map((note) => [note.subject, note.note]),
        ),
      );
    }
    if (failures.length > 0) {
      parts.push(
        table(
          ["Reader", "Where", "What went wrong"],
          failures.slice(0, 50).map((failure) => [failure.providerId, failure.scope, failure.reason]),
        ),
      );
    }
    return parts.length === 0
      ? "This run recorded no limits on what it could read, which is itself worth doubting."
      : parts.join("\n\n");
  },
};

export function fragmentNames(): readonly string[] {
  return Object.keys(FRAGMENTS).sort();
}

export function hasFragment(name: string): boolean {
  return name in FRAGMENTS;
}

export function renderFragment(name: string, input: FragmentInput): string {
  const fragment = FRAGMENTS[name];
  if (fragment === undefined) throw new FragmentError(name);
  return fragment(input);
}
