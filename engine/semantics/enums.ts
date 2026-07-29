/**
 * The named value sets a project declares.
 *
 * A condition like `status > 3` says nothing on its own — the number is only
 * meaningful if you know what 3 stands for. Projects almost always say: a Go
 * const block, a TypeScript enum, a plain object of constants. Reading those
 * turns `status IN (4, 6)` into "status is approved or completed", which is
 * the difference between a rule a reader can judge and a fragment of code.
 *
 * Nothing here knows any domain: a value set is any named group of constants,
 * whatever the project calls it.
 */

import type { SgNode } from "@ast-grep/napi";

import { languageOf, parseSource, type ParsedLanguage } from "../text/ast.js";

export interface ValueSetMember {
  readonly name: string;
  /** Numbers and strings only — a computed constant is not a stable label. */
  readonly value: number | string;
}

export interface ValueSet {
  /** As the project wrote it: `LvStatusC`, `LeaveRequestStatus`. */
  readonly name: string;
  readonly rootName: string;
  readonly relPath: string;
  readonly startLine: number;
  readonly members: readonly ValueSetMember[];
}

/** Splits an identifier into lowercase word tokens, whatever convention it uses. */
export function nameTokens(text: string): string[] {
  return text
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 1);
}

function numericOrString(text: string): number | string | null {
  const trimmed = text.trim();
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  const quoted = /^(['"`])([^]*)\1$/.exec(trimmed);
  return quoted ? quoted[2]! : null;
}

/**
 * Go `const` blocks, including the iota form.
 *
 * `LvDraftC LvStatusC = iota + 1` numbers the block from its offset, which is
 * how a Go project usually spells an enum — reading only explicit values would
 * miss most of them. The set is named after the type when the block declares
 * one, since that is what a field will be compared against.
 */
function goValueSets(root: SgNode, rootName: string, relPath: string): ValueSet[] {
  const sets: ValueSet[] = [];

  let declarations: SgNode[];
  try {
    declarations = root.findAll({ rule: { kind: "const_declaration" as never } });
  } catch {
    return sets;
  }

  for (const declaration of declarations) {
    const members: ValueSetMember[] = [];
    let typeName: string | null = null;
    let iotaBase: number | null = null;
    let index = 0;

    for (const spec of declaration.children()) {
      if ((spec.kind() as string) !== "const_spec") continue;

      const name = spec.field("name")?.text() ?? spec.children()[0]?.text() ?? "";
      if (name === "" || !/^[A-Za-z_]\w*$/.test(name)) continue;

      const declaredType = spec.field("type")?.text();
      if (declaredType !== undefined && typeName === null) typeName = declaredType;

      const valueNode = spec.field("value");
      const valueText = valueNode?.text() ?? "";

      if (valueText.includes("iota")) {
        const offset = /iota\s*([+-])\s*(\d+)/.exec(valueText);
        iotaBase =
          offset === null ? 0 : offset[1] === "+" ? Number(offset[2]) : -Number(offset[2]);
        index = 0;
        members.push({ name, value: iotaBase });
        index += 1;
        continue;
      }

      if (valueText === "" && iotaBase !== null) {
        // A bare name inside an iota block continues the sequence.
        members.push({ name, value: iotaBase + index });
        index += 1;
        continue;
      }

      const value = numericOrString(valueText);
      if (value !== null) members.push({ name, value });
    }

    if (members.length < 2) continue;
    sets.push({
      name: typeName ?? members[0]!.name,
      rootName,
      relPath,
      startLine: declaration.range().start.line + 1,
      members,
    });
  }

  return sets;
}

const FUNCTION_KINDS = new Set<string>([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "generator_function_declaration",
]);

/** True when nothing between this node and the file is a function body. */
function isModuleLevel(node: SgNode): boolean {
  let current: SgNode | null = node.parent();
  while (current !== null) {
    if (FUNCTION_KINDS.has(current.kind() as string)) return false;
    current = current.parent();
  }
  return true;
}

/** TypeScript `enum X { A = 1 }` and const objects of primitives. */
function scriptValueSets(root: SgNode, rootName: string, relPath: string): ValueSet[] {
  const sets: ValueSet[] = [];

  const collect = (kind: string, nameOf: (node: SgNode) => string | undefined, bodyOf: (node: SgNode) => SgNode | undefined) => {
    let nodes: SgNode[];
    try {
      nodes = root.findAll({ rule: { kind: kind as never } });
    } catch {
      return;
    }

    for (const node of nodes) {
      const name = nameOf(node);
      const body = bodyOf(node);
      if (name === undefined || body === undefined) continue;

      const members: ValueSetMember[] = [];
      let index = 0;
      for (const child of body.children()) {
        const childKind = child.kind() as string;
        if (childKind === "pair" || childKind === "property_signature") {
          const key = (child.field("key")?.text() ?? "").replaceAll(/['"]/g, "");
          const value = numericOrString(child.field("value")?.text() ?? "");
          if (key !== "" && value !== null) members.push({ name: key, value });
          continue;
        }
        // TypeScript numbers an uninitialized member as the previous value
        // plus one, not as its position. `enum S { A = 1, B }` is 1 and 2;
        // counting positions gives 1 and 1, so two states share a number and
        // everything after an initializer is off by one.
        if (childKind === "enum_assignment") {
          const key = child.field("name")?.text() ?? "";
          const value = numericOrString(child.field("value")?.text() ?? "");
          if (key !== "") {
            const resolvedValue = value ?? index;
            members.push({ name: key, value: resolvedValue });
            if (typeof resolvedValue === "number") index = resolvedValue + 1;
            else index += 1;
          }
          continue;
        }
        if (childKind === "property_identifier" || childKind === "identifier") {
          members.push({ name: child.text(), value: index });
          index += 1;
        }
      }

      if (members.length < 2) continue;
      sets.push({
        name,
        rootName,
        relPath,
        startLine: node.range().start.line + 1,
        members,
      });
    }
  };

  collect(
    "enum_declaration",
    (node) => node.field("name")?.text(),
    (node) => node.field("body") ?? node.children().find((c) => (c.kind() as string) === "enum_body"),
  );

  // `const Status = { approved: 4, ... }` at module level only. A object
  // built inside a function is a local — `const firstRow = { total: 0,
  // isFirstLine: 1 }` inside a callback is not a vocabulary, and treating it
  // as one names unrelated numbers after its keys.
  collect(
    "variable_declarator",
    (node) => node.field("name")?.text(),
    (node) => {
      if (!isModuleLevel(node)) return undefined;
      const value = node.field("value");
      return value !== undefined && value !== null && (value.kind() as string) === "object"
        ? value
        : undefined;
    },
  );

  return sets;
}

export function valueSetsIn(
  rootName: string,
  relPath: string,
  content: string,
): readonly ValueSet[] {
  const language: ParsedLanguage | null = languageOf(relPath);
  if (language === null) return [];

  const parsed = parseSource(language, content);
  if (parsed.root === null) return [];

  return language === "go"
    ? goValueSets(parsed.root, rootName, relPath)
    : scriptValueSets(parsed.root, rootName, relPath);
}

/** The field a subject names, which is its last word: `lv.Status` → "status". */
function fieldToken(subject: string): string | null {
  const tokens = nameTokens(subject.split(".").pop() ?? subject);
  return tokens[tokens.length - 1] ?? null;
}

/**
 * The value set a subject most likely refers to.
 *
 * Matched on shared name tokens — `lv.Status` against `LvStatusC` — because a
 * project names the type after the thing it types. Requires the set's name to
 * share a token with the subject and to actually contain the value, so a
 * coincidental token match on a set that cannot explain the number is refused.
 */
/**
 * How well a set's name agrees with a subject.
 *
 * One shared word is not agreement when that word is a classifier every
 * vocabulary uses. `returnCount` and `CountTimeType` share "count"; naming a
 * loop counter "regular" from a set about how leave time is counted is a
 * fabrication, and it was published. Two shared words, or one that is not a
 * classifier, is the bar.
 */
const CLASSIFIER_WORDS = new Set([
  "count",
  "type",
  "types",
  "kind",
  "code",
  "codes",
  "row",
  "rows",
  "value",
  "values",
  "flag",
  "flags",
  "num",
  "number",
  "id",
  "key",
  "name",
  "item",
  "items",
  "data",
  "info",
  "state",
]);

function agreementScore(subject: string, setName: string, field: string): number | null {
  const subjectTokens = new Set(nameTokens(subject));
  const setTokens = nameTokens(setName);
  if (!setTokens.includes(field)) return null;

  const shared = setTokens.filter((token) => subjectTokens.has(token));
  if (shared.length < 2 && CLASSIFIER_WORDS.has(field)) return null;

  return shared.length * 100 - (setTokens.length - shared.length) * 25;
}

export function resolveValue(
  subject: string,
  value: number | string,
  sets: readonly ValueSet[],
  /** Prefer a vocabulary the same part declares over a stranger's. */
  preferRoot: string | null = null,
): { set: ValueSet; member: ValueSetMember } | null {
  const field = fieldToken(subject);
  if (field === null) return null;

  let best: { set: ValueSet; member: ValueSetMember; score: number } | null = null;

  for (const set of sets) {
    const member = set.members.find((candidate) => candidate.value === value);
    if (member === undefined) continue;

    const agreement = agreementScore(subject, set.name, field);
    if (agreement === null) continue;

    const sameRoot = preferRoot !== null && set.rootName === preferRoot;
    // A vocabulary from another part cannot name a value whose field is
    // classifier-shaped: 200 is an HTTP status everywhere, and another
    // service's constant that happens to equal it explains nothing.
    if (!sameRoot && preferRoot !== null && CLASSIFIER_WORDS.has(field)) continue;

    const score = agreement + (sameRoot ? 1000 : 0) - set.members.length;
    if (best === null || score > best.score) best = { set, member, score };
  }

  return best === null ? null : { set: best.set, member: best.member };
}

/**
 * The one set a subject most likely refers to, for wording a range.
 *
 * Every set sharing a token would mix two vocabularies — an order's statuses
 * and a payment's both answer to "status", and a range worded from both names
 * values the field can never hold.
 */
export function bestSetFor(
  subject: string,
  sets: readonly ValueSet[],
  preferRoot: string | null = null,
): ValueSet | null {
  const field = fieldToken(subject);
  if (field === null) return null;

  let best: { set: ValueSet; score: number } | null = null;
  for (const set of sets) {
    const agreement = agreementScore(subject, set.name, field);
    if (agreement === null) continue;

    const sameRoot = preferRoot !== null && set.rootName === preferRoot;
    if (!sameRoot && preferRoot !== null && CLASSIFIER_WORDS.has(field)) continue;

    const score = agreement + (sameRoot ? 1000 : 0) - set.members.length;
    if (best === null || score > best.score) best = { set, score };
  }
  return best === null ? null : best.set;
}
