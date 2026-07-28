/**
 * The contract a structural provider satisfies.
 *
 * A provider states what it can and cannot supply before it runs, so a gap is
 * a declared fact rather than something discovered by noticing a thin report.
 */

import type { Provider } from "../providers/types.js";
import type { StructuralKind, StructuralRecords } from "./kinds.js";

/** Matches any language in a capability declaration. */
export const ANY_LANGUAGE = "*";

/**
 * `partial` is the important one: a provider covering most routes but missing
 * group-prefixed ones would otherwise have to claim `full` (wrong) or `none`
 * (also wrong, and would discard what it does find).
 */
export type SupportLevel = "full" | "partial" | "none";

export interface CapabilityDeclaration {
  readonly kind: StructuralKind;
  readonly language: string;
  readonly support: SupportLevel;
  /** Recorded as data rather than documentation — a limit nobody reads is a limit nobody applies. */
  readonly limits: readonly string[];
}

export interface ProviderCapabilities {
  readonly declarations: readonly CapabilityDeclaration[];
}

/** What a provider did not supply, and why. Never inferred from an empty result. */
export interface CapabilityGap {
  readonly kind: StructuralKind;
  readonly language: string;
  readonly reason: string;
}

/** Something that broke without stopping the rest — one file must not discard all the others. */
export interface ExtractionFailure {
  readonly scope: string;
  readonly reason: string;
}

/**
 * What a provider knows about a root before extracting.
 *
 * Deliberately not the workspace's `SelectedRoot` or the snapshot's
 * `RootSnapshot`, which change for reasons unrelated to extraction.
 *
 * `analyzedFiles` carries inventory's decisions forward. A provider scanning
 * the directory itself would index vendored dependencies inventory already
 * excluded, and the model would describe code the project does not own. Where
 * an external indexer cannot be constrained, its adapter filters the output
 * back down to this set.
 */
export interface StructuralRootInput {
  readonly name: string;
  readonly path: string;
  readonly analyzedFiles: readonly string[];
}

/**
 * One provider's findings for one root. Attribution lives here rather than on
 * every record: a contribution is per-provider by construction, and the
 * assembler is where a record can first legitimately have two sources.
 */
export interface StructuralContribution {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly rootName: string;
  readonly records: StructuralRecords;
  readonly gaps: readonly CapabilityGap[];
  readonly failures: readonly ExtractionFailure[];
}

/**
 * Extends `Provider`, so structural providers pass through the existing
 * preflight registry unchanged.
 *
 * `extract` is synchronous, matching every other stage; asynchrony for one
 * provider would force it on every caller upward for no benefit at this scale.
 */
export interface StructuralProvider extends Provider {
  structuralCapabilities(): ProviderCapabilities;
  extract(root: StructuralRootInput): StructuralContribution;
}

/** Derived rather than hand-written so the coarse and detailed views cannot disagree. */
export function declaredKinds(capabilities: ProviderCapabilities): string[] {
  const kinds = new Set<string>();
  for (const declaration of capabilities.declarations) {
    if (declaration.support !== "none") kinds.add(declaration.kind);
  }
  return [...kinds].sort();
}

/**
 * Prefers an exact language match over an `ANY_LANGUAGE` one.
 *
 * Null means the provider said nothing — distinct from a declared `none`,
 * since an unconsidered kind should not read as a deliberate refusal.
 */
export function capabilityFor(
  capabilities: ProviderCapabilities,
  kind: StructuralKind,
  language: string,
): CapabilityDeclaration | null {
  const forKind = capabilities.declarations.filter((d) => d.kind === kind);
  return (
    forKind.find((d) => d.language === language) ??
    forKind.find((d) => d.language === ANY_LANGUAGE) ??
    null
  );
}

export function supports(
  capabilities: ProviderCapabilities,
  kind: StructuralKind,
  language: string,
): boolean {
  const declaration = capabilityFor(capabilities, kind, language);
  return declaration !== null && declaration.support !== "none";
}
