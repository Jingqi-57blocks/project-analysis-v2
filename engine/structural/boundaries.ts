/**
 * Boundaries and effects — where a system meets something outside itself.
 *
 * ## These kinds may legitimately be absent
 *
 * Everything in this file is domain-shaped. A library has no routes. Firmware
 * makes no HTTP calls. A CLI touches no database. For those projects the
 * correct result is *nothing*, and that must be reportable as "this project
 * has none" rather than "extraction found none", which reads identically in a
 * report but means the opposite.
 *
 * The distinction is carried by capability declarations, not by these types: a
 * provider that cannot extract routes declares that gap, so an empty route
 * list from a capable provider means the project has no routes, while an empty
 * list with a declared gap means nobody looked. Conflating those would let a
 * silent gap read as a confident finding.
 */

import type { Provenance, SourceRef } from "./provenance.js";
import type { SymbolId } from "./identity.js";

/**
 * An inbound entry point.
 *
 * `method` is a plain string rather than an HTTP verb union — the same shape
 * serves gRPC methods, message-queue subjects, and CLI subcommands, and
 * hard-coding HTTP here would make the model web-only in the one place it is
 * most tempting to.
 *
 * `method` is null for a route matching every method. The hand-verified route
 * reference contains exactly such a case, which is why this is null rather
 * than a `"*"` sentinel that every consumer would have to know to special-case.
 */
export interface RouteRecord {
  readonly rootName: string;
  readonly method: string | null;
  /** As declared, including any wildcard or parameter syntax. */
  readonly path: string;
  readonly handlerSymbolId: SymbolId | null;
  /** Kept even when the handler symbol cannot be resolved — an anonymous closure still has a site. */
  readonly handlerName: string | null;
  /** Names only; resolving middleware to symbols is a separate relation. */
  readonly middleware: readonly string[];
  readonly provenance: Provenance;
}

export const CONVENTIONAL_OUTBOUND_KINDS = [
  "http",
  "grpc",
  "queue",
  "stream",
  "rpc",
  "unknown",
] as const;

export type OutboundKind = (typeof CONVENTIONAL_OUTBOUND_KINDS)[number] | (string & {});

/**
 * A call leaving this root over a network boundary.
 *
 * `target` is null when the destination is built at runtime — concatenated,
 * read from configuration, injected. Those must stay unresolved rather than
 * being guessed: a plausible-looking wrong endpoint survives review precisely
 * because it looks right, which makes it more damaging than an acknowledged
 * unknown.
 */
export interface OutboundCallRecord {
  readonly rootName: string;
  readonly target: string | null;
  readonly kind: OutboundKind;
  readonly callerSymbolId: SymbolId | null;
  readonly provenance: Provenance;
}

/**
 * Use of a third-party dependency's API.
 *
 * Distinct from `OutboundCallRecord`, and the line is worth stating: an
 * outbound call crosses a *network* boundary, an external call crosses a
 * *dependency* boundary. Calling a local SDK function that never touches the
 * network is the second and not the first; posting to a URL with no SDK
 * involved is the first and not the second. Merging them would make "what does
 * this service talk to" and "what libraries does this code lean on" the same
 * question, and they have different answers and different consequences.
 */
export interface ExternalCallRecord {
  readonly rootName: string;
  readonly callerSymbolId: SymbolId | null;
  /** The dependency being used, matching a `PackageDependencyRecord` name where known. */
  readonly packageName: string;
  readonly memberName: string | null;
  readonly provenance: Provenance;
}

export const CONVENTIONAL_DATA_OPERATIONS = [
  "read",
  "write",
  "update",
  "delete",
  "schema-change",
  "unknown",
] as const;

export type DataOperation = (typeof CONVENTIONAL_DATA_OPERATIONS)[number] | (string & {});

export interface DataAccessRecord {
  readonly rootName: string;
  /** Table, collection, bucket, or key namespace. Null when built dynamically. */
  readonly entity: string | null;
  readonly operation: DataOperation;
  /** How the access happens — an ORM, a raw driver, a query builder. */
  readonly mechanism: string;
  readonly symbolId: SymbolId | null;
  readonly provenance: Provenance;
}

/**
 * A declared authentication or authorization requirement.
 *
 * Only what is *declared* — a decorator, an annotation, a guard registration.
 * Authorization enforced by branching inside a function body is statement-level
 * control flow and deliberately out of reach here; claiming to have found all
 * of a system's auth from annotations alone would be the most dangerous
 * possible overstatement this model could make.
 */
export interface AuthAnnotationRecord {
  readonly rootName: string;
  readonly symbolId: SymbolId | null;
  /** The mechanism as named in source — a guard, a middleware, a role check. */
  readonly mechanism: string;
  /** The specific requirement where one is given — a role, a scope, a permission. */
  readonly requirement: string | null;
  readonly source: SourceRef;
  readonly provenance: Provenance;
}

export const CONVENTIONAL_TEST_RELATIONS = ["covers", "references", "unknown"] as const;

export type TestRelation = (typeof CONVENTIONAL_TEST_RELATIONS)[number] | (string & {});

/**
 * A test and the production code it exercises.
 *
 * `targetSymbolId` null with an unresolved provenance is a real and useful
 * finding: a test whose subject cannot be traced says something about the
 * codebase, and dropping it would make coverage look better than it is.
 */
export interface TestRelationRecord {
  readonly rootName: string;
  readonly testSymbolId: SymbolId;
  readonly targetSymbolId: SymbolId | null;
  readonly targetName: string | null;
  readonly relation: TestRelation;
  readonly provenance: Provenance;
}
