/**
 * Boundaries and effects — where a system meets something outside itself.
 *
 * Everything here is domain-shaped and may legitimately be absent: a library
 * has no routes, firmware makes no HTTP calls, a CLI touches no database.
 * Whether an empty result means "the project has none" or "nobody looked" is
 * carried by capability declarations, not by these types.
 */

import type { Provenance, SourceRef } from "./provenance.js";
import type { SymbolId } from "./identity.js";

/**
 * An inbound entry point. `method` is a plain string so the same shape serves
 * gRPC methods, queue subjects and CLI subcommands; hard-coding HTTP verbs
 * would make the model web-only in the place it is most tempting to.
 *
 * Null `method` means a route matching every method — not a `"*"` sentinel
 * every consumer would have to special-case.
 */
/**
 * Which side of the network a route lives on.
 *
 * A single-page application declares its screens with the same vocabulary a
 * server declares its endpoints, and an indexer reports both as routes. Listed
 * together they are worse than useless: a reader — or an agent rebuilding the
 * project — would take `/components/ReviewInfo` for an HTTP endpoint. Closed
 * on purpose: this is our judgement about a fact, not a name a language gives.
 */
export type RouteSurface = "server" | "client";

export interface RouteRecord {
  readonly rootName: string;
  /** Where this route is served. Defaults to the server for anything stated with a method. */
  readonly surface: RouteSurface;
  readonly method: string | null;
  readonly path: string;
  readonly handlerSymbolId: SymbolId | null;
  /** Kept even when the handler symbol is unresolved — an anonymous closure still has a site. */
  readonly handlerName: string | null;
  /**
   * Every name the registration could mean, most-likely first. A wrapped
   * registration reads two ways — `ginSwagger.WrapHandler(swaggerFiles.Handler)`
   * is the wrapper doing the work, `e.CatchError(leave.Creation)` is the inner
   * function doing it — and a reader cannot tell which without knowing what
   * the repository defines. Recording both lets the post-assembly join pick
   * the one that resolves instead of a heuristic guessing here.
   */
  readonly handlerCandidates: readonly string[];
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
 * A call leaving this root over a network boundary. `target` is null when the
 * destination is built at runtime; a plausible-looking wrong endpoint survives
 * review precisely because it looks right, which makes it worse than an
 * acknowledged unknown.
 */
export interface OutboundCallRecord {
  readonly rootName: string;
  readonly target: string | null;
  readonly kind: OutboundKind;
  /**
   * The HTTP method the call uses, when the call site states one.
   *
   * A URL literal does not, but `httpClient.post(...)` does — and without it a
   * call to `/v2/leaves` matches every route at that path, which reads as an
   * ambiguity the source had already resolved.
   */
  readonly method: string | null;
  readonly callerSymbolId: SymbolId | null;
  /**
   * The identifier naming the base this call was built from — `appRunnerApi`,
   * `authApi` — when the destination was composed rather than written out.
   *
   * Which service that base names is deployment configuration, not something
   * any source file states. Recording the identifier keeps the only evidence
   * there is, so the binding can be inferred later and shown for what it is.
   */
  readonly baseIdentifier: string | null;
  readonly provenance: Provenance;
}

/**
 * Use of a third-party dependency's API.
 *
 * Distinct from an outbound call: that crosses a *network* boundary, this
 * crosses a *dependency* one. Merging them would make "what does this service
 * talk to" and "what libraries does this lean on" the same question, and they
 * have different answers.
 */
export interface ExternalCallRecord {
  readonly rootName: string;
  readonly callerSymbolId: SymbolId | null;
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
  /** Table, collection or key namespace. Null when built dynamically. */
  readonly entity: string | null;
  readonly operation: DataOperation;
  /** An ORM, a raw driver, a query builder. */
  readonly mechanism: string;
  readonly symbolId: SymbolId | null;
  readonly provenance: Provenance;
}

/**
 * A *declared* authentication or authorization requirement. Authorization
 * enforced by branching inside a function body is out of reach here, so
 * nothing may present these as a complete picture of a system's auth.
 */
export interface AuthAnnotationRecord {
  readonly rootName: string;
  readonly symbolId: SymbolId | null;
  readonly mechanism: string;
  readonly requirement: string | null;
  readonly source: SourceRef;
  readonly provenance: Provenance;
}

export const CONVENTIONAL_TEST_RELATIONS = ["covers", "references", "unknown"] as const;

export type TestRelation = (typeof CONVENTIONAL_TEST_RELATIONS)[number] | (string & {});

/**
 * A test and the production code it exercises. A null target with unresolved
 * provenance is a real finding — dropping it would make coverage look better
 * than it is.
 */
export interface TestRelationRecord {
  readonly rootName: string;
  readonly testSymbolId: SymbolId;
  readonly targetSymbolId: SymbolId | null;
  readonly targetName: string | null;
  readonly relation: TestRelation;
  readonly provenance: Provenance;
}
