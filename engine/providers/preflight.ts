import {
  ProviderUnavailableError,
  type PreflightReport,
  type Provider,
  type ProviderPreflightResult,
  type UnavailableProviderResult,
} from "./types.js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks every registered provider and reports what it found.
 *
 * Each provider's own `preflight()` runs inside its own try/catch: a provider
 * whose check itself throws — a bug in that adapter, an environment it did
 * not expect — becomes `available: false` with the thrown message as its
 * reason, rather than aborting every other provider's check. The same
 * per-item isolation already used for one unreadable file in
 * `engine/inventory/walk.ts` applies here to one broken provider.
 */
export function runPreflight(providers: readonly Provider[]): PreflightReport {
  const results: ProviderPreflightResult[] = providers.map((provider) => {
    try {
      return { id: provider.id, ...provider.preflight() };
    } catch (error) {
      return { id: provider.id, available: false, reason: describeError(error) };
    }
  });

  return { results };
}

/**
 * Refuses to proceed if any of `requiredIds` was not found available.
 *
 * A provider that is unavailable but not required must never block a run
 * that does not need it — only the required, missing ones are named, each
 * with its own reported reason.
 *
 * A required id with no entry in the report at all — never registered, most
 * likely a typo in the caller's required-id list — is treated the same as an
 * unavailable one, with its own distinguishing reason. Silently letting an
 * unregistered requirement through would hide exactly the kind of caller
 * mistake this project's other refusals (empty selection, schema too new,
 * source drift) exist to surface rather than paper over.
 */
export function requireAvailable(report: PreflightReport, requiredIds: readonly string[]): void {
  const byId = new Map(report.results.map((r) => [r.id, r] as const));
  const missing: UnavailableProviderResult[] = [];

  for (const id of requiredIds) {
    const result = byId.get(id);
    if (!result) {
      missing.push({ id, available: false, reason: "provider not registered" });
      continue;
    }
    if (!result.available) missing.push(result);
  }

  if (missing.length > 0) {
    throw new ProviderUnavailableError(missing);
  }
}
