/**
 * An in-memory structural provider.
 *
 * Not a test fixture — a deliverable. The later MVPs build reports on top of
 * the Structural Model, and they must be developable and runnable with no
 * vendor tool installed. Without this, work on reports would block on
 * CodeGraph being present, and the "providers are replaceable" claim would
 * never be exercised by anything other than CodeGraph itself.
 *
 * It supplies exactly what it is given. It infers nothing, so it can never
 * become an accidental second source of truth that quietly disagrees with a
 * real provider.
 */

import { emptyRecords, type StructuralRecords } from "../../structural/kinds.js";
import {
  ANY_LANGUAGE,
  type CapabilityGap,
  type ExtractionFailure,
  type ProviderCapabilities,
  type StructuralContribution,
  type StructuralProvider,
  type StructuralRootInput,
} from "../../structural/provider.js";
import { declaredKinds } from "../../structural/provider.js";
import type { PreflightResult } from "../types.js";

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
