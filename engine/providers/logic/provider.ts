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
  GuardRecord,
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

const EXIT_KINDS = new Set<string>(["return_statement", "throw_statement"]);

/**
 * The tests that are plumbing, not rules — error propagation, mostly.
 *
 * `if err != nil { return err }` is the commonest guard in Go and says nothing
 * about the domain; a nil-check or a bare `!ok` is the same. A guard whose test
 * is only one of these is left out even when its rejection carries a message,
 * because the message there describes a failure to do the work, not a rule the
 * work must satisfy.
 */
const PLUMBING_TEST =
  /^(!?\w*(err|error)\w*)\s*(!=|==)\s*nil$|^!?ok$|^!?\w*ok$|(err|error)\s*(!=|==)\s*nil/i;

/**
 * Attributes whose value is presentation, never a statement.
 *
 * Named rather than inferred: a `title` or an `aria-label` on a rejected branch
 * often *is* the rule, so the exclusion has to be this narrow.
 */
const STYLING_ATTRIBUTES = new Set(["className", "class", "style"]);

function isStyling(attribute: SgNode): boolean {
  const name = attribute.children()[0];
  return name !== undefined && STYLING_ATTRIBUTES.has(name.text());
}

/**
 * The first string literal inside a node — the message a rejection states.
 *
 * Styling attributes are skipped; the rest of the markup is not. `if
 * (record.cancel_flag) return <Button className="py-0 lh-base text-nowrap">` had a
 * CSS class list read as a business rule, and it reached a recovered specification
 * under the heading "rules the system enforces" — so a class list is never a
 * message. Skipping markup wholesale was tried and reverted: it also dropped the
 * four rules WCP states in a tooltip's `title`, and a component's props are where
 * a browser application says what it refuses to do.
 *
 * The declared limit is the other half of this: a prop that is a label rather than
 * a rejection is read as though it were one.
 */
