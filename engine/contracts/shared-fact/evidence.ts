/**
 * The evidence behind a fact, and who supplied it.
 *
 * A merged fact keeps one EvidenceRecord per contributing provider, so its
 * provenance chain stays traceable: from the canonical fact back to each
 * original observation, with the provider and source that produced it.
 */

import type { RawIdentity } from "./identity.js";
import type { Provenance } from "./provenance.js";

export interface ProviderAttribution {
  readonly providerId: string;
  readonly providerVersion: string;
}

/**
 * One origin record behind a fact: which provider saw it, how it resolved and
 * where, and — where the provider has one — its native handle for it.
 */
export interface EvidenceRecord {
  readonly attribution: ProviderAttribution;
  readonly provenance: Provenance;
  readonly rawIdentity?: RawIdentity;
}

/** The providers whose evidence stands behind a fact, in first-seen order. */
export function contributingProviders(evidence: readonly EvidenceRecord[]): readonly string[] {
  const seen: string[] = [];
  for (const record of evidence) {
    if (!seen.includes(record.attribution.providerId)) seen.push(record.attribution.providerId);
  }
  return seen;
}
