/**
 * The shared-fact contract's identity and version.
 *
 * The version is stamped onto every FactEnvelope. PI-56 defines how versions
 * change and migrate; this fixes the field and its first value.
 */

export const SHARED_FACT_CONTRACT_ID = "shared-fact";

/** Semantic version of the shared-fact contract. */
export const SHARED_FACT_CONTRACT_VERSION = "1.0.0";
