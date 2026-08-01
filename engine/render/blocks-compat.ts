/**
 * The bridge from the old template model to the pipeline's block model.
 *
 * The report pipeline (PI-14) is not a parallel render stack: it evolves this
 * one. A legacy `CodeSection` is a single `deterministic` block and a legacy
 * `LlmSection` is a single `authored-required` block — the same content, named
 * in the pipeline's vocabulary. The mapping is 1:1 and keeps the section's id,
 * so a template's output identity does not move when it is read as blocks; only
 * an explicit preset or generator version bump changes what it produces.
 *
 * The direction is render → contract: this module depends on the contract, never
 * the other way, so the contract stays a leaf.
 */

import { type ContentBlock, authoredBlock, deterministicBlock } from "../contracts/report/blocks.js";
import type { Section } from "./template.js";

/**
 * The single block a legacy section maps to. A `code` section renders from facts
 * by code (deterministic); an `llm` section is prose the host writes and cites
 * (authored-required). The block keeps the section's id, so nothing downstream
 * that keys on it has to move.
 *
 * The legacy model does not carry fact-kind bounds or an output-schema id — it
 * predates them — so the block reads the open slice (`*`) and names its schema
 * after the section. A migrated template that adopts a preset declares real
 * bounds and schemas there; this preserves behaviour until it does.
 */
export function blockFromLegacySection(section: Section): ContentBlock {
  if (section.kind === "code") {
    return deterministicBlock(section.id, ["*"], `${section.id}.legacy`);
  }
  return authoredBlock(section.id, ["*"], `${section.id}.legacy`);
}
