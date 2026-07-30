/**
 * Declarative rules — business logic that is stated rather than executed.
 *
 * Validators, transaction boundaries and error handling are usually declared:
 * a decorator, an annotation, a schema-bound type, a call to a known API.
 * Statement-level control flow is deliberately absent, since recovering it
 * needs per-language AST traversal — the work the provider architecture exists
 * to keep out of the engine. It would arrive as a new capability, not as code
 * bolted into the model.
 */

import type { Provenance, SourceRef } from "./provenance.js";
import type { SymbolId } from "./identity.js";

/**
 * `rule` is the constraint as named in source rather than a normalized
 * vocabulary: deciding that `@NotBlank` and `required` mean the same thing is
 * a judgement the model has no basis to make, and a reader makes it better
 * with the original word in front of them.
 */
export interface ValidationRuleRecord {
  readonly rootName: string;
  readonly subjectSymbolId: SymbolId | null;
  readonly field: string | null;
  readonly rule: string;
  readonly expression: string | null;
  readonly source: SourceRef;
  readonly provenance: Provenance;
}

/** Tells us a transaction was asked for, never whether it is correct. */
export interface TransactionBoundaryRecord {
  readonly rootName: string;
  readonly symbolId: SymbolId | null;
  readonly mechanism: string;
  readonly propagation: string | null;
  readonly source: SourceRef;
  readonly provenance: Provenance;
}

export const CONVENTIONAL_ERROR_SCOPES = [
  "function",
  "call-site",
  "module",
  "middleware",
  "unknown",
] as const;

export type ErrorScope = (typeof CONVENTIONAL_ERROR_SCOPES)[number] | (string & {});

/**
 * Presence of handling only. Whether it swallows, retries or rethrows
 * meaningfully is a question about statements; answering it from structure
 * would be inventing an assessment.
 */
export interface ErrorHandlingRecord {
  readonly rootName: string;
  readonly symbolId: SymbolId | null;
  /** Empty for a catch-all, or where the language does not name error types. */
  readonly handles: readonly string[];
  readonly scope: ErrorScope;
  readonly source: SourceRef;
  readonly provenance: Provenance;
}

/**
 * A comparison against a literal — the shape a business rule takes in code.
 *
 * `hours > 16`, `status IN (4, 6)`: a threshold or a state test written with
 * the value spelled out. Recorded verbatim, because what the rule *means*
 * depends on constants declared elsewhere and resolving it here would bake in
 * a guess. The subject is kept as written so it can be matched against the
 * value sets the project declares.
 */
export interface ConditionRecord {
  readonly rootName: string;
  /** The compared expression as written: `lv.Status`, `takeHours`. */
  readonly subject: string;
  /** `>`, `>=`, `==`, `!=`, `in`, … as the language spells it. */
  readonly operator: string;
  readonly literal: number | string;
  readonly literalKind: "numeric" | "string";
  /** The whole comparison as written, for a reader who wants the original. */
  readonly text: string;
  /**
   * The whole test this comparison is one clause of, where it is one.
   *
   * `lv.Hours > 16 && flow == L1` is not a sixteen-hour limit — it is what
   * happens to a longer request at the first approval step. Without this, two
   * tiers of one ladder read as two rules that contradict each other.
   */
  readonly fullTest?: string | null;
  readonly enclosingFunction: string | null;
  /**
   * What the guarded branch does, where the condition guards one.
   *
   * `rejects` means the branch leaves the function — a return or a throw — so
   * failing the test stops the work. That is the difference between a rule a
   * reader can follow and a comparison sitting in a list.
   */
  readonly guarded: "rejects" | "continues" | null;
  readonly source: SourceRef;
  readonly provenance: Provenance;
}

/**
 * A gate: an `if` that stops the work and says why.
 *
 * Where `condition` reads comparisons against a literal — `hours > 16` — a
 * guard reads the business rules that are *not* literal comparisons: a call
 * (`if IsPresaleOrEOR()`), two values compared (`if requested > available`), a
 * length or membership test. What makes it a rule worth recording rather than
 * plumbing is that the branch rejects *with a message* — `"Attachment is
 * required."`, `"Not enough holiday."` — so the message is the rule stated in
 * the code's own words. A guard that only propagates an error (`return err`)
 * carries no such message and is left out.
 */
