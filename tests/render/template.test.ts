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

describe("a fragment gets what its section was told to require", () => {
  // The check CI was missing: a template can name a real fragment and a real
  // selector and still hand the fragment nothing it reads, because a
  // parameterized selector is keyed with its argument.
  const READS: Readonly<Record<string, readonly string[]>> = {
    "project-summary": ["run-context"],
    "project-map": ["run-context", "map-edges"],
    "features-table": ["features"],
    "screens-table": ["screens"],
    "endpoints-table": ["endpoints"],
    "data-model": ["module-entities", "entity-models"],
    "rules-table": ["module-rules", "feature-rules", "business-rules"],
    "value-sets": ["value-sets"],
    flows: ["module-flows", "feature-flows"],
    "findings-table": ["structural-findings", "module-findings", "feature-findings"],
    "signals-table": ["signals"],
    "module-surface": ["module-detail"],
    limitations: ["coverage-notes", "extraction-failures"],
  };

  for (const id of ["overview", "module"]) {
    it(`${id} gives every code section a selector its fragment reads`, () => {
      for (const section of loadTemplate(id).sections) {
        if (section.kind !== "code") continue;
        const reads = READS[section.fragment];
        expect(reads, `no expectation recorded for ${section.fragment}`).toBeDefined();
        const bases = section.requires.map((selector) => selector.split(":")[0]!);
        expect(
          reads!.some((name) => bases.includes(name)),
          `${section.id} requires [${bases.join(", ")}] but ${section.fragment} reads [${reads!.join(", ")}]`,
        ).toBe(true);
      }
    });
  }
});

describe("contracts are checked when the template is read", () => {
  it("refuses a word limit that is not a number", () => {
    // `100 > "ten"` is NaN-false, so the check silently does nothing.
    expect(() =>
      parseTemplate(
        json({
          id: "t",
          title: "T",
          sections: [
            { id: "a", kind: "llm", prompt: "p.md", requires: [], contract: { maxWords: "ten" } },
          ],
        }),
        "/t",
      ),
    ).toThrow(/positive whole number/);
  });

  it("refuses a null heading level", () => {
    expect(() =>
      parseTemplate(
        json({
          id: "t",
          title: "T",
          sections: [
            { id: "a", kind: "llm", prompt: "p.md", requires: [], contract: { maxHeadingLevel: null } },
          ],
        }),
        "/t",
      ),
    ).toThrow(/positive whole number/);
  });

  it("refuses a section id that would escape its directory", () => {
    expect(() =>
      parseTemplate(json({ id: "t", title: "T", sections: [{ id: "../../escaped", kind: "code", fragment: "limitations" }] }), "/t"),
    ).toThrow(/only letters, digits/);
  });

  it("refuses a section id that would break the marker comment", () => {
    expect(() =>
      parseTemplate(json({ id: "t", title: "T", sections: [{ id: "a-->b", kind: "code", fragment: "limitations" }] }), "/t"),
    ).toThrow(/only letters, digits/);
  });
});
