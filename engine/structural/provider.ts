/**
 * The contract a structural provider satisfies.
 *
 * This is what makes the first provider replaceable. A provider states what it
 * can and cannot supply *before* it runs, so a gap is a declared fact rather
 * than something discovered by noticing a report looks thin.
 */

import type { Provider } from "../providers/types.js";
import type { StructuralKind, StructuralRecords } from "./kinds.js";

/** Matches any language in a capability declaration. */
export const ANY_LANGUAGE = "*";

/**
 * Closed, unlike the language-facing vocabularies elsewhere in the model:
 * this describes how well *we* judge a provider to cover something, and there
 * is no fourth answer.
 *
 * `partial` is the important one. Without it, a provider covering most Go
 * routes but missing group-prefixed ones would have to claim either `full`
 * (wrong) or `none` (also wrong, and would discard what it does find).
 */
export type SupportLevel = "full" | "partial" | "none";

export interface CapabilityDeclaration {
  readonly kind: StructuralKind;
  /** A language name, or `ANY_LANGUAGE` for a declaration that does not vary by language. */
  readonly language: string;
  readonly support: SupportLevel;
  /**
   * Known limits, in the provider's own words — a size cutoff, an unsupported
   * framework convention, unresolved dynamic dispatch. Recorded as data rather
   * than documentation because a limit nobody reads is a limit nobody applies.
   */
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

/**
 * Something that broke during extraction without stopping the rest.
 *
 * The same per-item isolation already proven for one unreadable file in the
 * inventory walker and one broken provider in preflight: one file that fails
 * to parse must not discard every other file's symbols.
 */
export interface ExtractionFailure {
  /** What failed — a file path, a subsystem, a query. */
  readonly scope: string;
  readonly reason: string;
}

/**
 * What a provider knows about a root before extracting from it.
 *
 * Deliberately minimal, and deliberately *not* the workspace's `SelectedRoot`
 * or the snapshot's `RootSnapshot` — the same reasoning that keeps
 * `snapshotRoot` on its own `RootInput`. A provider that depended on those
 * shapes would break whenever selection or snapshotting changed for reasons
 * having nothing to do with extraction.
 *
 * `analyzedFiles` carries inventory's decisions forward so a provider does not
 * re-litigate them. A provider that scans the directory itself would happily
 * index vendored dependencies that inventory already excluded, and the model
 * would then describe code the project does not own. Where a provider cannot
 * be constrained at the source — an external indexer pointed at a directory —
 * its adapter is responsible for filtering the output back down to this set.
 */
export interface StructuralRootInput {
  readonly name: string;
  readonly path: string;
  readonly analyzedFiles: readonly string[];
}

/**
 * One provider's findings for one root.
 *
 * Attribution lives here rather than on every record: a contribution is
 * per-provider by construction, so stamping each record would be redundant and
 * would give providers a way to get it wrong. The assembler applies this
 * attribution to the records when merging, which is where a record can first
 * legitimately have more than one source.
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
 * Extends the existing `Provider`, so structural providers pass through the
 * preflight registry unchanged — availability checks, per-provider failure
 * isolation and the refusal on a missing required provider all already work.
 *
 * `extract` is synchronous, matching the rest of the engine. The tool is a
 * batch CLI whose every other stage reads files and shells out synchronously;
 * introducing asynchrony for one provider would force it on every caller
 * upward for no benefit at this scale.
 */
export interface StructuralProvider extends Provider {
  structuralCapabilities(): ProviderCapabilities;
  extract(root: StructuralRootInput): StructuralContribution;
}

/**
 * The coarse kind list the base `Provider.capabilities()` expects, derived
 * from the detailed declarations.
 *
 * Deriving rather than asking implementers for both keeps the two from
 * disagreeing — a provider claiming a coarse capability it has declared no
 * support for would be exactly the silent mismatch this contract exists to
 * prevent.
 */
export function declaredKinds(capabilities: ProviderCapabilities): string[] {
  const kinds = new Set<string>();
  for (const declaration of capabilities.declarations) {
    if (declaration.support !== "none") kinds.add(declaration.kind);
  }
  return [...kinds].sort();
}

/**
 * The declaration governing a kind for a language, preferring an exact
 * language match over an `ANY_LANGUAGE` one.
 *
 * Returns null when the provider said nothing at all — distinct from a
 * declared `none`. Silence means the question was never considered, which is a
 * different state from a considered refusal, and collapsing them would let an
 * unconsidered kind read as a deliberate one.
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

/** Whether a provider claims any support for a kind in a language. */
export function supports(
  capabilities: ProviderCapabilities,
  kind: StructuralKind,
  language: string,
): boolean {
  const declaration = capabilityFor(capabilities, kind, language);
  return declaration !== null && declaration.support !== "none";
}
