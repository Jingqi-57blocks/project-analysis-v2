import { describe, expect, it } from "vitest";

import { parseTemplate, TemplateError, loadTemplate } from "../../engine/render/template.js";
import { selectorNames } from "../../engine/render/selectors.js";
import { fragmentNames, hasFragment } from "../../engine/render/fragments.js";

function json(value: unknown): string {
  return JSON.stringify(value);
}

const MINIMAL = {
  id: "t",
  title: "T",
  sections: [{ id: "a", kind: "code", fragment: "limitations", requires: ["coverage-notes"] }],
};

describe("reading a template", () => {
  it("reads sections in the order they are written", () => {
    const template = parseTemplate(
      json({
        ...MINIMAL,
        sections: [
          MINIMAL.sections[0],
          { id: "b", kind: "llm", prompt: "p.md", heading: "B", requires: [] },
        ],
      }),
      "/t",
    );
    expect(template.sections.map((section) => section.id)).toEqual(["a", "b"]);
    expect(template.sections[1]!.kind).toBe("llm");
  });

  it("refuses two sections sharing an id", () => {
    // Ids name the splice markers and the task directories; two of them would
    // overwrite each other's answers.
    expect(() =>
      parseTemplate(json({ ...MINIMAL, sections: [MINIMAL.sections[0], MINIMAL.sections[0]] }), "/t"),
    ).toThrow(TemplateError);
  });

  it("refuses a section that is neither code nor an llm prompt", () => {
    expect(() =>
      parseTemplate(json({ ...MINIMAL, sections: [{ id: "a", kind: "magic" }] }), "/t"),
    ).toThrow(/expected "code" or "llm"/);
  });

  it("refuses a template with no sections", () => {
    expect(() => parseTemplate(json({ id: "t", title: "T", sections: [] }), "/t")).toThrow(
      TemplateError,
    );
  });

  it("says where it looked when there is no template there", () => {
    expect(() => loadTemplate("/nowhere/at/all")).toThrow(/template.json/);
  });
});

describe("the shipped templates", () => {
  for (const id of ["overview", "module"]) {
    it(`${id} names only selectors and fragments that exist`, () => {
      // A template naming something unknown fails at prepare time, in front of
      // a user, with a knowledge base already built.
      const template = loadTemplate(id);
      for (const section of template.sections) {
        for (const selector of section.requires) {
          const name = selector.split(":")[0]!;
          expect(selectorNames(), `${section.id} requires ${selector}`).toContain(name);
        }
        if (section.kind === "code") {
          expect(hasFragment(section.fragment), `${section.id} → ${section.fragment}`).toBe(true);
        }
      }
    });

    it(`${id} states its limitations and never omits them`, () => {
      // The honesty section cannot be conditional on there being room for it.
      const template = loadTemplate(id);
      const limitations = template.sections.find((section) => section.id === "limitations");
      expect(limitations?.kind).toBe("code");
      expect(limitations?.omitWhenEmpty).toBeUndefined();
    });
  }

  it("keeps every fragment reachable from some template", () => {
    const used = new Set(
      ["overview", "module"].flatMap((id) =>
        loadTemplate(id)
          .sections.filter((section) => section.kind === "code")
          .map((section) => (section as { fragment: string }).fragment),
      ),
    );
    const orphaned = fragmentNames().filter((name) => !used.has(name));
    // `endpoints-table` is offered to user-written templates rather than used
    // by a shipped one; anything else unreferenced is probably a mistake.
    expect(orphaned).toEqual(["endpoints-table"]);
  });
});
