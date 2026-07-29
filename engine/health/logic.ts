/**
 * What is worth a second look about a capability's behaviour.
 *
 * The other findings say what a capability is missing. These say what it does
 * that is likely to surprise someone: a rule applied one way here and another
 * way there, a number where the project has a name, a failure nobody can see.
 *
 * A contradiction between two parts is the strongest of these, because neither
 * part is wrong on its own — the disagreement is only visible from outside
 * both, which is the one vantage point this tool has.
 */

import type { BusinessRule } from "../semantics/rules.js";
import { isUnexplained } from "../semantics/rules.js";
import type { DiscardedErrorRecord } from "../structural/rules.js";
import type { FeatureFinding } from "./features.js";
import type { Severity } from "./signals.js";

export interface LogicInput {
  readonly featureId: string;
  readonly featureName: string;
  /** Rules stated in files this capability owns. */
  readonly rules: readonly BusinessRule[];
  readonly discarded: readonly DiscardedErrorRecord[];
  /** Every rule in the workspace, so a contradiction across parts is visible. */
  readonly allRules: readonly BusinessRule[];
}

export interface LogicLimits {
  readonly maxNamed: number;
  /** How many places a rule must appear in before repetition is worth saying. */
  readonly repetitionThreshold: number;
}

export const DEFAULT_LOGIC_LIMITS: LogicLimits = { maxNamed: 5, repetitionThreshold: 3 };

/** True when the operators differ only by whether the boundary is included. */
function sameDirectionBoundary(operators: ReadonlySet<string>): boolean {
  const above = new Set([">", ">="]);
  const below = new Set(["<", "<="]);
  const list = [...operators];
  return list.every((op) => above.has(op)) || list.every((op) => below.has(op));
}

/**
 * The field a rule is about, as one word.
 *
 * Two parts rarely name a variable the same way — one writes `takeHours` and
 * the other `lv.Hours` — so grouping on the whole name finds no disagreement
 * anywhere, which is how the real one went unreported. The last word is what
 * they agree on.
 */
function subjectKey(rule: BusinessRule): string {
  const last = rule.subject.split(".").pop() ?? rule.subject;
  const words = last
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[_-]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  return words[words.length - 1] ?? last.toLowerCase();
}

/**
 * Rules that state the same thing about the same subject in different ways.
 *
 * Grouped by subject and value, then reported when the operator differs — a
 * threshold of 40 applied as "at least" in one part and "more than" in another
 * puts exactly 40 down two different paths. Only across parts: one part using
 * both spellings usually means two genuinely different rules.
 */
