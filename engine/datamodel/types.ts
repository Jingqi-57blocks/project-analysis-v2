/**
 * The declared data model: entities, fields, relations, constraints.
 *
 * Only what a schema, migration, or model declaration actually states. What
 * the data *means*, or how it behaves at runtime, is not declared anywhere and
 * inventing it here would put guesses into the layer everything downstream
 * treats as ground truth.
 */

import type { Provenance, SourceRef } from "../structural/provenance.js";

/** Open, like every other language-facing vocabulary in this codebase. */
export const CONVENTIONAL_ENTITY_KINDS = ["table", "view", "collection", "model", "type", "unknown"] as const;
export type EntityKind = (typeof CONVENTIONAL_ENTITY_KINDS)[number] | (string & {});

export interface EntityRecord {
  readonly rootName: string;
  readonly name: string;
  readonly kind: EntityKind;
  /** Schema, database, or namespace qualifier where one is declared. */
  readonly qualifier: string | null;
  readonly provenance: Provenance;
}

export interface FieldRecord {
  readonly rootName: string;
  readonly entityName: string;
  readonly name: string;
  /** As written in the declaration — `VARCHAR(255)`, `uuid`, `string`. Not normalized. */
  readonly declaredType: string | null;
  readonly nullable: boolean | null;
  readonly defaultValue: string | null;
  readonly isPrimaryKey: boolean;
  readonly provenance: Provenance;
}

export const CONVENTIONAL_RELATION_KINDS = [
  "foreign-key",
  "one-to-many",
  "many-to-many",
  "embeds",
  "unknown",
] as const;
export type DataRelationKind = (typeof CONVENTIONAL_RELATION_KINDS)[number] | (string & {});

/**
 * A relation between entities.
 *
 * A declared foreign key and a `user_id` column with no constraint are both
 * useful, but they are not the same fact. The first is `declared`; the second
 * is `inferred` with the naming convention as its evidence, so nothing
 * downstream can present a guessed relation as an enforced one.
 */
export interface DataRelationRecord {
  readonly rootName: string;
  readonly fromEntity: string;
  readonly fromField: string | null;
  readonly toEntity: string;
  readonly toField: string | null;
  readonly kind: DataRelationKind;
  readonly provenance: Provenance;
}

export const CONVENTIONAL_CONSTRAINT_KINDS = [
  "primary-key",
  "unique",
  "not-null",
  "check",
  "default",
  "index",
  "unknown",
] as const;
export type ConstraintKind = (typeof CONVENTIONAL_CONSTRAINT_KINDS)[number] | (string & {});

export interface ConstraintRecord {
  readonly rootName: string;
  readonly entityName: string;
  readonly fields: readonly string[];
  readonly kind: ConstraintKind;
  /** The constraint's expression or name, verbatim where one is given. */
  readonly expression: string | null;
  readonly provenance: Provenance;
}

export interface DataModelRecords {
  readonly entities: readonly EntityRecord[];
  readonly fields: readonly FieldRecord[];
  readonly relations: readonly DataRelationRecord[];
  readonly constraints: readonly ConstraintRecord[];
}

export function emptyDataModel(): DataModelRecords {
  return { entities: [], fields: [], relations: [], constraints: [] };
}

export interface DataModelCapability {
  readonly kind: "entity" | "field" | "relation" | "constraint";
  readonly language: string;
  readonly support: "full" | "partial" | "none";
  readonly limits: readonly string[];
}

export interface DataModelCapabilities {
  readonly declarations: readonly DataModelCapability[];
}

export interface DataModelGap {
  readonly kind: string;
  readonly language: string;
  readonly reason: string;
}

export interface DataModelFailure {
  readonly scope: string;
  readonly reason: string;
}

export interface DataModelRootInput {
  readonly name: string;
  readonly path: string;
  readonly analyzedFiles: readonly string[];
}

export interface DataModelContribution {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly rootName: string;
  readonly records: DataModelRecords;
  readonly gaps: readonly DataModelGap[];
  readonly failures: readonly DataModelFailure[];
}

export interface DataModelProvider {
  readonly id: string;
  readonly version: string;
  capabilities(): DataModelCapabilities;
  extract(root: DataModelRootInput): DataModelContribution;
}

export type { SourceRef };
