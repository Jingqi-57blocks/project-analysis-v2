/**
 * Code structure — the part of the model every project has, whatever it is
 * written in.
 *
 * ## Why the vocabulary here is open rather than closed
 *
 * Languages do not agree on what a symbol is. Rust has traits and impls, Go
 * has implicit interface satisfaction, Swift has protocols and extensions,
 * Haskell has typeclasses, Erlang has modules-as-units. A closed union would
 * force each of those through the nearest approximation, and the model would
 * quietly claim a Rust trait is a TypeScript interface.
 *
 * So these are open unions: the conventional values are listed for
 * autocomplete and for normalization, but any string is valid. An unfamiliar
 * language degrades to its own honest label rather than a confident wrong one.
 * The closed types in this model are the ones describing *our* judgement —
 * resolution class, confidence — never the ones describing a language's.
 */

import type { Provenance, SourceRef } from "./provenance.js";
import type { SymbolId } from "./identity.js";

/** Conventional symbol kinds. Any string is permitted — see the note above. */
export const CONVENTIONAL_SYMBOL_KINDS = [
  "function",
  "method",
  "class",
  "interface",
  "protocol",
  "trait",
  "struct",
  "enum",
  "union",
  "type-alias",
  "variable",
  "constant",
  "field",
  "property",
  "constructor",
  "module",
  "namespace",
  "macro",
  "unknown",
] as const;

export type ConventionalSymbolKind = (typeof CONVENTIONAL_SYMBOL_KINDS)[number];

/** `string & {}` keeps the known values discoverable while permitting any language's own. */
export type SymbolKind = ConventionalSymbolKind | (string & {});

/**
 * Conventional visibility values. Open because languages disagree sharply:
 * Rust has `pub(crate)`, Java has package-private, Swift has `fileprivate`
 * and `open`, Go encodes it in capitalization.
 */
export const CONVENTIONAL_VISIBILITIES = [
  "public",
  "private",
  "protected",
  "internal",
  "package",
  "unknown",
] as const;

export type Visibility = (typeof CONVENTIONAL_VISIBILITIES)[number] | (string & {});

/**
 * A source file as the structural layer sees it.
 *
 * Deliberately thin: inventory already records every file's size and
 * disposition, and duplicating that here would create two records that can
 * disagree about the same file. What this adds is the structural fact
 * inventory has no basis to know — what language it is.
 */
export interface SourceFileRecord {
  readonly rootName: string;
  readonly relPath: string;
  /** Null when no provider could identify it, rather than guessed from extension alone. */
  readonly language: string | null;
  readonly provenance: Provenance;
}

export interface SymbolRecord {
  readonly id: SymbolId;
  readonly name: string;
  /** Null where the language has no qualified-name notion. */
  readonly qualifiedName: string | null;
  readonly kind: SymbolKind;
  readonly visibility: Visibility;
  /** Distinguishes overloads where the provider can supply it — see `identity.ts`. */
  readonly signature: string | null;
  /** The enclosing symbol: a method's class, a nested function's parent. */
  readonly containerId: SymbolId | null;
  readonly provenance: Provenance;
}

/**
 * One call site.
 *
 * `calleeName` is required even when `calleeId` is null. An unresolved call is
 * still a call, and keeping the textual target means a dynamic dispatch shows
 * up as "calls something named `handler`, target unknown" rather than
 * vanishing from the graph — which is exactly where the graph would otherwise
 * look cleanest while being least trustworthy.
 */
export interface CallEdgeRecord {
  readonly callerId: SymbolId;
  readonly calleeId: SymbolId | null;
  readonly calleeName: string;
  readonly provenance: Provenance;
}

export interface ImportRecord {
  readonly rootName: string;
  readonly relPath: string;
  /** Exactly as written in source, before any resolution. */
  readonly specifier: string;
  /** Null when the specifier could not be resolved to a file in this workspace. */
  readonly resolvedPath: string | null;
  /** Empty for a whole-module import. */
  readonly importedNames: readonly string[];
  readonly isTypeOnly: boolean;
  readonly provenance: Provenance;
}

export interface ExportRecord {
  readonly rootName: string;
  readonly relPath: string;
  readonly name: string;
  readonly symbolId: SymbolId | null;
  readonly isDefault: boolean;
  readonly provenance: Provenance;
}

export const CONVENTIONAL_REFERENCE_KINDS = [
  "read",
  "write",
  "call",
  "type",
  "annotation",
  "import",
  "unknown",
] as const;

export type ReferenceKind = (typeof CONVENTIONAL_REFERENCE_KINDS)[number] | (string & {});

/** A use of a symbol somewhere other than its definition. */
export interface ReferenceRecord {
  readonly symbolId: SymbolId;
  readonly kind: ReferenceKind;
  readonly source: SourceRef;
  readonly provenance: Provenance;
}

/**
 * Conventional type relations. Open because the concept fragments across
 * languages, and the differences matter: Go's interface satisfaction is
 * structural and implicit, so a provider reporting it is *inferring* a
 * relation the source never states — which is why provenance rides along on
 * this record like every other.
 */
export const CONVENTIONAL_TYPE_RELATIONS = [
  "extends",
  "implements",
  "conforms-to",
  "mixes-in",
  "derives-from",
  "unknown",
] as const;

export type TypeRelation = (typeof CONVENTIONAL_TYPE_RELATIONS)[number] | (string & {});

/**
 * Inheritance and implementation as one kind with a relation discriminator,
 * rather than two record types.
 *
 * They differ only in which word a language uses; splitting them would mean
 * every consumer asking both questions to learn "what is this type built on",
 * and would leave no obvious home for conformance relations that are neither.
 */
export interface TypeRelationRecord {
  readonly subtypeId: SymbolId;
  /** Null when the supertype is outside the analyzed source — a framework base class. */
  readonly supertypeId: SymbolId | null;
  readonly supertypeName: string;
  readonly relation: TypeRelation;
  readonly provenance: Provenance;
}
