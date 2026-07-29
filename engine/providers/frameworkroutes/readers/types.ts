import type { RouteRecord } from "../../../structural/boundaries.js";
import type { CapabilityGap, ExtractionFailure, StructuralRootInput } from "../../../structural/provider.js";

export interface FrameworkReading {
  readonly routes: readonly RouteRecord[];
  readonly gaps: readonly CapabilityGap[];
  readonly failures: readonly ExtractionFailure[];
}

/**
 * One framework's route-registration conventions.
 *
 * Registered in a list like manifest readers, so supporting another framework
 * is additive. A reader that does not detect its framework in a root simply
 * does not run there — the provider reports the absence as a declared gap.
 */
export interface FrameworkRouteReader {
  readonly id: string;
  /** The language this reader's limits are declared under. */
  readonly language: string;
  readonly limits: readonly string[];
  detect(root: StructuralRootInput): boolean;
  read(root: StructuralRootInput): FrameworkReading;
}

/** Joins a group prefix and a registration subpath into one route path. */
export function joinRoutePath(prefix: string, subpath: string): string {
  const joined = `${prefix}/${subpath}`.replaceAll(/\/+/g, "/");
  const trimmed = joined.length > 1 ? joined.replace(/\/$/, "") : joined;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
