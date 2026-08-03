/**
 * Splitting a spec into independently authorable chapters.
 *
 * A twelve-chapter report written in one pass is the wrong unit of work: the
 * output is enormous, a single failure loses everything, and there is no
 * parallelism to be had. Chapters are the natural seam — but only because the
 * claim layer exists. Every chapter draws on the same claim set, so two chapters
 * written by two workers cannot contradict each other; splitting does not cost
 * consistency, consistency is what makes splitting safe.
 *
 * Claims are deliberately NOT split this way. Two chapters asked to derive their
 * own conclusions would each invent a wording for the same finding; kinds, not
 * chapters, are the safe axis for that pass.
 */

import type { ReportSpec } from "./specs.js";

export interface SpecChapter {
  /** `1`, `9.2`, … as written in the spec, or a positional stand-in. */
  readonly number: string;
  /** Whether the spec itself numbered this heading. */
  readonly numbered: boolean;
  readonly title: string;
  /** Stable slug for the chapter's file. */
  readonly slug: string;
  /** The chapter's own text, which is all a worker needs beyond the contract. */
  readonly body: string;
}

const HEADING = /^## +(?:(\d+(?:\.\d+)*)\.? +)?(.+?)\s*$/;

function slugify(number: string, title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const prefix = number.replace(/\./g, "-").padStart(2, "0");
  return base.length === 0 ? `ch${prefix}` : `ch${prefix}-${base}`;
}

/**
 * Every `##` section of the spec body, in order.
 *
 * Reading layers and appendices are `##` too, so a caller filters by what it
 * wants rather than this guessing which headings are "real" chapters.
 */
export function chaptersOf(spec: ReportSpec): readonly SpecChapter[] {
  const lines = spec.body.split("\n");
  const chapters: SpecChapter[] = [];
  let current: { number: string; numbered: boolean; title: string; body: string[] } | null = null;
  for (const line of lines) {
    const match = HEADING.exec(line);
    if (match !== null) {
      if (current !== null) chapters.push(finish(current));
      current = {
        number: match[1] ?? String(chapters.length + 1),
        numbered: match[1] !== undefined,
        title: match[2] ?? "",
        body: [],
      };
      continue;
    }
    if (current !== null) current.body.push(line);
  }
  if (current !== null) chapters.push(finish(current));
  return chapters;
}

function finish(current: { number: string; numbered: boolean; title: string; body: string[] }): SpecChapter {
  return {
    number: current.number,
    numbered: current.numbered,
    title: current.title,
    slug: slugify(current.number, current.title),
    body: current.body.join("\n").trim(),
  };
}

/**
 * The chapters that become report sections.
 *
 * A spec numbers exactly the headings that are chapters. The appendix is a
 * pipeline gate and the reading-layer table is guidance for the author; neither
 * carries a number, so neither is authored.
 */
export function authorableChapters(spec: ReportSpec): readonly SpecChapter[] {
  return chaptersOf(spec).filter((chapter) => chapter.numbered);
}
