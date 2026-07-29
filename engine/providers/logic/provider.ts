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

import { enclosingFunctionName, languageOf, parseSource } from "../../text/ast.js";
import { inferred, resolved } from "../../structural/provenance.js";
import { emptyRecords } from "../../structural/kinds.js";
import type {
  ConditionRecord,
  DecisionRecord,
  DiscardedErrorRecord,
} from "../../structural/rules.js";
import { decisionsIn, MAX_BRANCHES, MAX_DEPTH } from "./decisions.js";
import {
  ANY_LANGUAGE,
  declaredKinds,
  type ExtractionFailure,
  type ProviderCapabilities,
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
      enclosingFunction: enclosingFunctionName(node),
      guarded: guardedOutcome(node),
      source,
      provenance: resolved(source, "high"),
    });
  }

  return records;
}

const EXIT_KINDS = new Set<string>(["return_statement", "throw_statement"]);

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

export function logicCapabilities(): ProviderCapabilities {
  return {
    declarations: [
      {
        kind: "decision",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: [
          "if/else chains and switch statements are read as trees; branching expressed another way — early returns in sequence, a lookup table, polymorphism — is not a decision this reports",
          "a branch records where its body is, not what it does; tables and calls are joined from their own readers by line",
          `nesting deeper than ${MAX_DEPTH} levels or wider than ${MAX_BRANCHES} branches is recorded as truncated rather than dropped`,
          "languages without a grammar in this run are not read at all",
        ],
      },
      {
        kind: "condition",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: [
          "comparisons against a literal are read; a rule expressed through a named constant on both sides is not a condition this reports",
          "a rule spread across several statements, or decided by a function call, is out of reach",
          "counters and bounds checks are excluded by shape, so a genuine rule named like an index is missed",
          "languages without a grammar in this run are not read at all",
        ],
      },
      {
        kind: "discarded-error",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: [
          "the shape of the dispatch is read, not the callee's signature, so a call that returns nothing is reported alongside one that returns an error",
          "only a method dispatched as a goroutine, or an un-awaited method call, is recognised; an anonymous goroutine handles its own result and is not reported",
          "a JavaScript call counts only where the same method is awaited elsewhere in its file, so an asynchronous call never awaited anywhere is missed",
        ],
      },
    ],
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
          "discarded-error": discarded,
        },
        gaps: [],
        failures,
      };
    },
  };
}
