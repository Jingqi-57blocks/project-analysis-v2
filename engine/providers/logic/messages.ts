/**
 * How a rejecting branch's message is read, and what is not one.
 *
 * Its own module because the provider was 729 lines against a 500-line working
 * ceiling, and because these are the rules review has revised most: what counts as
 * presentation, how far a templated message can be quoted, and which branches leave
 * with a message at all. A move, not a rewrite.
 */

import type { SgNode } from "@ast-grep/napi";

export const EXIT_KINDS = new Set<string>(["return_statement", "throw_statement"]);

/**
 * The tests that are plumbing, not rules — error propagation, mostly.
 *
 * `if err != nil { return err }` is the commonest guard in Go and says nothing
 * about the domain; a nil-check or a bare `!ok` is the same. A guard whose test
 * is only one of these is left out even when its rejection carries a message,
 * because the message there describes a failure to do the work, not a rule the
 * work must satisfy.
 */
export const PLUMBING_TEST =
  /^(!?\w*(err|error)\w*)\s*(!=|==)\s*nil$|^!?ok$|^!?\w*ok$|(err|error)\s*(!=|==)\s*nil/i;

/**
 * Names whose value is presentation, never a statement.
 *
 * Named rather than inferred: a `title` or an `aria-label` on a rejected branch
 * often *is* the rule, so the exclusion has to be this narrow. The trailing
 * pattern keeps it open where the world is — `wrapperClassName`, `inputClassName`
 * and whatever the next component library invents.
 */
const STYLING_NAMES = new Set(["className", "class", "style", "styles", "css", "sx"]);
const STYLING_NAME_PATTERN = /(ClassName|Margin|Padding|Color|Radius|Shadow|Width|Height)$/;

export function isStylingName(name: string): boolean {
  return STYLING_NAMES.has(name) || STYLING_NAME_PATTERN.test(name);
}

/**
 * CSS syntax, for values no key introduces.
 *
 * `getRoleColor` returns `['#40C585', 'rgba(64, 197, 133, 0.10)']` — a bare array,
 * so nothing names those values and the name-based skip cannot see them. They
 * reached a recovered specification as rules the system enforces.
 *
 * A closed set on purpose, and defensible as one: it enumerates CSS, not the
 * conventions of any project. The test is that *every* token is one of these, so a
 * sentence containing the word `none` is unaffected.
 */
const CSS_KEYWORDS = new Set([
  "solid",
  "dashed",
  "dotted",
  "none",
  "auto",
  "inherit",
  "transparent",
  "currentcolor",
]);
const CSS_TOKEN =
  /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|var|calc)\(.*|-?[\d.]+(?:px|rem|em|%|vh|vw|fr|s|ms|deg)?|[\d.]+\)?,?)$/i;

export function isPresentationValue(raw: string): boolean {
  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every(
    (token) => CSS_TOKEN.test(token) || CSS_KEYWORDS.has(token.replace(/[(),]/g, "").toLowerCase()),
  );
}

/**
 * Whether a node names presentation and holds its value.
 *
 * Attributes *and* object properties: keyed on the attribute form alone, this
 * missed `className: 'mx-4 my-2'` in a settings object, `borderBottom: '1px solid
 * #DDE3EE'`, and `rootMargin: '-125px 0px 0px 0px'` — which was the first row of a
 * recovered specification's rules table, under a declared limit telling the reader
 * a class list could not appear there.
 *
 * Keyed on the *name*, so it stays safe for the case that made excluding object
 * literals wholesale wrong: a rejection in Express or Go states its message by
 * building a response body, and a response body's key is `message` or `error`,
 * never `className`.
 */
export function isStyling(node: SgNode): boolean {
  const name = node.children()[0];
  return name !== undefined && isStylingName(name.text().replace(/^["'`]|["'`]$/g, ""));
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
export function firstMessage(node: SgNode): string | null {
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
    if ((kind === "jsx_attribute" || kind === "pair" || kind === "property") && isStyling(current)) {
      continue;
    }
    if (kind.includes("string") && !kind.includes("template")) {
      const raw = current.text().replace(/^[`'"]|[`'"]$/g, "").trim();
      // A message, not a format verb, a key, or a single word like "id".
      if (raw.length >= 6 && /\s/.test(raw) && !/^%[svd]/.test(raw) && !isPresentationValue(raw)) {
        return raw.slice(0, 160);
      }
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
export function errorCodeName(node: SgNode): string | null {
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
