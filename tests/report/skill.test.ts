import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { availableCombinations, loadSpecRegistry } from "../../engine/contracts/report/specs.js";

const SKILL = new URL("../../.claude/skills/project-report/SKILL.md", import.meta.url);
const body = readFileSync(SKILL, "utf8");

describe("the report skill", () => {
  it("declares itself with a name and a description", () => {
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toMatch(/^name: project-report$/m);
    expect(body).toMatch(/^description: .+/m);
  });

  it("points at contract paths that exist, rather than copying them", () => {
    // A copy under the skill would be a second source of truth, outside the
    // drift gate, and would diverge on the first one-sided edit.
    const referenced = [...body.matchAll(/`(?:<repoRoot>\/)?(engine\/contracts\/[\w./<>-]+\.md)`/g)].map(
      (match) => match[1] ?? "",
    );
    expect(referenced.length).toBeGreaterThan(0);
    for (const path of new Set(referenced)) {
      const concrete = path.replace("<specId>", "project-product");
      expect({ path, exists: existsSync(new URL(`../../${concrete}`, import.meta.url)) }).toEqual({
        path,
        exists: true,
      });
    }
  });

  it("anchors the contract paths to the repository, not to its own directory", () => {
    // Given them bare, the agent resolved them against .claude/skills/ and three
    // reads came back empty.
    expect(body).toContain("<repoRoot>/engine/contracts/kb/kb-contract.md");
    expect(body).toMatch(/relative to it|resolve them against `repoRoot`/);
  });

  it("does not enumerate the scope × audience combinations", () => {
    // Adding a report type must be adding a spec file, not editing the skill.
    for (const combination of availableCombinations(loadSpecRegistry())) {
      expect(body).not.toContain(combination);
    }
    expect(body).toContain("<specId>");
  });

  it("loads one spec, not all four", () => {
    expect(body).toMatch(/MUST NOT\*{0,2} read the other specs/);
  });

  it("forbids reading the analysed project's source in the strongest terms", () => {
    expect(body).toMatch(/MUST NOT\*{0,2} read the analysed project's source/);
  });

  it("requires walking every kind before writing", () => {
    expect(body).toMatch(/MUST\*{0,2} open every kind/);
    expect(body).toContain("coverage-note");
    expect(body).toContain("structural-finding");
    expect(body).toContain("health-signal");
  });

  it("carries the writing rules the contract enforces", () => {
    // The distinction the report lives or dies on: say what the system does,
    // never what to do about it.
    expect(body).toMatch(/Say what the system does/);
    expect(body).toMatch(/MUST NOT\*{0,2}\s*\n?\s*write design intent/);
    expect(body).toContain("inferred");
  });

  it("names one place for intermediates, so nothing is left scattered", () => {
    expect(body).toMatch(/Every file you write that is not an output goes under `scratchPath`/);
  });

  it("ends with a checklist the run can be held to", () => {
    const boxes = body.match(/^- \[ \] /gm) ?? [];
    expect(boxes.length).toBeGreaterThanOrEqual(8);
  });

  it("names every input it needs, so a missing one stops the run", () => {
    for (const input of ["packDb", "specId", "language", "reportPath", "scratchPath"]) {
      expect(body).toContain(input);
    }
  });
});