export function findDivergence(
  rules: readonly BusinessRule[],
): readonly { subject: string; literal: number | string; variants: readonly BusinessRule[] }[] {
  const groups = new Map<string, BusinessRule[]>();
  for (const rule of rules) {
    const key = `${subjectKey(rule)}|${rule.literal}`;
    const existing = groups.get(key) ?? [];
    existing.push(rule);
    groups.set(key, existing);
  }

  const divergent: { subject: string; literal: number | string; variants: BusinessRule[] }[] = [];
  for (const group of groups.values()) {
    const operators = new Set(group.map((rule) => rule.operator));
    const roots = new Set(group.map((rule) => rule.rootName));
    if (operators.size < 2 || roots.size < 2) continue;

    // Only a disagreement about the boundary. `status == 4` here and
    // `status != 4` there are two ordinary rules about one value, not a
    // contradiction; `hours >= 40` against `hours > 40` is one rule that
    // sends exactly 40 two different ways.
    if (!sameDirectionBoundary(operators)) continue;

    // One representative per spelling, so the finding shows the disagreement
    // rather than every site of it.
    const seen = new Set<string>();
    const variants = group.filter((rule) => {
      const key = `${rule.rootName}|${rule.operator}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    divergent.push({ subject: group[0]!.subject, literal: group[0]!.literal, variants });
  }

  return divergent.sort((a, b) => a.subject.localeCompare(b.subject));
}

export function computeLogicFindings(
  input: LogicInput,
  limits: LogicLimits = DEFAULT_LOGIC_LIMITS,
): readonly FeatureFinding[] {
  const base = { featureId: input.featureId, featureName: input.featureName };
  const findings: FeatureFinding[] = [];

  const ownSubjects = new Set(input.rules.map(subjectKey));
  const divergent = findDivergence(input.allRules).filter((entry) =>
    ownSubjects.has(entry.subject.split(".").pop()!.toLowerCase()),
  );

  for (const entry of divergent.slice(0, limits.maxNamed)) {
    const spellings = entry.variants
      .map((rule) => `${rule.statement} (${rule.rootName})`)
      .join("; ");
    findings.push({
      ...base,
      id: "rule-applied-two-ways",
      title: "One rule, applied two ways",
      finding: `The same value is compared differently in different parts: ${spellings}. A value of exactly ${entry.literal} takes a different path depending on which part handles it. The two are named ${[
        ...new Set(entry.variants.map((rule) => rule.subject)),
      ].join(" and ")}, so check they mean the same thing.`,
      severity: "concern",
      evidence: entry.variants.map((rule) => `${rule.rootName}/${rule.relPath}:${rule.startLine} — ${rule.text}`),
    });
  }

  // A number where the project has a name for it.
  const unexplained = input.rules.filter(
    (rule) => isUnexplained(rule) && typeof rule.literal === "number",
  );
  const named = input.rules.filter((rule) => !isUnexplained(rule));
  if (unexplained.length > 0 && named.length > 0) {
    findings.push({
      ...base,
      id: "values-with-no-declared-meaning",
      title: "Rules stated as bare numbers",
      finding: `${unexplained.length} of ${input.rules.length} rules in ${input.featureName} compare against a number the project declares no name for, while ${named.length} others use values it does name. A bare number is how two parts come to disagree about the same rule.`,
      severity: "notice",
      evidence: unexplained
        .slice(0, limits.maxNamed)
        .map((rule) => `${rule.relPath}:${rule.startLine} — ${rule.text}`),
    });
  }

  // The same threshold restated in many places.
  const repeated = new Map<string, BusinessRule[]>();
  for (const rule of input.rules) {
    const key = `${subjectKey(rule)}|${rule.operator}|${rule.literal}`;
    const existing = repeated.get(key) ?? [];
    existing.push(rule);
    repeated.set(key, existing);
  }
  const spread = [...repeated.values()]
    // Numbers only: a repeated string test is ordinary branching, while a
    // repeated number is a rule with no single place to change it.
    .filter((group) => typeof group[0]!.literal === "number")
    .filter((group) => group.length >= limits.repetitionThreshold)
    .sort((a, b) => b.length - a.length);

  if (spread.length > 0) {
    const worst = spread[0]!;
    findings.push({
      ...base,
      id: "rules-restated-in-many-places",
      title: "One rule written out in several places",
      finding: `${spread.length} rules in ${input.featureName} are written out in three or more places rather than stated once — "${worst[0]!.statement}" appears in ${worst.length}. Changing such a rule means finding every copy.`,
      severity: "notice",
      evidence: worst
        .slice(0, limits.maxNamed)
        .map((rule) => `${rule.rootName}/${rule.relPath}:${rule.startLine}`),
    });
  }

  if (input.discarded.length > 0) {
    findings.push({
      ...base,
      id: "failures-nobody-can-observe",
      title: "Calls whose failure is not observable",
      finding: `${input.discarded.length} calls in ${input.featureName} are dispatched without keeping what they return, so if they fail nothing records it.`,
      severity: "notice",
      evidence: input.discarded
        .slice(0, limits.maxNamed)
        .map((record) => `${record.rootName}/${record.source.relPath}:${record.source.startLine} — ${record.call.slice(0, 80)}`),
    });
  }

  const rank: Record<Severity, number> = { concern: 0, notice: 1, info: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
