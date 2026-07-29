/**
 * Conditions, stated as rules a reader can judge.
 *
 * `status > 3` is not a rule — it is a fragment. The rule is what those
 * numbers stand for, and the project has already said: a const block, an enum,
 * an object of constants. Resolving the value against what the project
 * declares is the difference between a line of code and a sentence about the
 * product.
 *
 * Where nothing explains a value, the condition is shown as written and marked
 * unexplained — which is itself worth knowing, since a bare number in a rule
 * is how two services come to disagree about it.
 */

import { bestSetFor, resolveValue, type ValueSet } from "./enums.js";
import type { ConditionRecord } from "../structural/rules.js";

export interface BusinessRule {
  readonly rootName: string;
  readonly subject: string;
  readonly operator: string;
  readonly literal: number | string;
  /** The rule in words: "status is approved". */
  readonly statement: string;
  /** The names this value carries, where the project declares any. */
  readonly meanings: readonly string[];
  /** The value set that explained it, for a reader who wants the source. */
  readonly valueSetName: string | null;
  readonly relPath: string;
  readonly startLine: number;
  readonly text: string;
}

/**
 * A declared constant as words: `LvWaitingHRApproveC` → "waiting hr approve".
 *
 * Leading tokens the set name already carries are dropped, so `OrderDraftC`
 * in `OrderStatusC` reads "draft" rather than "order draft" — the subject has
 * already said which thing's status this is. Generic: the tokens come from the
 * project's own two names, not from a list.
 */
export function readableMember(name: string, setName = ""): string {
  const words = name
    .replace(/C$/, "")
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");

  const setTokens = new Set(
    setName
      .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replaceAll(/[_-]+/g, " ")
      .toLowerCase()
      .split(/\s+/),
  );

  let start = 0;
  while (start < words.length - 1 && setTokens.has(words[start]!)) start += 1;

  return words.slice(start).join(" ");
}

/** `lv.Status` → "status"; the field, not the variable holding it. */
function readableSubject(subject: string): string {
  const last = subject.split(".").pop() ?? subject;
  return last.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll(/[_-]+/g, " ").toLowerCase();
}

const COMPARATIVE: Record<string, string> = {
  "==": "is",
  "===": "is",
  "!=": "is not",
  "!==": "is not",
  "<>": "is not",
  ">": "is more than",
  ">=": "is at least",
  "<": "is less than",
  "<=": "is at most",
};

/**
 * States one condition as a rule.
 *
 * An ordered comparison against a named value is worded by the values it
 * admits rather than by the number — "status is past approved" tells a reader
 * nothing about which states those are, while naming them does.
 */
export function stateRule(
  condition: ConditionRecord,
  sets: readonly ValueSet[],
): BusinessRule {
  const subject = readableSubject(condition.subject);
  const comparative = COMPARATIVE[condition.operator] ?? condition.operator;

  const exact = resolveValue(condition.subject, condition.literal, sets);
  const set = exact?.set ?? bestSetFor(condition.subject, sets);

  const ordered = [">", ">=", "<", "<="].includes(condition.operator);
  const meanings: string[] = [];
  let statement: string;

  if (ordered && set !== null && typeof condition.literal === "number") {
    const admitted = set.members
      .filter((member) => typeof member.value === "number" && matches(condition.operator, member.value, condition.literal as number))
      .map((member) => readableMember(member.name, set.name));

    if (admitted.length > 0 && admitted.length < set.members.length) {
      meanings.push(...admitted);
      statement = `${subject} is ${admitted.join(" or ")}`;
    } else {
      statement = `${subject} ${comparative} ${condition.literal}`;
    }
  } else if (exact !== null) {
    const name = readableMember(exact.member.name, exact.set.name);
    meanings.push(name);
    statement = `${subject} ${comparative} ${name}`;
  } else {
    statement = `${subject} ${comparative} ${
      condition.literalKind === "string" ? `"${condition.literal}"` : condition.literal
    }`;
  }

  return {
    rootName: condition.rootName,
    subject: condition.subject,
    operator: condition.operator,
    literal: condition.literal,
    statement,
    meanings,
    valueSetName: meanings.length > 0 ? (exact?.set.name ?? set?.name ?? null) : null,
    relPath: condition.source.relPath,
    startLine: condition.source.startLine ?? 0,
    text: condition.text,
  };
}

function matches(operator: string, value: number, literal: number): boolean {
  switch (operator) {
    case ">":
      return value > literal;
    case ">=":
      return value >= literal;
    case "<":
      return value < literal;
    case "<=":
      return value <= literal;
    default:
      return false;
  }
}

/** True when nothing the project declares explains this rule's value. */
export function isUnexplained(rule: BusinessRule): boolean {
  return rule.meanings.length === 0;
}
