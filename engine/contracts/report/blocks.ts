/**
 * The unit of generation responsibility inside a section.
 *
 * A section is reader structure; it is not one AI call. Each section is an
 * ordered list of ContentBlocks, and every block is one of two kinds:
 *
 * - `deterministic` — tables, lists, diagrams, indexes, exact counts,
 *   citations, coverage, gaps and the three-state disclosure. Derived from
 *   facts by code; the AI owns none of it.
 * - `authored-required` — audience explanation, flow/rule summarisation,
 *   responsibility and evidenced impact. The Host Agent writes the prose but
 *   does not own the underlying fact values, and must cite them.
 *
 * There is no `ai-optional`. Content not needed for a reader to understand the
 * system is left out of the preset entirely, rather than generated on spec.
 */

import type { FactKind } from "../shared-fact/families.js";

export type BlockKind = "deterministic" | "authored-required";

export interface ContentBlock {
  readonly id: string;
  readonly kind: BlockKind;
  /** The fact kinds this block reads; its content is bounded to these. */
  readonly inputFactKinds: readonly FactKind[];
  /** Identifier of the output schema this block must satisfy (defined in M3). */
  readonly outputSchemaId: string;
  /**
   * A block whose claim is shared across documents — the same fact ID and
   * citation wherever it appears, product or developer.
   */
  readonly carriesSharedClaim: boolean;
}

export function deterministicBlock(
  id: string,
  inputFactKinds: readonly FactKind[],
  outputSchemaId: string,
  carriesSharedClaim = false,
): ContentBlock {
  return { id, kind: "deterministic", inputFactKinds, outputSchemaId, carriesSharedClaim };
}

export function authoredBlock(
  id: string,
  inputFactKinds: readonly FactKind[],
  outputSchemaId: string,
  carriesSharedClaim = false,
): ContentBlock {
  return { id, kind: "authored-required", inputFactKinds, outputSchemaId, carriesSharedClaim };
}
