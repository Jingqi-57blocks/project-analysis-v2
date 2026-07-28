/**
 * Code structure — the part of the model every project has, whatever it is
 * written in.
 *
 * The vocabularies here are open unions (`Known | (string & {})`). Languages
 * do not agree on what a symbol is: Rust traits, Go's implicit interface
 * satisfaction, Swift protocols, Haskell typeclasses. A closed union would
 * force each through the nearest approximation and quietly claim a Rust trait
 * is a TypeScript interface. Only the types describing *our* judgement —
 * resolution class, confidence — are closed.
 */

import type { Provenance, SourceRef } from "./provenance.js";
import type { SymbolId } from "./identity.js";

/** Conventional values, for autocomplete and normalization. Any string is valid. */
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

/** Open: Rust has `pub(crate)`, Java package-private, Go encodes it in capitalization. */
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
 * Thin deliberately: inventory already records size and disposition, and
 * duplicating that would create two records that can disagree. This adds only
 * what inventory has no basis to know — the language.
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
 * `calleeName` is required even when `calleeId` is null: an unresolved call is
 * still a call, and dropping it would make the graph look cleanest exactly
 * where it is least trustworthy.
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
 * Open because the differences matter: Go's interface satisfaction is implicit,
 * so a provider reporting it is *inferring* a relation the source never states.
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
 * One kind with a discriminator rather than two record types: they differ only
 * in which word a language uses, and splitting them leaves no home for
 * conformance relations that are neither.
 */
export interface TypeRelationRecord {
  readonly subtypeId: SymbolId;
  /** Null when the supertype is outside the analyzed source — a framework base class. */
  readonly supertypeId: SymbolId | null;
  readonly supertypeName: string;
  readonly relation: TypeRelation;
  readonly provenance: Provenance;
}
