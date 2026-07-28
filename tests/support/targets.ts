import { resolveTarget } from "../../engine/targets/resolve.js";
import type { ResolvedTarget } from "../../engine/targets/types.js";

export interface TargetAvailability {
  readonly available: boolean;
  readonly target: ResolvedTarget | null;
  readonly reason: string | null;
}

/**
 * Looks up a real target for integration tests.
 *
 * Targets live outside the repository and are not present on every machine, so
 * absence is expected. Callers pair this with `describe.skipIf` and print
 * `reason` — a skipped suite must say why rather than looking green.
 */
export function targetAvailability(id: string): TargetAvailability {
  const resolution = resolveTarget(id);
  if (resolution.ok) {
    return { available: true, target: resolution.target, reason: null };
  }
  return { available: false, target: null, reason: resolution.unavailable.reason };
}

/** Prints why a suite is being skipped, so skipped runs stay legible. */
export function announceSkip(suite: string, reason: string | null): void {
  console.info(`[skip] ${suite}: ${reason ?? "unavailable"}`);
}
