/**
 * Routes read from framework registration conventions — the route-aware
 * provider MVP 3's coverage matrix has pointed at since the gate first
 * measured one exact path in fifteen.
 *
 * Composed alongside CodeGraph rather than replacing it: this provider's
 * directly-observed full paths subsume CodeGraph's prefix-less inferences
 * during route consolidation, and roots with no recognized framework keep
 * whatever CodeGraph saw.
 */

import { emptyRecords } from "../../structural/kinds.js";
import {
  ANY_LANGUAGE,
  declaredKinds,
  type CapabilityGap,
  type ProviderCapabilities,
  type StructuralContribution,
  type StructuralProvider,
  type StructuralRootInput,
} from "../../structural/provider.js";
import type { PreflightResult } from "../types.js";
import { createGinReader } from "./readers/gin.js";
import { createExpressReader } from "./readers/express.js";
import { createReactRouterReader } from "./readers/reactrouter.js";
import type { FrameworkRouteReader } from "./readers/types.js";

export const PROVIDER_ID = "framework-routes";
export const PROVIDER_VERSION = "1.0.0";

export function frameworkCapabilities(
  readers: readonly FrameworkRouteReader[],
): ProviderCapabilities {
  return {
    declarations: readers.map((reader) => ({
      kind: "route" as const,
      language: reader.language,
      support: "partial" as const,
      limits: [...reader.limits, "frameworks other than those with a registered reader are not read"],
    })),
  };
}

export function createFrameworkRoutesProvider(
  readers: readonly FrameworkRouteReader[] = [
    createGinReader(),
    createExpressReader(),
    createReactRouterReader(),
  ],
): StructuralProvider {
  const capabilities = frameworkCapabilities(readers);

  return {
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,
    capabilities: () => declaredKinds(capabilities),
    preflight: (): PreflightResult => ({ available: true, version: PROVIDER_VERSION }),
    structuralCapabilities: () => capabilities,

    extract(root: StructuralRootInput): StructuralContribution {
      const active = readers.filter((reader) => reader.detect(root));

      if (active.length === 0) {
        return {
          providerId: PROVIDER_ID,
          providerVersion: PROVIDER_VERSION,
          rootName: root.name,
          records: emptyRecords(),
          gaps: [
            {
              kind: "route",
              language: ANY_LANGUAGE,
              reason: `no supported web framework (${readers.map((r) => r.id).join(", ")}) detected in this root`,
            },
          ],
          failures: [],
        };
      }

      const routes = [];
      const gaps: CapabilityGap[] = [];
      const failures = [];
      for (const reader of active) {
        const reading = reader.read(root);
        routes.push(...reading.routes);
        gaps.push(...reading.gaps);
        failures.push(...reading.failures);
      }

      return {
        providerId: PROVIDER_ID,
        providerVersion: PROVIDER_VERSION,
        rootName: root.name,
        records: { ...emptyRecords(), route: routes },
        gaps,
        failures,
      };
    },
  };
}
