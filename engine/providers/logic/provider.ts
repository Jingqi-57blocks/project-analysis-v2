/**
 * Reads the conditions a codebase writes against literal values.
 *
 * `hours > 16`, `status != 8`, `type == "sick"` — a threshold or a state test
 * with the value spelled out. These are the project's business rules as the
 * code actually states them, and they are the only place many rules are
 * written down at all. Reported verbatim; what a value *means* is resolved
 * later against the value sets the project declares, because guessing here
 * would bake the guess into the record.
 *
 * Also reads calls whose failure nobody can observe — a goroutine dispatched
 * without capturing its error, a promise nobody awaits. Distinct from missing
 * error handling: the result was discarded at the call site, so no handling
 * further up is possible either.
 *
 * Nothing here knows any domain. A condition is a comparison; a rule is
 * whatever the project compares.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SgNode } from "@ast-grep/napi";

import { logicCapabilities } from "./capabilities.js";
import {
  EXIT_KINDS,
  PLUMBING_TEST,
  errorCodeName,
  firstMessage,
} from "./messages.js";

import { enclosingFunctionName, languageOf, parseSource } from "../../text/ast.js";
import { inferred, resolved } from "../../structural/provenance.js";
import { emptyRecords } from "../../structural/kinds.js";
import type {
  ConditionRecord,
  DecisionRecord,
  DiscardedErrorRecord,
  GuardRecord,
} from "../../structural/rules.js";
import { decisionsIn } from "./decisions.js";
import {
  declaredKinds,
  type ExtractionFailure,
  type StructuralContribution,
  type StructuralProvider,
  type StructuralRootInput,
} from "../../structural/provider.js";
import type { PreflightResult } from "../types.js";

export const PROVIDER_ID = "logic";
export const PROVIDER_VERSION = "1.0.0";

const COMPARISONS = new Set(["<", "<=", ">", ">=", "==", "!=", "===", "!==", "<>"]);

/**
 * Subjects that are counters rather than domain values.
 *
 * A loop bound and a retry budget are comparisons too, and reporting them as
 * business rules would bury the rules that matter. Judged by shape, not by a
 * vocabulary: a one- or two-letter name is an index, and a comparison against
 * a length is a bounds check whatever it is called.
 */
function isIterationSubject(subject: string, other: string): boolean {
  const last = subject.split(".").pop() ?? subject;
  if (last.length <= 2) return true;
  if (
    /^(idx|index|count|cnt|size|len|length|offset|cursor|page|limit|retry|retries|attempt|attempts)$/i.test(
      last,
    )
  ) {
    return true;
  }
  return /\b(len|length|size|count)\b|\.length\b|\.size\b/i.test(other);
}

