/**
 * The shape a decision makes, rather than the comparisons inside it.
 *
 * `lv.Type == BTO`, `== PTO`, `== UTO` recorded one at a time are three
 * unrelated facts. They are one decision with three branches, and only the
 * tree says what the system actually decides — which is what a reader who
 * did not write the code needs, and what a diagram is drawn from.
 *
 * A branch records where it is, not what it does. Tables and calls already
 * have readers of their own with their own locations, so effects are joined
 * by line range later; detecting them again here would be a second opinion
 * that can disagree with the first.
 */

import type { SgNode } from "@ast-grep/napi";

import { languageOf, parseSource, type ParsedLanguage } from "../../text/ast.js";
import { enclosingFunctionName } from "../../text/ast.js";
import { declared, lineRef } from "../../structural/provenance.js";
import type { DecisionRecord, DecisionBranch } from "../../structural/rules.js";

/**
 * Bounds, so pathological nesting degrades honestly.
 *
 * Machine-generated code with fifty nested conditions must not produce fifty
 * levels silently, and must not silently produce six. Hitting either bound is
 * recorded on the record.
 */
export const MAX_DEPTH = 6;
export const MAX_BRANCHES = 32;

interface Bounds {
  truncated: boolean;
}

function text(node: SgNode | undefined | null): string {
  return (node?.text() ?? "").replaceAll(/\s+/g, " ").trim();
}

function startLine(node: SgNode): number {
  return node.range().start.line + 1;
}

function endLine(node: SgNode): number {
  return node.range().end.line + 1;
}

const EXIT_KINDS = new Set(["return_statement", "throw_statement", "break_statement"]);
const WRAPPERS = new Set(["statement_list", "statement_block", "block"]);

/** The statements a body runs, whichever level its grammar puts them at. */
function statementsOf(node: SgNode): readonly SgNode[] {
  const children = node.children();
  const wrapper = children.find((child) => WRAPPERS.has(child.kind() as string));
  return wrapper === undefined ? children : statementsOf(wrapper);
}

/**
 * Whether taking this branch leaves the function.
 *
 * Only the branch's own statements count — a return inside a closure declared
 * here belongs to the closure. `break` counts for a switch case: it leaves the
 * decision, which is what a reader cares about.
 */
function leavesOn(body: SgNode): boolean {
  return statementsOf(body).some((statement) => EXIT_KINDS.has(statement.kind() as string));
}

