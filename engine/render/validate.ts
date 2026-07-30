/**
 * What an answer has to satisfy before it is spliced into a document.
 *
 * Checked without a model, so the checks are the ones that can be decided from
 * the text and the data slice: is there an answer, does it stay inside the
 * document's heading levels, is it within its length, does it cover every item
 * it was given. Whether a sentence is *true* of the code is not checkable here
 * — that is what keeping code sections and LLM sections apart is for.
 *
 * Citations are checked and reported as warnings rather than refusals: a
 * section that cites nothing is not wrong, but one citing a key that is not in
 * its own data slice has been written from somewhere else.
 */

import type { Contract } from "./template.js";

export interface AnswerProblem {
  readonly sectionId: string;
  readonly severity: "refusal" | "warning";
  readonly detail: string;
}

const HEADING = /^(#{1,6})\s+\S/gm;
const CITATION = /\[kb:([^\]]+)\]/g;
const FENCE = /^```[^\n]*\n[\s\S]*?^```/gm;

/** A `#` inside a fenced block is an example, not a heading. */
function headingLevels(answer: string): number[] {
  const prose = answer.replaceAll(FENCE, "");
  return [...prose.matchAll(HEADING)].map((match) => match[1]!.length);
}

export function countWords(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

/** Every string leaf of the data slice, for checking citations against it. */
function leaves(value: unknown, into: Set<string>): void {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const entry of value) leaves(entry, into);
  else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) leaves(entry, into);
  }
}

export function validateAnswer(
  sectionId: string,
  answer: string,
  contract: Contract,
  data: unknown,
): readonly AnswerProblem[] {
  const problems: AnswerProblem[] = [];
  const refuse = (detail: string): void => {
    problems.push({ sectionId, severity: "refusal", detail });
  };

  if (answer.trim() === "") {
    refuse("the answer file is empty");
    return problems;
  }

  if (answer.includes("<!-- llm:")) {
    // A marker inside an answer would nest a hole inside a filled one and
    // make the next assemble splice into the wrong place.
    refuse("the answer contains a section marker, which would corrupt the document");
  }

  if (contract.maxWords !== undefined) {
    const words = countWords(answer);
    if (words > contract.maxWords) {
      refuse(`${words} words, at most ${contract.maxWords} allowed`);
    }
  }

  const headings = headingLevels(answer);
  if (contract.maxHeadingLevel !== undefined) {
    const tooShallow = headings.filter((level) => level < contract.maxHeadingLevel!);
    if (tooShallow.length > 0) {
      refuse(
        `${tooShallow.length} heading(s) shallower than level ${contract.maxHeadingLevel}, which would outrank the document's own`,
      );
    }
  }

  if (contract.requiredHeadings !== undefined) {
    const expected = expectedCount(contract.requiredHeadings, data);
    // Counted at the shallowest level used. An answer that gives each item a
    // heading and then breaks it down with sub-headings satisfies "one per
    // item"; counting every heading refused it.
    const top = headings.length === 0 ? 0 : Math.min(...headings);
    const atTop = headings.filter((level) => level === top).length;
    if (expected !== null && atTop !== expected) {
      refuse(`${atTop} top-level headings for ${expected} items — one per item was asked for`);
    }
  }

  for (const line of undrawableDiagramLines(answer)) {
    // A diagram that does not draw is worse than none: the page shows its
    // source where a reader expects the picture the section is about.
    refuse(
      `a diagram label carries a quote inside a quoted label, which ends the label early and stops the diagram drawing: ${line}`,
    );
  }

  const cited = new Set([...answer.matchAll(CITATION)].map((match) => match[1]!));
  if (cited.size > 0) {
    const known = new Set<string>();
    leaves(data, known);
    for (const citation of cited) {
      if (!known.has(citation)) {
        problems.push({
          sectionId,
          severity: "warning",
          detail: `cites "${citation}", which is not in the data this section was given`,
        });
      }
    }
  }

  return problems;
}

/** `one-per:<selector>` — how many items the section was handed. */
function expectedCount(rule: string, data: unknown): number | null {
  const match = /^one-per:(.+)$/.exec(rule);
  if (match === null) return null;
  const value = (data as Record<string, unknown> | null)?.[match[1]!];
  return Array.isArray(value) ? value.length : null;
}

/**
 * Diagram lines a renderer will refuse.
 *
 * A quoted Mermaid label ends at its first `"`, so a label containing one is
 * cut short and the rest becomes syntax the parser cannot place. Found in a
 * Chinese report where a writer wrote `包含"今天"？` inside a label: the whole
 * flow rendered as source text.
 *
 * Detected by what follows a closing quote. After a label ends, only a shape's
 * own punctuation may follow — `}`, `]`, `)`, `|`, a comma, an arrow. Anything
 * else means the quote that looked like the end was not.
 */
export function undrawableDiagramLines(answer: string): readonly string[] {
  const offending: string[] = [];
  let inDiagram = false;

  for (const raw of answer.split("\n")) {
    if (/^\s*```/.test(raw)) {
      inDiagram = /^\s*```mermaid/.test(raw);
      continue;
    }
    if (!inDiagram || !raw.includes('"')) continue;

    const quotes = [...raw].reduce((count, char) => (char === '"' ? count + 1 : count), 0);
    if (quotes % 2 !== 0) {
      offending.push(raw.trim());
      continue;
    }
    // Walk the quoted runs; what comes after each closing quote decides.
    const pattern = /"[^"]*"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(raw)) !== null) {
      const after = raw.slice(match.index + match[0].length).trimStart();
      if (after !== "" && !/^[}\])|,;:>-]/.test(after)) {
        offending.push(raw.trim());
        break;
      }
    }
  }

  return offending;
}
