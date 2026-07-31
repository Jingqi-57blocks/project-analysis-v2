/**
 * Provenance now lives in the shared-fact contract (PI-54). This module
 * re-exports it unchanged so the many callers importing
 * `../structural/provenance.js` keep working while there is a single canonical
 * definition — the structural layer is an adapter onto the contract, not a
 * parallel copy of it.
 */

export * from "../contracts/shared-fact/provenance.js";
