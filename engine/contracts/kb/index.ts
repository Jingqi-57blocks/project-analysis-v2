/**
 * The knowledge-base read contract: what a report-generating agent may read,
 * which layer each kind is served from, and which kinds cannot anchor an identity.
 */

import { readFileSync } from "node:fs";

export * from "./read-contract.js";

const GUIDE_URL = new URL("../../../skills/project-report/references/reading-the-kb.md", import.meta.url);

/** The reader-facing guide the skill loads. Prose, and part of the contract. */
export function loadKbContractGuide(): string {
  return readFileSync(GUIDE_URL, "utf8");
}
