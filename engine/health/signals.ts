/**
 * Health signals, derived from what earlier stages already computed.
 *
 * No external analyzers: provisioning them is a real cost, and the graph
 * already supports signals worth having.
 *
 * ## Signals, not scores
 *
 * Every signal states a measured fact and the evidence behind it. There is no
 * composite health number, deliberately — a single score invites comparison
 * between projects that share no context, and hides which of its inputs
 * actually moved. A reader can rank on whichever signal matters to them.
 */

import { joinKey } from "../structural/identity.js";
import type { LinkResult } from "../linking/types.js";
import type { Trace } from "../modules/trace.js";
import type { ProductModule, TechnicalComponent, DispositionCounts } from "../modules/form.js";
import type { PackageDependencyRecord } from "../structural/dependencies.js";

export type Severity = "info" | "notice" | "concern";

export interface HealthSignal {
  readonly id: string;
  readonly title: string;
  /** The measured fact, in plain words. */
  readonly finding: string;
  readonly severity: Severity;
  /** What the number came from, so a reader can check it. */
  readonly evidence: readonly string[];
  readonly value: number;
}

export interface HealthInput {
  readonly links: LinkResult;
  readonly traces: readonly Trace[];
  readonly untracedEntryPoints: number;
  readonly modules: readonly ProductModule[];
  readonly components: readonly TechnicalComponent[];
  readonly dispositions: DispositionCounts;
  readonly dependencies: readonly PackageDependencyRecord[];
  readonly rootNames: readonly string[];
}

function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

/**
 * Cross-root dependency cycles.
 *
 * Reported as a cycle among *roots*, not among symbols: a symbol-level cycle
 * is often deliberate and local, while two services calling each other is a
 * deployment and change-coupling problem a reader can act on.
 */
export function findRootCycles(links: LinkResult): readonly string[][] {
  const edges = new Map<string, Set<string>>();
  for (const link of links.links) {
    const targets = edges.get(link.fromRoot) ?? new Set<string>();
    targets.add(link.toRoot);
    edges.set(link.fromRoot, targets);
  }

  const cycles: string[][] = [];
  // Keyed through the shared escaping helper: root names are directory
  // basenames and routinely contain spaces, so an unescaped join lets two
  // genuinely different cycles collapse into one and silently disappear.
  const seen = new Set<string>();

  // Depth-first, so a cycle of any length is found. A three-service loop
  // A→B→C→A has no mutual pair anywhere, and a mutual-pair check would report
  // "no two roots call each other" — true, and misleading.
  const visit = (start: string, current: string, path: string[]): void => {
    for (const next of edges.get(current) ?? []) {
      if (next === start) {
        const rotated = [...path];
        const smallest = rotated.indexOf([...rotated].sort()[0]!);
        const canonical = [...rotated.slice(smallest), ...rotated.slice(0, smallest)];
        const key = joinKey(canonical);
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(canonical);
        }
        continue;
      }
      if (path.includes(next)) continue;
      if (path.length >= 6) continue; // bounded, like every other traversal here
      visit(start, next, [...path, next]);
    }
  };

  for (const root of edges.keys()) visit(root, root, [root]);

  return cycles;
}