/** Literal values a test compares against, for naming through a value set. */
function literalsIn(node: SgNode | undefined | null): (string | number)[] {
  if (node === undefined || node === null) return [];
  const found: (string | number)[] = [];
  const walk = (current: SgNode): void => {
    const kind = current.kind() as string;
    if (kind.includes("number") || kind === "int_literal" || kind === "float_literal") {
      const value = Number(current.text());
      if (Number.isFinite(value)) found.push(value);
    } else if (kind.includes("string")) {
      const raw = current.text().replace(/^["'`]/, "").replace(/["'`]$/, "");
      if (raw !== "") found.push(raw);
    } else if (kind === "identifier" || kind === "type_identifier") {
      // A named constant is the value a value set explains — `BTO`, not 1.
      found.push(current.text());
    }
    for (const child of current.children()) walk(child);
  };
  walk(node);
  return found;
}

function branchFrom(
  test: string,
  values: readonly (string | number)[],
  body: SgNode,
  depth: number,
  bounds: Bounds,
): DecisionBranch {
  return {
    test,
    values,
    outcome: leavesOn(body) ? "leaves" : "continues",
    startLine: startLine(body),
    endLine: endLine(body),
    decisions: depth >= MAX_DEPTH ? markTruncated(bounds) : decisionsWithin(body, depth + 1, bounds),
  };
}

function markTruncated(bounds: Bounds): readonly DecisionRecord[] {
  bounds.truncated = true;
  return [];
}

/** An `if / else if / else` chain, read as one decision rather than as many. */
function fromIf(node: SgNode, depth: number, bounds: Bounds): DecisionBranch[] {
  const branches: DecisionBranch[] = [];
  let current: SgNode | null = node;

  while (current !== null) {
    const kind = current.kind() as string;
    if (kind !== "if_statement") {
      // A trailing `else` body: the branch taken when nothing above matched,
      // and usually the one that matters most.
      branches.push(branchFrom("otherwise", [], current, depth, bounds));
      break;
    }

    const condition = current.field("condition");
    const consequence = current.field("consequence");
    if (consequence === undefined || consequence === null) break;

    branches.push(
      branchFrom(text(condition), literalsIn(condition), consequence, depth, bounds),
    );
    if (branches.length >= MAX_BRANCHES) {
      bounds.truncated = true;
      break;
    }

    const alternative: SgNode | null = current.field("alternative") ?? null;
    if (alternative === null) break;
    // TypeScript wraps the else in an `else_clause`; Go does not.
    current =
      (alternative.kind() as string) === "else_clause"
        ? (alternative.children().find((child: SgNode) => (child.kind() as string) !== "else") ??
          null)
        : alternative;
  }

  return branches;
}

const CASE_KINDS = new Set(["expression_case", "switch_case", "type_case"]);
const DEFAULT_KINDS = new Set(["default_case", "switch_default"]);

/** A `switch`, which a reader cannot tell from an `if` chain and should not have to. */
function fromSwitch(node: SgNode, depth: number, bounds: Bounds): DecisionBranch[] {
  const branches: DecisionBranch[] = [];
  const body = node.field("body") ?? node;

  const cases = body.children().filter((child) => {
    const kind = child.kind() as string;
    return CASE_KINDS.has(kind) || DEFAULT_KINDS.has(kind);
  });

  for (const entry of cases) {
    if (branches.length >= MAX_BRANCHES) {
      bounds.truncated = true;
      break;
    }
    const kind = entry.kind() as string;
    const value = entry.field("value");
    branches.push(
      DEFAULT_KINDS.has(kind)
        ? branchFrom("otherwise", [], entry, depth, bounds)
        // Unquoted: Go writes `case BTO`, TypeScript `case "BTO"`, and a
        // reader is being told the same thing either way.
        : branchFrom(
            text(value).replace(/^["'`](.*)["'`]$/, "$1"),
            literalsIn(value),
            entry,
            depth,
            bounds,
          ),
    );
  }

  return branches;
}

const SWITCH_KINDS = new Set([
  "expression_switch_statement",
  "type_switch_statement",
  "switch_statement",
]);

/** Decisions declared directly inside a body, not those nested in its branches. */
function decisionsWithin(body: SgNode, depth: number, bounds: Bounds): DecisionRecord[] {
  const found: DecisionRecord[] = [];

  const visit = (node: SgNode, insideBranch: boolean): void => {
    const kind = node.kind() as string;

    if (kind === "if_statement" && !insideBranch) {
      found.push(shell(node, "if", fromIf(node, depth, bounds), bounds));
      return;
    }
    if (SWITCH_KINDS.has(kind) && !insideBranch) {
      found.push(shell(node, "switch", fromSwitch(node, depth, bounds), bounds));
      return;
    }
    for (const child of node.children()) visit(child, false);
  };

  for (const statement of statementsOf(body)) visit(statement, false);
  return found;
}

/** The record without its root-specific fields, filled in by the caller. */
function shell(
  node: SgNode,
  kind: "if" | "switch",
  branches: readonly DecisionBranch[],
  bounds: Bounds,
): DecisionRecord {
  const subject =
    kind === "switch"
      ? text(node.field("value")).replace(/^\((.*)\)$/, "$1")
      : commonSubject(branches);

  return {
    rootName: "",
    kind,
    subject,
    enclosingFunction: enclosingFunctionName(node),
    branches,
    startLine: startLine(node),
    endLine: endLine(node),
    truncated: bounds.truncated,
    source: lineRef("", "", startLine(node)),
    provenance: declared(lineRef("", "", startLine(node))),
  };
}

/**
 * What an if-chain is deciding about, when its branches agree.
 *
 * `lv.Hours > 16` and `lv.Hours > 8` are both about `lv.Hours`; naming that
 * is the difference between "a decision" and "a decision about leave hours".
 * Where the branches test different things there is no single subject, and
 * saying so is better than picking the first.
 */
function commonSubject(branches: readonly DecisionBranch[]): string {
  const subjects = branches
    .map((branch) => /^([A-Za-z_][\w.]*)\s*(?:[=!<>]=?|>|<)/.exec(branch.test)?.[1])
    .filter((subject): subject is string => subject !== undefined);

  if (subjects.length === 0) return "";
  return subjects.every((subject) => subject === subjects[0]) ? subjects[0]! : "";
}

/** Every decision in a file, as trees. */
export function decisionsIn(
  rootName: string,
  relPath: string,
  content: string,
): readonly DecisionRecord[] {
  const language: ParsedLanguage | null = languageOf(relPath);
  if (language === null) return [];

  const parsed = parseSource(language, content);
  if (parsed.root === null) return [];

  const bounds: Bounds = { truncated: false };
  const found = decisionsWithin(parsed.root, 0, bounds);

  const place = (record: DecisionRecord): DecisionRecord => ({
    ...record,
    rootName,
    truncated: bounds.truncated,
    source: lineRef(rootName, relPath, record.startLine),
    provenance: declared(lineRef(rootName, relPath, record.startLine)),
    branches: record.branches.map((branch) => ({
      ...branch,
      decisions: branch.decisions.map(place),
    })),
  });

  // A decision with one branch and nothing in it is a guard, which the
  // condition records already cover better.
  return found.map(place).filter((record) => record.branches.length > 1);
}
