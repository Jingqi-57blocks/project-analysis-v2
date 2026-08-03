/**
 * The authored block-content renderer (PI-21/22 step 2): the `BlockContent` seam
 * `renderReport` reads, for a run whose authored blocks carry real, grounded prose.
 *
 * For an authored block whose task is in the prose store it renders the prose plus a
 * citations footnote — each cited fact expanded from its `[n]` (or raw `[factId]`)
 * marker to the real fact id and its `root/relPath:line` source location, so a
 * reader can walk every claim back to a checkable fact. For every other block — a
 * deterministic block, an unauthored/gapped authored block, or a structured
 * disclosure — it delegates to the `fallback` content (the deterministic fact
 * digest), so those blocks render exactly as before.
 *
 * Pure over the prose store and the fallback: the same inputs give byte-identical
 * output. The prose bytes themselves vary with the model; the citations footnote is
 * derived from the grounded fact set, which the reproducibility manifest gates on.
 */

import type { AssembledBlock } from "./assemble.js";
import type { BlockContent } from "./render.js";
import type { ProseArtifact, ProseStore } from "./authoring-host.js";
import { citationLabel } from "./author-prompt.js";

/**
 * Render an accepted authored block: its prose, then a citations footnote listing
 * each grounded fact by its digest index, its fact id and its source location. Facts
 * are listed in digest order; a fact is listed only when the prose actually cited it.
 */
function renderAuthored(artifact: ProseArtifact): string {
  const grounded = new Set(artifact.groundedFactIds);
  const footnotes = artifact.facts
    .map((fact, i) => ({ fact, index: i + 1 }))
    .filter(({ fact }) => grounded.has(fact.factId))
    .map(({ fact, index }) => `- [${index}] ${fact.factId} — ${citationLabel(fact.citation)}`);
  const body = artifact.prose.trimEnd();
  if (footnotes.length === 0) return body;
  return [body, "", "_Citations:_", ...footnotes].join("\n");
}

/**
 * Build the authored `BlockContent`. A block whose task produced grounded prose
 * renders that prose with a citations footnote; every other block delegates to the
 * deterministic `fallback`. Deterministic over the store and the fallback.
 */
export function authoredContent(proseStore: ProseStore, fallback: BlockContent): BlockContent {
  return (documentId: string, block: AssembledBlock): string => {
    if (block.taskId !== null) {
      const artifact = proseStore.get(block.taskId);
      if (artifact !== undefined) return renderAuthored(artifact);
    }
    return fallback(documentId, block);
  };
}
