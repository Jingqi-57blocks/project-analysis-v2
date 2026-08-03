import { describe, expect, it } from "vitest";

import { authorableChapters, chaptersOf } from "../../../engine/contracts/report/chapters.js";
import { loadSpecRegistry } from "../../../engine/contracts/report/specs.js";

const registry = loadSpecRegistry();
const spec = (id: string) => registry.specs.find((entry) => entry.id === id)!;

describe("splitting a spec into chapters", () => {
  it("authors only the headings the spec numbered", () => {
    // The reading-layer table is guidance for the author and the appendix is a
    // pipeline gate; neither carries a number, so neither becomes a section.
    const all = chaptersOf(spec("project-product"));
    const authorable = authorableChapters(spec("project-product"));
    expect(all.length).toBeGreaterThan(authorable.length);
    for (const chapter of authorable) expect(chapter.numbered).toBe(true);
    expect(authorable.map((chapter) => chapter.number)).toEqual(
      Array.from({ length: 12 }, (_, index) => String(index + 1)),
    );
  });

  it("covers the module spec's thirteen chapters", () => {
    expect(authorableChapters(spec("module-product")).map((chapter) => chapter.number)).toEqual(
      Array.from({ length: 13 }, (_, index) => String(index + 1)),
    );
  });

  it("gives every chapter a distinct, ordered slug", () => {
    for (const id of ["project-product", "module-product", "project-developer", "module-developer"]) {
      const slugs = authorableChapters(spec(id)).map((chapter) => chapter.slug);
      expect({ id, distinct: new Set(slugs).size }).toEqual({ id, distinct: slugs.length });
      expect(slugs).toEqual([...slugs].sort());
    }
  });

  it("carries each chapter's own text, which is all a worker needs", () => {
    const flows = authorableChapters(spec("module-product")).find((chapter) => chapter.number === "2");
    expect(flows?.title).toContain("flows");
    expect(flows?.body).toContain("MUST NOT");
    expect(flows?.body).not.toContain("## 3.");
  });

  it("does not lose a chapter's trailing content to the next heading", () => {
    const chapters = chaptersOf(spec("project-product"));
    for (const chapter of chapters) expect(chapter.body).not.toMatch(/^## /m);
  });
});
