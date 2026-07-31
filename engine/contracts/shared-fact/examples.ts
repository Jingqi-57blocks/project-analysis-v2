/**
 * Machine-readable positive and negative examples of the shared-fact contract.
 *
 * The contract tests consume these, and PI-75 folds them into the M0 contract
 * bundle's fixtures — so the same examples that document the contract here are
 * the ones a downstream verifier replays.
 */

import type { EvidenceRecord } from "./evidence.js";
import type { FactEnvelope } from "./envelope.js";
import { factId } from "./identity.js";
import { declared, lineRef, resolved } from "./provenance.js";
import { SHARED_FACT_CONTRACT_VERSION } from "./version.js";

/**
 * A structural symbol fact both a source reader and CodeGraph found: one
 * canonical id, two evidence records, two raw identities.
 */
export const VALID_ENVELOPE_EXAMPLE: FactEnvelope<{ readonly qualifiedName: string }> = {
  factId: factId({
    family: "structural",
    kind: "symbol",
    discriminators: ["api", "leave/service.go", "func", "Service.RequestLeave"],
  }),
  family: "structural",
  kind: "symbol",
  schemaVersion: SHARED_FACT_CONTRACT_VERSION,
  evidence: [
    {
      attribution: { providerId: "sourcefiles", providerVersion: "1.0.0" },
      provenance: declared(lineRef("api", "leave/service.go", 42)),
      rawIdentity: { providerId: "sourcefiles", nativeId: "leave/service.go#42" },
    },
    {
      attribution: { providerId: "codegraph", providerVersion: "1.0.0" },
      provenance: resolved(lineRef("api", "leave/service.go", 42), "high"),
      rawIdentity: { providerId: "codegraph", nativeId: "node:918273" },
    },
  ],
  rawIdentities: [
    { providerId: "sourcefiles", nativeId: "leave/service.go#42" },
    { providerId: "codegraph", nativeId: "node:918273" },
  ],
  payload: { qualifiedName: "Service.RequestLeave" },
};

/** Provenance shapes a validator must reject, each with why it is invalid. */
export const INVALID_PROVENANCE_EXAMPLES: readonly {
  readonly why: string;
  readonly value: unknown;
}[] = [
  {
    why: "a declared fact carrying a confidence",
    value: {
      resolutionClass: "declared",
      source: lineRef("api", "leave/service.go", 42),
      confidence: "high",
    },
  },
  {
    why: "an unresolved fact with no reason",
    value: { resolutionClass: "unresolved", source: lineRef("api", "leave/service.go", 42) },
  },
  {
    why: "an inferred fact with no confidence",
    value: { resolutionClass: "inferred", source: lineRef("api", "leave/service.go", 42) },
  },
  {
    why: "a confidence supplied in place of a resolution class",
    value: { confidence: "high", source: lineRef("api", "leave/service.go", 42) },
  },
];

/** One EvidenceRecord, exported for reuse by chain-traceability tests. */
export const SINGLE_EVIDENCE_EXAMPLE: EvidenceRecord = {
  attribution: { providerId: "logic", providerVersion: "1.0.0" },
  provenance: resolved(lineRef("api", "leave/approve.go", 88), "medium"),
};
