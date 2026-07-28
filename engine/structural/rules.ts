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