function literalOf(text: string): { value: number | string; kind: "numeric" | "string" } | null {
  const trimmed = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return { value: Number(trimmed), kind: "numeric" };
  const quoted = /^(['"`])([^]*)\1$/.exec(trimmed);
  if (quoted !== null && !quoted[2]!.includes("${")) {
    return { value: quoted[2]!, kind: "string" };
  }
  return null;
}

/** A subject worth recording: a named thing, not a call or an expression. */
function isPlainSubject(text: string): boolean {
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(text.trim());
}

function conditionsIn(
  root: SgNode,
  rootName: string,
  relPath: string,
): ConditionRecord[] {
  const records: ConditionRecord[] = [];

  let nodes: SgNode[];
  try {
    nodes = root.findAll({ rule: { kind: "binary_expression" as never } });
  } catch {
    return records;
  }

  for (const node of nodes) {
    const operator = node.field("operator")?.text() ?? "";
    if (!COMPARISONS.has(operator)) continue;

    const leftNode = node.field("left");
    const rightNode = node.field("right");
    if (leftNode === undefined || leftNode === null || rightNode === undefined || rightNode === null) {
      continue;
    }

    const left = leftNode.text();
    const right = rightNode.text();

    // Whichever side is the literal; the other is the subject.
    const leftLiteral = literalOf(left);
    const rightLiteral = literalOf(right);
    if ((leftLiteral === null) === (rightLiteral === null)) continue;

    const literal = (leftLiteral ?? rightLiteral)!;
    const subject = leftLiteral === null ? left : right;
    if (!isPlainSubject(subject)) continue;
    if (isIterationSubject(subject, subject === left ? right : left)) continue;

    const range = node.range();
    const source = {
      rootName,
      relPath,
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
      startColumn: range.start.column + 1,
      endColumn: null,
    };

    records.push({
      rootName,
      subject,
      // Read left-to-right as written: `16 < hours` is recorded with the
      // subject on the left and the operator flipped, so two spellings of one
      // rule compare equal.
      operator: leftLiteral === null ? operator : flip(operator),
      literal: literal.value,
      literalKind: literal.kind,
      text: node.text().replaceAll(/\s+/g, " ").slice(0, 200),
      // The whole test this comparison is one part of.
      //
      // `lv.Hours > 16 && flow == L1` is not a limit of sixteen hours; it is
      // what happens to a request over sixteen hours *at the first approval
      // step*. Recorded alone, the comparison reads as a standalone rule, and
      // two tiers of one ladder read as two rules that contradict each other.
      // Measured on a real target: they were published as exactly that.
      fullTest: fullTestOf(node),
      enclosingFunction: enclosingFunctionName(node),
      guarded: guardedOutcome(node),
      source,
      provenance: resolved(source, "high"),
    });
  }

  return records;
}

export function guardsIn(root: SgNode, rootName: string, relPath: string): GuardRecord[] {
  const records: GuardRecord[] = [];
  let nodes: SgNode[];
  try {
    nodes = root.findAll({ rule: { kind: "if_statement" as never } });
  } catch {
    return records;
  }

  const seen = new Set<string>();
  for (const node of nodes) {
    const condition = node.field("condition");
    const consequence =
      node.field("consequence") ??
      node.children().find((child) => (child.kind() as string).includes("block"));
    if (condition === undefined || condition === null) continue;
    if (consequence === undefined || consequence === null) continue;

    const test = condition.text().replace(/^\((.*)\)$/s, "$1").replaceAll(/\s+/g, " ").trim();
    if (test === "" || test.length > 200) continue;
    if (PLUMBING_TEST.test(test)) continue;

    // Only a branch that leaves the function with a message is a stated rule.
    const exit = statementsOf(consequence).find((child) => EXIT_KINDS.has(child.kind() as string));
    if (exit === undefined) continue;
    const stated = firstMessage(exit);
    const message = stated ?? errorCodeName(exit);
    if (message === null) continue;
    const exitKind = (exit.kind() as string) === "throw_statement" ? "throw" : "return";

    const range = node.range();
    const key = `${relPath}:${range.start.line}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const source = {
      rootName,
      relPath,
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
      startColumn: range.start.column + 1,
      endColumn: null,
    };
    records.push({
      rootName,
      test,
      message,
      messageKind: stated === null ? "error-code" : "stated",
      exit: exitKind,
      enclosingFunction: enclosingFunctionName(node),
      source,
      provenance: resolved(source, "high"),
    });
  }

  return records;
}

/**
 * Grammars that wrap a block's contents in one more node.
 *
 * Go's block is `{`, `statement_list`, `}` — the statements are a level deeper
 * than in the script grammars, where they are the block's own children.
 * Reading only the direct children found no `return` in any Go branch, so
 * every guard in the language this tool was built against was reported as one
 * that carries on. Nothing downstream could tell: "continues" is a plausible
 * answer, and it was published as fact.
 */
const STATEMENT_WRAPPERS = new Set<string>(["statement_list", "statement_block"]);

/** The statements a block runs, whichever level its grammar puts them at. */
function statementsOf(block: SgNode): readonly SgNode[] {
  const children = block.children();
  const wrapper = children.find((child) => STATEMENT_WRAPPERS.has(child.kind() as string));
  return wrapper === undefined ? children : wrapper.children();
}

/**
 * What happens when the branch this condition guards is taken.
 *
 * A branch that leaves the function is a rejection: the work stops there. One
 * that falls through carries on. A condition guarding neither — inside an
 * expression, say — has no branch to describe.
 */
function guardedOutcome(node: SgNode): "rejects" | "continues" | null {
  let current: SgNode | null = node.parent();
  for (let depth = 0; current !== null && depth < 4; depth++) {
    const kind = current.kind() as string;
    if (kind === "if_statement") {
      const body =
        current.field("consequence") ??
        current.children().find((child) => (child.kind() as string).includes("block"));
      if (body === undefined || body === null) return null;

      // Only the branch's own exits count; a nested function's return is its.
      const exits = statementsOf(body).some((child) => EXIT_KINDS.has(child.kind() as string));
      return exits ? "rejects" : "continues";
    }
    current = current.parent();
  }
  return null;
}

const BOOLEAN_OPERATORS = new Set(["&&", "||", "and", "or"]);

/**
 * The outermost boolean expression this comparison belongs to.
 *
 * Null where the comparison is the whole test — most of the time — so a
 * consumer can tell "this is the rule" from "this is one clause of the rule"
 * rather than having to compare two strings.
 */
function fullTestOf(node: SgNode): string | null {
  let current: SgNode | null = node.parent();
  let outermost: SgNode | null = null;

  for (let depth = 0; current !== null && depth < 6; depth++) {
    const kind = current.kind() as string;
    if (kind.includes("binary") || kind.includes("logical")) {
      const operator = current.field("operator")?.text() ?? "";
      if (BOOLEAN_OPERATORS.has(operator.trim())) outermost = current;
    } else if (kind !== "parenthesized_expression") {
      break;
    }
    current = current.parent();
  }

  return outermost === null ? null : outermost.text().replaceAll(/\s+/g, " ").slice(0, 400);
}

function flip(operator: string): string {
  switch (operator) {
    case "<":
      return ">";
    case "<=":
      return ">=";
    case ">":
      return "<";
    case ">=":
      return "<=";
    default:
      return operator;
  }
}

/**
 * Calls dispatched without keeping the result that would carry a failure.
 *
 * In Go a `go x.M(...)` statement cannot assign anything, so any error the
 * method returns is unobservable by construction. In JavaScript a
 * promise-returning call standing alone as a statement is the same shape.
 */
function discardedErrorsIn(
  root: SgNode,
  rootName: string,
  relPath: string,
  language: string,
): DiscardedErrorRecord[] {
  const records: DiscardedErrorRecord[] = [];
  const kind = language === "go" ? "go_statement" : "expression_statement";

  // Which methods this file treats as asynchronous, evidenced by the file
  // itself awaiting them. Without this every `res.json(...)` and
  // `console.log(...)` reads as a discarded failure, which buries the real
  // ones — and a signature-based test is not available here.
  const awaited = new Set<string>();
  if (language !== "go") {
    for (const match of root.text().matchAll(/\bawait\s+[\w$.]*?\.?([A-Za-z_$][\w$]*)\s*\(/g)) {
      awaited.add(match[1]!);
    }
  }

  let nodes: SgNode[];
  try {
    nodes = root.findAll({ rule: { kind: kind as never } });
  } catch {
    return records;
  }

  for (const node of nodes) {
    const text = node.text().replaceAll(/\s+/g, " ");

    if (language === "go") {
      // `go x.M(...)` only. An anonymous `go func() { ... }()` carries its own
      // body and can handle what it returns; a method dispatched this way
      // cannot, since a go statement assigns nothing.
      const call = node.children().find((child) => (child.kind() as string) === "call_expression");
      const callee = call?.field("function")?.text() ?? "";
      if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(callee)) continue;

      records.push(record(rootName, relPath, node, text.slice(0, 160), "goroutine"));
      continue;
    }

    // JavaScript: only a bare method call on a receiver, with no await and no
    // handler attached. A plain function call is usually synchronous, so
    // reporting it would be noise.
    const child = node.children()[0];
    if (child === undefined || (child.kind() as string) !== "call_expression") continue;
    if (/\bawait\b|\.then\s*\(|\.catch\s*\(|\.finally\s*\(/.test(text)) continue;
    const callee = child.field("function")?.text() ?? "";
    if (!callee.includes(".")) continue;

    const method = callee.split(".").pop() ?? "";
    if (!awaited.has(method)) continue;

    records.push(record(rootName, relPath, node, text.slice(0, 160), "unawaited call"));
  }

  return records;
}

function record(
  rootName: string,
  relPath: string,
  node: SgNode,
  call: string,
  mechanism: string,
): DiscardedErrorRecord {
  const range = node.range();
  const source = {
    rootName,
    relPath,
    startLine: range.start.line + 1,
    endLine: range.end.line + 1,
    startColumn: range.start.column + 1,
    endColumn: null,
  };
  return {
    rootName,
    call,
    mechanism,
    enclosingFunction: enclosingFunctionName(node),
    source,
    // Whether the callee returns an error is not resolved here, so this is a
    // shape that usually discards one rather than a proven discard.
    provenance: inferred(source, "medium"),
  };
}

export function createLogicProvider(): StructuralProvider {
  const capabilities = logicCapabilities();

  return {
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,
    capabilities: () => declaredKinds(capabilities),
    preflight: (): PreflightResult => ({ available: true, version: PROVIDER_VERSION }),
    structuralCapabilities: () => capabilities,

    extract(root: StructuralRootInput): StructuralContribution {
      const conditions: ConditionRecord[] = [];
      const decisions: DecisionRecord[] = [];
      const guards: GuardRecord[] = [];
      const discarded: DiscardedErrorRecord[] = [];
      const failures: ExtractionFailure[] = [];

      for (const relPath of root.analyzedFiles) {
        const language = languageOf(relPath);
        if (language === null) continue;
        if (/(^|\/)(test|tests|__tests__|spec)\//.test(relPath)) continue;
        if (/\.(test|spec)\.[jt]sx?$|_test\.go$/.test(relPath)) continue;

        try {
          const content = readFileSync(join(root.path, relPath), "utf8");
          const parsed = parseSource(language, content);
          if (parsed.root === null) {
            failures.push({
              scope: relPath,
              reason: parsed.reason ?? "the file could not be parsed",
            });
            continue;
          }

          conditions.push(...conditionsIn(parsed.root, root.name, relPath));
          decisions.push(...decisionsIn(root.name, relPath, content));
          guards.push(...guardsIn(parsed.root, root.name, relPath));
          discarded.push(...discardedErrorsIn(parsed.root, root.name, relPath, language));
        } catch (error) {
          failures.push({
            scope: relPath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        providerId: PROVIDER_ID,
        providerVersion: PROVIDER_VERSION,
        rootName: root.name,
        records: {
          ...emptyRecords(),
          condition: conditions,
          decision: decisions,
          guard: guards,
          "discarded-error": discarded,
        },
        gaps: [],
        failures,
      };
    },
  };
}