function firstMessage(node: SgNode): string | null {
  const stack: SgNode[] = [node];
  while (stack.length > 0) {
    const current = stack.shift()!;
    const kind = current.kind() as string;
    // A styling attribute is not a message. `if (record.cancel_flag) return
    // <Button className="py-0 lh-base text-nowrap">` had a CSS class list read as
    // a business rule, because the walk takes the first string in the returned
    // subtree and a component's first string is usually a prop.
    //
    // Only styling, though. Skipping markup wholesale was tried and it cost real
    // rules: this browser application states several by the tooltip it renders —
    // `if (durationDays >= 30) return <BSTooltip title="Exceeded the expect date
    // by more than a month">` and `if (client.submitted) return <BSTooltip
    // title="Client has filled out the review and cannot be removed">`. Neither
    // is a literal comparison, so nothing else recovers them.
    //
    // Excluding settings objects was tried and reverted for the same reason: a
    // rejection in Express or Go commonly states its message *by* building a
    // response body, so it lost "Invalid Authorization header" and "invalid
    // client". Noise and rules share that shape; styling attributes are the one
    // place they do not.
    if (kind === "jsx_attribute" && isStyling(current)) continue;
    if (kind.includes("string") && !kind.includes("template")) {
      const raw = current.text().replace(/^[`'"]|[`'"]$/g, "").trim();
      // A message, not a format verb, a key, or a single word like "id".
      if (raw.length >= 6 && /\s/.test(raw) && !/^%[svd]/.test(raw)) return raw.slice(0, 160);
    }
    for (const child of current.children()) stack.push(child);
  }
  return null;
}

/**
 * The name of the error a rejection raises, where it raises a named one.
 *
 * Not every codebase writes its rejections as sentences. WCP's older service
 * throws `new BusinessError(ErrorCodes.WKL_Forbidden)` — 150 times, over
 * gates that are the real business rules of the capability — and looking only
 * for string literals meant a report of that service described almost no
 * rules at all while saying nothing about why.
 *
 * The constant's name is not the message a user sees; the text lives in a
 * catalogue this reader does not open. But `WKL_Forbidden` beside the test that
 * raises it is a rule a reader can act on, which is the bar for recording it.
 *
 * Only a `throw` counts. A branch that *returns* a named constant is usually
 * returning a value, not refusing to work: `return DEFAULT_TITLE`,
 * `return POSITIVE_INFINITY` and `return REVENUE_CLIENT_ROW_HEIGHT` all came
 * back as business rules of WCP's browser application before this test looked
 * at how the branch leaves.
 *
 * A name qualifies only if every underscore-separated part of it begins with a
 * capital — `WKL_Forbidden`, `USER_Permission_Deny`, `TL_BTO_Hour_Error`. That
 * is what tells a declared code apart from an ordinary local: `found_level1`,
 * returned by a vendored documentation script, was read as a business rule
 * until this test required the capitals.
 *
 * Shallowest first, so the name belongs to the rejection itself rather than to
 * something nested in one of its arguments.
 */
function errorCodeName(node: SgNode): string | null {
  if ((node.kind() as string) !== "throw_statement") return null;

  // The thrown expression, then — for `new BusinessError(X)` or `reject(X)` —
  // its first argument. Nothing deeper: searching the whole subtree took a
  // constant from wherever it appeared, so `new LimitError(compare(n, MAX_ROWS))`
  // reported MAX_ROWS as the rule, and `HTTP_STATUS.forbidden` reported the
  // container HTTP_STATUS because the member itself failed the shape test.
  const thrown = node.children().find((child) => !SYNTAX_KINDS.has(child.kind() as string));
  if (thrown === undefined) return null;
  const argument = firstArgumentOf(thrown) ?? thrown;

  const name = argument.text().trim().split(".").pop() ?? "";
  const parts = name.split("_");
  const named =
    name.length >= 6 &&
    parts.length >= 2 &&
    parts.every((part) => /^[A-Z][A-Za-z0-9]*$/.test(part));
  return named ? name.slice(0, 160) : null;
}

/** Tokens a grammar keeps as children of a statement: `throw`, `;`, comments. */
const SYNTAX_KINDS = new Set<string>(["throw", ";", "comment", "raise"]);

/**
 * The first argument of a call or construction, or null when it is neither.
 *
 * `new BusinessError(ErrorCodes.X)` names the rule in its first argument; a
 * bare `throw SomeError` names it outright. A second argument is a message or a
 * cause, and reading past the first is how an unrelated constant got in.
 */
function firstArgumentOf(node: SgNode): SgNode | null {
  const list = node.children().find((child) => (child.kind() as string).includes("argument"));
  if (list === undefined) return null;
  return (
    list.children().find((child) => !["(", ")", ",", "comment"].includes(child.kind() as string)) ??
    null
  );
}

/**
 * The gates a capability enforces that are not literal comparisons.
 *
 * An `if` whose branch rejects with a message: the message is the rule in the
 * code's own words. Where the rejection names an error constant instead, that
 * name is recorded and marked as one, so a reader is never shown a symbol as
 * though it were a sentence someone wrote for them.
 *
 * Plumbing guards (error propagation) are filtered by shape, and a rejection
 * carrying neither a message nor a named error is left out — without one there
 * is nothing a reader could act on that `condition` and `decision` do not
 * already carry.
 */
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
        kind: "guard",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: [
          "an `if` that rejects is read as a rule, by the message it states or by the name of the error constant it *throws*; the text behind such a constant lives in a message catalogue this run does not read, so the rule is named rather than quoted",
          "a named error must be the thrown expression or its first argument, and its parts must be capitalised — so `raise PermissionDenied`, `return ErrNotFound` and `throw new ForbiddenException()` are all missed, and a gate that rejects through one of those is absent rather than reported",
          "the message is the rule as the code states it, not a resolution of what it means; two gates with the same message on different values read alike",
          "a message built from a template is quoted as the first run of its text that reads like a sentence, which may begin or end at an interpolation: `Already have a work log for ${proj.name}` is reported as `Already have a work log for`, and `entries[${i}].date must be YYYY-MM-DD` as `].date must be YYYY-MM-DD`. A message longer than 160 characters is cut. The rule is real in each case and its sentence is incomplete",
          "error-propagation guards (`if err != nil`) are filtered by shape, so a genuine rule that happens to test a variable named like an error is missed",
          "a styling attribute is never read as a message, so a rule stated only through a class name is missed — and one stated in a component's other props is read as though it were a rejection",
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
