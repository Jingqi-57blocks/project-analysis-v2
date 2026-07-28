/**
 * A source of analysis capability, registered without this layer knowing its
 * name. Concrete providers — a structural indexer, an outbound-call detector,
 * a data-model reader — arrive in a later MVP; this contract exists first so
 * the second one composes with the first rather than being branched into it.
 */
export interface Provider {
  readonly id: string;
  /** This adapter's own version. Output shape is tied to it — a run that
   *  cannot say which version produced its data is not reproducible. */
  readonly version: string;
  /**
   * Freeform capability labels this provider claims to supply. No fixed
   * vocabulary here — that belongs to whichever concrete provider family
   * (structural, semantic, data-model) first needs one.
   */
  capabilities(): readonly string[];
  preflight(): PreflightResult;
}

export type PreflightResult =
  | { readonly available: true; readonly version: string }
  | { readonly available: false; readonly reason: string };

/**
 * A type alias intersection, not an `interface extends` — `PreflightResult`
 * is a union, and an interface cannot extend a union type. The intersection
 * distributes over it, so discriminated narrowing on `available` still works.
 */
export type ProviderPreflightResult = PreflightResult & { readonly id: string };

/** A preflight result already narrowed to the unavailable branch — `reason` is always present. */
export type UnavailableProviderResult = ProviderPreflightResult & { readonly available: false };

export interface PreflightReport {
  readonly results: readonly ProviderPreflightResult[];
}

/**
 * Thrown when a run needs a provider that preflight found unavailable.
 *
 * Carries every missing provider's own reported reason — never a generic
 * message. Guidance for a specific tool (an install command, a version
 * requirement) belongs in that tool's adapter and surfaces here unmodified.
 */
export class ProviderUnavailableError extends Error {
  constructor(readonly missing: readonly UnavailableProviderResult[]) {
    super(
      `Required provider(s) unavailable: ${missing.map((m) => `${m.id} (${m.reason})`).join("; ")}`,
    );
    this.name = "ProviderUnavailableError";
  }
}
