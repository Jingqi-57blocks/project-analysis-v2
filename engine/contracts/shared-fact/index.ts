/**
 * The shared-fact contract: how every fact in the system is identified, cited,
 * resolved and versioned, independent of the report that will read it.
 *
 * PI-54 owns identity, evidence, provenance and resolution. PI-55 (confidence,
 * activation, gap, applicability) and PI-56 (merge, conflict, schema version)
 * extend this same module; PI-75 assembles it into the M0 contract bundle.
 */

export * from "./serialization.js";
export * from "./families.js";
export * from "./provenance.js";
export * from "./confidence.js";
export * from "./activation.js";
export * from "./applicability.js";
export * from "./identity.js";
export * from "./evidence.js";
export * from "./envelope.js";
export * from "./merge.js";
export * from "./versioning.js";
export * from "./version.js";
export * from "./examples.js";
