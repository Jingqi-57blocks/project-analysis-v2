/**
 * An in-memory structural provider, for tests.
 *
 * It supplies exactly what it is given and infers nothing, which is what makes
 * it useful here: a test can state the structural facts it wants and nothing
 * else appears. That same property is why it does not belong in the production
 * tree — a provider that fabricates whatever it is handed has no business being
 * importable from the analysis path.
 *
 * It also keeps "providers are replaceable" exercised by something other than
 * CodeGraph, which is a claim about the interface rather than about any run.
 */

import { emptyRecords, type StructuralRecords } from "../../../engine/structural/kinds.js";
import {
  ANY_LANGUAGE,
  type CapabilityGap,
  type ExtractionFailure,
  type ProviderCapabilities,
  type StructuralContribution,
  type StructuralProvider,
  type StructuralRootInput,
} from "../../../engine/structural/provider.js";
import { declaredKinds } from "../../../engine/structural/provider.js";
import type { PreflightResult } from "../../../engine/providers/types.js";

export interface FakeProviderOptions {
  readonly id?: string;
  readonly version?: string;
  /** Records to return, keyed by root name. A root with no entry yields nothing. */
  readonly recordsByRoot?: Readonly<Record<string, Partial<StructuralRecords>>>;
  readonly capabilities?: ProviderCapabilities;
  readonly gaps?: readonly CapabilityGap[];
  readonly failures?: readonly ExtractionFailure[];
  /** Makes the provider report itself unavailable, for exercising refusal paths. */
  readonly unavailableReason?: string;
  /** Makes `extract` throw, for exercising per-provider failure isolation. */
  readonly throwOnExtract?: string;
}

/**
 * Capabilities claimed when none are given: everything the model can hold, at
 * full support, for any language.
 *
 * Honest for this provider specifically — it returns precisely what it was
 * handed, so there is no language or framework it handles worse than another.
 * A real provider claiming this would be overstating; this one cannot.
 */
export function fakeCapabilities(): ProviderCapabilities {
  return {
    declarations: [
      { kind: "source-file", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "symbol", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "call-edge", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "import", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "export", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "reference", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "type-relation", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "package-dependency", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "build-target", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "module-containment", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "route", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "outbound-call", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "external-call", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "data-access", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "auth-annotation", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "test-relation", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "validation-rule", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "transaction-boundary", language: ANY_LANGUAGE, support: "full", limits: [] },
      { kind: "error-handling", language: ANY_LANGUAGE, support: "full", limits: [] },
    ],
  };
}

export function createFakeProvider(options: FakeProviderOptions = {}): StructuralProvider {
  const id = options.id ?? "fake";
  const version = options.version ?? "1.0.0";
  const capabilities = options.capabilities ?? fakeCapabilities();

  return {
    id,
    version,

    capabilities: () => declaredKinds(capabilities),

    preflight: (): PreflightResult =>
      options.unavailableReason
        ? { available: false, reason: options.unavailableReason }
        : { available: true, version },

    structuralCapabilities: () => capabilities,

    extract: (root: StructuralRootInput): StructuralContribution => {
      if (options.throwOnExtract) throw new Error(options.throwOnExtract);

      const supplied = options.recordsByRoot?.[root.name] ?? {};

      return {
        providerId: id,
        providerVersion: version,
        rootName: root.name,
        records: { ...emptyRecords(), ...supplied },
        gaps: options.gaps ?? [],
        failures: options.failures ?? [],
      };
    },
  };
}
