/**
 * Declarative rules — the subset of business logic that is stated rather than
 * executed.
 *
 * ## Where the line is, and why it is drawn here
 *
 * Validators, transaction boundaries and error handling are usually *declared*
 * — a decorator, an annotation, a schema-bound type, a call to a known API.
 * Those are the same shapes already being extracted, so they cost nothing new
 * to reach.
 *
 * Statement-level control flow is deliberately absent: conditional branches,
 * per-branch business rules, state machines with pre- and post-conditions.
 * Recovering those needs real AST traversal per language, which is exactly the
 * per-language work the provider architecture exists to keep out of the
 * engine. If branch-level rules become necessary they arrive as a new provider
 * capability with its own coverage entry — never as language-specific code
 * bolted into the model.
 *
 * This boundary is stated in the types themselves rather than left implicit,
 * because a model silently missing half a system's rules would let a report
 * describe validation as complete when it had only seen the annotated part.
 */

import type { Provenance, SourceRef } from "./provenance.js";
import type { SymbolId } from "./identity.js";

/**
 * A declared constraint on data.
 *
 * `rule` is the constraint as named in source — `required`, `maxLength`,
 * `email`, a custom validator's name — rather than a normalized vocabulary.
 * Normalizing would mean deciding that one framework's `@NotBlank` and
 * another's `required` mean the same thing, which is a judgement the model has
 * no basis to make and that a reader can make better with the original word in
 * front of them.
 */
export interface ValidationRuleRecord {
  readonly rootName: string;
  /** The type or handler the rule constrains. */
  readonly subjectSymbolId: SymbolId | null;
  /** The specific field, where the rule applies to one. */
  readonly field: string | null;
  readonly rule: string;
  /** The rule's argument or expression, verbatim, where it has one. */
  readonly expression: string | null;
  readonly source: SourceRef;
  readonly provenance: Provenance;
}

/**
 * A declared transactional scope.
 *
 * Either an annotation (`@Transactional` and its equivalents) or a call to a
 * known transaction API. Both are declarations; neither tells us whether the
 * transaction is correct, only that it was asked for.
 */
export interface TransactionBoundaryRecord {
  readonly rootName: string;
  readonly symbolId: SymbolId | null;
  /** The mechanism as written — the annotation or API name. */
  readonly mechanism: string;
  /** Propagation, isolation, or similar qualifiers where declared. */
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
 * The presence of error handling around a scope.
 *
 * Presence only. Whether handling is *adequate* — whether it swallows, retries,
 * or rethrows meaningfully — is a question about statements, and answering it
 * from structure alone would be inventing an assessment. What this supports is
 * the honest question: is there any handling here at all.
 */
export interface ErrorHandlingRecord {
  readonly rootName: string;
  readonly symbolId: SymbolId | null;
  /** Error types named as handled, where the language names them. Empty for a catch-all. */
  readonly handles: readonly string[];
  readonly scope: ErrorScope;
  readonly source: SourceRef;
  readonly provenance: Provenance;
}
