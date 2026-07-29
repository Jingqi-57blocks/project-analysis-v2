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

/**
 * Truncation, tracked per decision rather than per file.
 *
 * Shared across a file, one 40-case switch marked every other decision beside
 * it as partial — including complete ones, which is a disclaimer on a fact
 * that did not need it.
 */
interface Bounds {
  truncated: boolean;
}

function freshBounds(): Bounds {
  return { truncated: false };
}

function text(node: SgNode | undefined | null): string {
  return (node?.text() ?? "").replaceAll(/\s+/g, " ").trim();
}

/** `(u.role === "admin")` is the same test as `u.role === "admin"`. */
function unwrap(test: string): string {
  return test.replace(/^\((.*)\)$/s, "$1").trim();
}

function startLine(node: SgNode): number {
  return node.range().start.line + 1;
}

function endLine(node: SgNode): number {
  return node.range().end.line + 1;
}

/** Leaving the function. `break` leaves a switch, which is not the same thing. */
const EXIT_KINDS = new Set(["return_statement", "throw_statement"]);

/**
 * The statements a body runs.
 *
 * Go wraps a block's contents in a `statement_list`; the script grammars do
 * not. Only that one wrapper is unwrapped — following any nested block would
 * abandon everything beside it, which hid returns and whole nested decisions.
 */
function statementsOf(node: SgNode): readonly SgNode[] {
  const inner = node.children().find((child) => (child.kind() as string) === "statement_list");
  return inner === undefined ? node.children() : inner.children();
}

/**
 * Whether taking this branch leaves the function.
 *
 * Only the branch's own statements count — a return inside a closure declared
 * here belongs to the closure. `break` counts for a switch case: it leaves the
 * decision, which is what a reader cares about.
 */
function leavesOn(body: SgNode): boolean {
  // `if (!ok) return;` has no block: the body node is the return itself, and
  // asking after its children finds `return`, the expression and a semicolon.
  if (EXIT_KINDS.has(body.kind() as string)) return true;
  return statementsOf(body).some((statement) => EXIT_KINDS.has(statement.kind() as string));
}

const COMPARISONS = new Set(["==", "!=", "===", "!==", ">", "<", ">=", "<="]);
const JOINS = new Set(["&&", "||"]);
const CALL_KINDS = new Set(["call_expression", "call"]);
const QUALIFIED_KINDS = new Set(["selector_expression", "member_expression"]);

/**
 * Literal values a test compares against, for naming through a value set.
 *
 * Only what is being compared *against* — the side being tested is the
 * subject, and a call is not a value at all: neither its name nor what it is
 * handed. Reading both sides of every expression turned `isValid(lv.Owner,
 * threshold)` into three values, none of which anything can explain.
 */
function literalsIn(node: SgNode | undefined | null): (string | number)[] {
  if (node === undefined || node === null) return [];
  const found: (string | number)[] = [];

  const walk = (current: SgNode): void => {
    const kind = current.kind() as string;
    if (CALL_KINDS.has(kind)) return;

    if (kind === "binary_expression") {
      const operator = text(current.field("operator"));
      if (COMPARISONS.has(operator)) {
        const right = current.field("right");
        if (right !== undefined && right !== null) walk(right);
        return;
      }
      if (JOINS.has(operator)) {
        for (const child of current.children()) walk(child);
        return;
      }
    }

    // A literal is one value. Descending into it found the same text again as
    // the fragment inside the quotes, so every string was recorded twice.
    if (kind.includes("number") || kind === "int_literal" || kind === "float_literal") {
      const value = Number(current.text());
      if (Number.isFinite(value)) found.push(value);
      return;
    }
    if (kind.includes("string")) {
      const raw = current.text().replace(/^["'`]/, "").replace(/["'`]$/, "");
      if (raw !== "") found.push(raw);
      return;
    }
    if (QUALIFIED_KINDS.has(kind)) {
      // `constant.L1FlowF` is one name, not `constant` and `L1FlowF`.
      found.push(text(current));
      return;
    }
    if (kind === "identifier" || kind === "type_identifier") {
      // A named constant is the value a value set explains — `BTO`, not 1.
      found.push(current.text());
      return;
    }

    for (const child of current.children()) walk(child);
  };

  walk(node);
  return [...new Set(found)];
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
    decisions: depth >= MAX_DEPTH ? markTruncated(bounds) : decisionsWithin(body, depth + 1),
  };
}

function markTruncated(bounds: Bounds): readonly DecisionRecord[] {
  bounds.truncated = true;
  return [];
}

/**
 * What a branch tests, including where its subject came from.
 *
 * Go allows `if v, ok := lookup(id); ok`, and the condition alone is `ok` —
 * a branch labelled with a name the reader has never seen. Keeping the
 * statement that bound it says what is actually being asked.
 */
function testOf(node: SgNode, condition: SgNode | undefined | null): string {
  const test = unwrap(text(condition));
  const initializer = text(node.field("initializer"));
  return initializer === "" ? test : `${initializer}; ${test}`;
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
      branchFrom(testOf(current, condition), literalsIn(condition), consequence, depth, bounds),
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
    // A Go type switch names its cases with `type`; everything else uses
    // `value`. Read only the latter, every branch of a type switch said
    // nothing about what distinguished it.
    const value = entry.field("value") ?? entry.field("type");
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
function decisionsWithin(body: SgNode, depth: number): DecisionRecord[] {
  const found: DecisionRecord[] = [];

  const visit = (node: SgNode): void => {
    const kind = node.kind() as string;

    // Its own bounds: a wide switch elsewhere in the file says nothing about
    // whether this tree is complete.
    if (kind === "if_statement") {
      const bounds = freshBounds();
      found.push(shell(node, "if", fromIf(node, depth, bounds), bounds));
      return;
    }
    if (SWITCH_KINDS.has(kind)) {
      const bounds = freshBounds();
      found.push(shell(node, "switch", fromSwitch(node, depth, bounds), bounds));
      return;
    }
    for (const child of node.children()) visit(child);
  };

  for (const statement of statementsOf(body)) visit(statement);
  return found;
}

/** The record without its root-specific fields, filled in by the caller. */
function shell(
  node: SgNode,
  kind: "if" | "switch",
  branches: readonly DecisionBranch[],
  bounds: Bounds,
): DecisionRecord {
  const column = node.range().start.column + 1;
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
    source: { rootName: "", relPath: "", startLine: startLine(node), endLine: endLine(node), startColumn: column, endColumn: null },
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
  // Every branch that tests something must agree. A branch whose test cannot
  // be read — a call, a compound expression — is not agreement, and treating
  // it as such titled decisions after a minority of their branches.
  const tested = branches.filter((branch) => branch.test !== "otherwise");
  if (tested.length === 0) return "";

  const subjects = tested.map(
    (branch) => /^([A-Za-z_][\w.]*)\s*(?:[=!<>]=?|>|<)\s*\S/.exec(branch.test)?.[1] ?? null,
  );
  if (subjects.some((subject) => subject === null)) return "";
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

  const found = decisionsWithin(parsed.root, 0);

  const place = (record: DecisionRecord): DecisionRecord => ({
    ...record,
    rootName,
    source: { ...record.source, rootName, relPath },
    provenance: declared({ ...record.source, rootName, relPath }),
    branches: record.branches.map((branch) => ({
      ...branch,
      decisions: branch.decisions.map(place),
    })),
  });

  // A decision with one branch and nothing in it is a guard, which the
  // condition records already cover better.
  return found.map(place).filter((record) => record.branches.length > 1);
}