export interface GuardRecord {
  readonly rootName: string;
  /** The condition as written: `IsPresaleOrEOR()`, `maxAvailable < total`. */
  readonly test: string;
  /** The message the rejection states — the rule in the code's own words. */
  readonly message: string;
  /**
   * Whether that message is text someone wrote, or the name of an error
   * constant the rejection raises.
   *
   * A codebase that rejects with `BusinessError(ErrorCodes.WKL_Forbidden)` says
   * what its rule is by that name, but the sentence a user sees lives in a
   * catalogue this reader does not open. Keeping the two apart stops a symbol
   * being quoted to a reader as though it were a sentence.
   */
  readonly messageKind: "stated" | "error-code";
  readonly enclosingFunction: string | null;
  readonly source: SourceRef;
  readonly provenance: Provenance;
}

/**
 * Work the system runs on a timer rather than on a request.
 *
 * A scheduler registration — a cron entry, a scheduled job. The schedule
 * expression is kept when the call states it literally (`@every 5m`,
 * `30 * * * * *`); a spec read from configuration is null, because what the
 * configuration holds is a deployment fact the source does not state.
 */
export interface ScheduledTaskRecord {
  readonly rootName: string;
  /** The registration API matched: `scheduleJob`, `AddFunc`, `CronJob`. */
  readonly mechanism: string;
  /** The literal schedule or job name at the call site, where one is written. */
  readonly schedule: string | null;
  readonly source: SourceRef;
  readonly provenance: Provenance;
}

/**
 * A place the system sends something to a person or another system —
 * an email, a chat message, a push notification.
 *
 * The channel is read from the API matched; the recipient and the content are
 * runtime values no pattern can know, so nothing here claims them.
 */
export interface NotificationCallRecord {
  readonly rootName: string;
  /** The channel the API implies: `mail`, `chat`, `push`. */
  readonly channel: string;
  /** The call as matched: `sendMail`, `PostMessage`, `messaging().send`. */
  readonly mechanism: string;
  readonly source: SourceRef;
  readonly provenance: Provenance;
}

/**
 * A call whose failure nobody can observe.
 *
 * Distinct from an absence of error handling: here the result carrying the
 * error was thrown away at the call site, so no handling is possible further
 * up either.
 */
export interface DiscardedErrorRecord {
  readonly rootName: string;
  /** The call as written, `go notifier.Execute(ctx)`. */
  readonly call: string;
  /** How it was dispatched — a goroutine, an un-awaited promise. */
  readonly mechanism: string;
  readonly enclosingFunction: string | null;
  readonly source: SourceRef;
  readonly provenance: Provenance;
}

/**
 * One branch of a decision: what it tests, and where its body is.
 *
 * Deliberately without effects. Tables and calls have readers of their own,
 * with their own locations — joining by line range later keeps one fact with
 * one source, where detecting them again here would be a second opinion that
 * can disagree with the first.
 */
export interface DecisionBranch {
  /** The test as written, or "otherwise" for an else or default. */
  readonly test: string;
  /** Literal values it compares against, so a value set can name them. */
  readonly values: readonly (string | number)[];
  /** Whether taking this branch leaves the decision — a return, throw or break. */
  readonly outcome: "leaves" | "continues";
  readonly startLine: number;
  readonly endLine: number;
  /**
   * Records this branch was observed to touch.
   *
   * Not read by the reader — filled in when the decision is joined to the
   * data-access records that share its lines, so one fact keeps one source.
   */
  readonly touches?: readonly string[];
  /** Decisions made inside this branch. */
  readonly decisions: readonly DecisionRecord[];
}

/**
 * A decision the code makes, as a tree.
 *
 * `lv.Type == BTO`, `== PTO`, `== UTO` are one decision with three branches;
 * recorded flat as conditions they are three unrelated facts and nothing can
 * draw what the system decides. Both shapes are one kind here — a reader
 * cannot tell an `if` chain from a `switch`, and neither should this.
 */
export interface DecisionRecord {
  readonly rootName: string;
  readonly kind: "if" | "switch";
  /** What is being decided about, where every branch agrees. Empty otherwise. */
  readonly subject: string;
  readonly enclosingFunction: string | null;
  readonly branches: readonly DecisionBranch[];
  readonly startLine: number;
  readonly endLine: number;
  /** True when a depth or breadth bound was hit, so the tree is partial. */
  readonly truncated: boolean;
  readonly source: SourceRef;
  readonly provenance: Provenance;
}
