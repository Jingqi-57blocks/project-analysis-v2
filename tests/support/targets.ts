import { resolveTarget } from "./targets/resolve.js";
import type { ResolvedTarget } from "./targets/types.js";
import { VERIFIED_VERSION, codegraphVersion } from "../../engine/providers/codegraph/cli.js";

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

/**
 * Whether the pinned code indexer is on this machine.
 *
 * A suite that asserts what CodeGraph extracts needs CodeGraph, the same way it
 * needs a target — and both are absent on machines where that is perfectly
 * normal. Analysis now refuses rather than degrading when the indexer is
 * missing, so these suites fail rather than producing a thin result; skipping
 * with a stated reason is the honest outcome, and matches how a missing target
 * is already handled.
 */
export function codeIndexAvailability(): TargetAvailability {
  const installed = codegraphVersion();
  if (installed === VERIFIED_VERSION) return { available: true, target: null, reason: null };
  return {
    available: false,
    target: null,
    reason:
      installed === null
        ? "codegraph is not installed or not on PATH"
        : `codegraph ${installed} is installed; these tests read the index of ${VERIFIED_VERSION}`,
  };
}

/** Prints why a suite is being skipped, so skipped runs stay legible. */
export function announceSkip(suite: string, reason: string | null): void {
  console.info(`[skip] ${suite}: ${reason ?? "unavailable"}`);
}