export function computeSignals(input: HealthInput): readonly HealthSignal[] {
  const signals: HealthSignal[] = [];

  // --- how much of the picture is actually resolved ---
  const linked = input.links.links.length;
  const unlinkedRatio = percent(input.links.unlinked.length, input.links.considered);
  signals.push({
    id: "unresolved-integrations",
    title: "Unresolved outbound calls",
    finding:
      input.links.considered === 0
        ? "No outbound calls were detected, so nothing could be linked."
        : `${unlinkedRatio}% of outbound calls could not be tied to a route in this workspace (${input.links.unlinked.length} of ${input.links.considered}).`,
    severity: unlinkedRatio > 50 ? "concern" : unlinkedRatio > 20 ? "notice" : "info",
    evidence: [
      `${linked} linked, ${input.links.unlinked.length} unlinked`,
      ...[...new Set(input.links.unlinked.map((call) => call.reason))].map(
        (reason) => `reason: ${reason}`,
      ),
    ],
    value: unlinkedRatio,
  });

  // --- coupling between roots ---
  const cycles = findRootCycles(input.links);
  signals.push({
    id: "root-cycles",
    title: "Services that call each other",
    finding:
      cycles.length === 0
        ? "No circular call relationships were found between roots."
        : `${cycles.length} circular call relationship(s) between roots, which couples their deployment and change cycles.`,
    severity: cycles.length > 0 ? "concern" : "info",
    evidence: cycles.map((cycle) => [...cycle, cycle[0]].join(" → ")),
    value: cycles.length,
  });

  // --- traces that could not be completed ---
  const partial = input.traces.filter((trace) => trace.partial).length;
  const partialRatio = percent(partial, input.traces.length);
  signals.push({
    id: "partial-traces",
    title: "Traces that stopped early",
    finding:
      input.traces.length === 0
        ? "No traces were built, so nothing could be followed end to end."
        : `${partialRatio}% of traces stopped before completing (${partial} of ${input.traces.length}).`,
    severity: partialRatio > 60 ? "concern" : partialRatio > 30 ? "notice" : "info",
    evidence: [
      ...new Set(
        input.traces.filter((t) => t.partial).map((t) => `stopped by: ${t.truncation}`),
      ),
    ],
    value: partialRatio,
  });

  // --- entry points nobody could follow ---
  const totalEntries = input.traces.length + input.untracedEntryPoints;
  const untracedRatio = percent(input.untracedEntryPoints, totalEntries);
  signals.push({
    id: "untraced-entry-points",
    title: "Entry points with no traceable handler",
    finding:
      totalEntries === 0
        ? "No entry points were found."
        : `${untracedRatio}% of entry points could not be followed into code (${input.untracedEntryPoints} of ${totalEntries}).`,
    severity: untracedRatio > 50 ? "concern" : untracedRatio > 20 ? "notice" : "info",
    evidence: [`${input.traces.length} traced, ${input.untracedEntryPoints} untraced`],
    value: untracedRatio,
  });

  // --- how much code any behaviour explains ---
  const explained = percent(
    input.dispositions.behavioralSource,
    Math.max(input.dispositions.total, 1),
  );
  signals.push({
    id: "behavioural-coverage",
    title: "Code reached by some behaviour",
    finding: `${explained}% of files are reached by at least one trace; ${percent(input.dispositions.unclassified, Math.max(input.dispositions.total, 1))}% are unclassified.`,
    severity: explained < 20 ? "notice" : "info",
    evidence: [
      `behavioural ${input.dispositions.behavioralSource}`,
      `shared infrastructure ${input.dispositions.sharedInfrastructure}`,
      `technical only ${input.dispositions.technicalOnly}`,
      `unclassified ${input.dispositions.unclassified}`,
    ],
    value: explained,
  });

  // --- modules spanning many roots ---
  const spanning = input.modules.filter((module) => module.rootNames.length > 1);
  signals.push({
    id: "modules-spanning-roots",
    title: "Features implemented across several services",
    finding:
      spanning.length === 0
        ? "No feature spans more than one root."
        : `${spanning.length} feature(s) span more than one root, so a change to them touches several services.`,
    severity: spanning.length > 0 ? "notice" : "info",
    evidence: spanning.map((module) => `${module.name}: ${module.rootNames.join(", ")}`),
    value: spanning.length,
  });

  // --- dependency weight ---
  const direct = input.dependencies.filter((d) => d.directness === "direct").length;
  signals.push({
    id: "declared-dependencies",
    title: "Declared dependencies",
    finding: `${direct} direct dependencies are declared across ${input.rootNames.length} root(s).`,
    severity: "info",
    evidence: [`${input.dependencies.length} total declarations`],
    value: direct,
  });

  return signals;
}
