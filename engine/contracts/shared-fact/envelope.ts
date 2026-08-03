/**
 * The common envelope every fact wears, whatever its family.
 *
 * Structural, behavioural, diagnostic and coverage facts differ in their
 * payload but share how they are identified, cited and versioned. A report
 * cites the envelope; the payload is what the citation is about.
 */

import type { EvidenceRecord } from "./evidence.js";
import type { FactFamily, FactKind } from "./families.js";
import type { FactId, RawIdentity } from "./identity.js";

export interface FactEnvelope<TPayload = unknown> {
  readonly factId: FactId;
  readonly family: FactFamily;
  readonly kind: FactKind;
  /**
   * The shared-fact contract version this envelope conforms to. A field, not
   * part of factId, so a compatible version bump never churns identity.
   */
  readonly schemaVersion: string;
  /** The provenance chain: every provider's evidence for this one fact. */
  readonly evidence: readonly EvidenceRecord[];
  /** Provider-native handles seen for this fact, kept beside the canonical id. */
  readonly rawIdentities: readonly RawIdentity[];
  readonly payload: TPayload;
}
