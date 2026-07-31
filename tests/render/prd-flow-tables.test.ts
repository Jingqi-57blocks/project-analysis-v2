/**
 * The rules table and the flows section, row by row.
 *
 * Every assertion here was written after a review found the table stating something
 * the analysed project does not say.
 */

import { describe, expect, it } from "vitest";


import { FRAME_EN } from "../../engine/render/strings.js";

import { feature, guard, render } from "./prd-rows.js";

describe("the recovered specification's rule and flow tables", () => {
  it("says when a rule fires and where it is, not only what it says", () => {
    // A message alone cannot be reproduced, and cannot be gone and read either.
    const rendered = render("prd-validation", {
      guards: [guard("svc", "leave.go", "Not enough holiday.", "available < requested")] });
    expect(rendered).toContain("available < requested");
    expect(rendered).toContain("svc/leave.go");
  });

  it("does not rank rules by how often their message repeats", () => {
    // Ranking that way filled every row with a repeated message, hid 623 rules
    // stated once each, and let a repeated CSS value outrank a real rule.
    const many = Array.from({ length: 3 }, (_, n) =>
      guard("svc", `dup${n}.go`, "zzz repeated everywhere", "x"),
    );
    const one = guard("svc", "a.go", "aaa stated once", "y");
    const rendered = render("prd-validation", { guards: [...many, one] });
    expect(rendered.indexOf("aaa stated once")).toBeLessThan(
      rendered.indexOf("zzz repeated everywhere"),
    );
  });

  it("keeps each repository's rules under its own heading", () => {
    const rendered = render("prd-validation", {
      guards: [guard("api", "a.go", "Api rejects this.", "x"), guard("ui", "b.tsx", "Ui rejects this.", "y")] });
    expect(rendered).toContain("api");
    expect(rendered).toContain("ui");
  });

  it("states each condition on its own line, not joined into one trigger", () => {
    // `status === 0 · status === UserStatus.Inactive` are two mutually exclusive
    // checks in two files; under a column headed "When" they read as a conjunction
    // and a rebuild implements it.
    const rendered = render("prd-validation", {
      guards: [
        guard("svc", "a.go", "Add User", "status === 0"),
        guard("svc", "b.go", "Add User", "status === UserStatus.Inactive"),
      ] });
    expect(rendered).toContain("status === 0<br>status === UserStatus.Inactive");
    expect(rendered).not.toContain("·");
  });

  it("counts the conditions it does not show", () => {
    // 78 of WCP's messages have more than one distinct condition and one has
    // thirteen; past the second they were dropped with nothing said.
    const guards = Array.from({ length: 6 }, (_, n) =>
      guard("svc", `f${n}.go`, "Rejected.", `check${n}()`),
    );
    const rendered = render("prd-validation", { guards });
    const shown = [...rendered.matchAll(/check\d\(\)/g)].length;
    const more = Number(/and (\d+) more/.exec(rendered)?.[1] ?? 0);
    expect(shown + more).toBe(6);
    expect(more).toBeGreaterThan(0);
  });

  it("prints a rule enforced in two repositories under each of them", () => {
    // Filed under whichever file was walked first, WCP's password rules appeared
    // once, under a proposal-share modal, and never among the 493 rules of the
    // service that also enforces them.
    const rendered = render("prd-validation", {
      guards: [
        guard("ui", "Modal.tsx", "Password must be 6 digits long.", "!/^\\d{6}$/.test(value)"),
        guard("api", "service.go", "Password must be 6 digits long.", "len(p.Password) != 6"),
      ] });
    const rows = rendered.split("\n").filter((line) => line.includes("Password must be 6 digits"));
    expect(rows).toHaveLength(2);
    expect(rendered).toContain(FRAME_EN["also-in-other-repositories"]!.replace("{0}", "1"));
  });

  it("shows only the conditions the repository under the heading states", () => {
    // The cross-root union printed wcp-service-v2's Go whitelist under
    // wcp_review_service's heading, where the allowed set is a different one.
    const rendered = render("prd-validation", {
      guards: [
        guard("ui", "Modal.tsx", "sort params is invalid", 'sortable.includes("full_name")'),
        guard("api", "service.go", "sort params is invalid", 'sortable.includes("status")'),
      ] });
    const uiRow = rendered.split("\n").find((line) => line.includes("Modal.tsx"))!;
    const apiRow = rendered.split("\n").find((line) => line.includes("service.go"))!;
    expect(uiRow).toContain("full_name");
    expect(uiRow).not.toContain("status");
    expect(apiRow).toContain("status");
    expect(apiRow).not.toContain("full_name");
  });

  it("names only this repository's files under its heading", () => {
    const rendered = render("prd-validation", {
      guards: [
        guard("ui", "Modal.tsx", "Shared rejection.", "x"),
        guard("api", "service.go", "Shared rejection.", "y"),
      ] });
    const uiRow = rendered.split("\n").find((line) => line.includes("Modal.tsx"))!;
    expect(uiRow).not.toContain("service.go");
  });

  it("prints every rule a repository states on this scale", () => {
    // The cap was 400 against a service holding 493 distinct messages, so the
    // document shipped ending that table with 93 of its rules absent.
    const guards = Array.from({ length: 493 }, (_, n) =>
      guard("svc", `f${n}.go`, `Rejection number ${String(n).padStart(3, "0")}.`, `c${n}()`),
    );
    const rendered = render("prd-validation", { guards });
    expect(rendered).toContain("Rejection number 492.");
    expect(rendered).not.toMatch(/^and \d+ more$/m);
  });

  function flow(
    featureId: string,
    entry: string,
    options: { partial?: boolean; vague?: number; steps?: number } = {},
  ) {
    const steps = Array.from({ length: options.steps ?? 2 }, (_, n) => ({
      kind: n === 0 ? "entry" : "data-access",
      label: `step${n}`,
      conditions: [],
      unresolvedReason: null,
      indirect: n > 0 && n <= (options.vague ?? 0) }));
    return {
      featureId,
      entryKey: entry,
      partial: options.partial ?? false,
      steps,
      diagram: `flowchart LR\n  s0["${entry}"]` };
  }

  it("draws the traced flows themselves, not numbers about the analysis", () => {
    // The section rendered how much of each capability had been followed — two
    // numbers about the analysis, under a heading promising the system's behaviour.
    const rendered = render("prd-flows", {
      flows: [flow("feat_Leave", "svc:POST /leaves")],
      features: [feature("Leave", 1)] });
    expect(rendered).toContain("```mermaid");
    expect(rendered).toContain("svc:POST /leaves");
  });

  it("does not claim the drawn flows rest on the handler alone", () => {
    // 14 of the 16 drawn against WCP carry a step observed only in the handler's
    // package, and every such edge says so three lines above this sentence. Three
    // flows, so the line that carried the claim is actually emitted — with one it
    // never was, and this assertion passed against the wording it rejects.
    const rendered = render("prd-flows", {
      flows: [
        flow("feat_Leave", "svc:GET /a", { vague: 2, steps: 3 }),
        flow("feat_Leave", "svc:GET /b", { vague: 2, steps: 3 }),
        flow("feat_Leave", "svc:GET /c", { vague: 2, steps: 3 }),
      ],
      features: [feature("Leave", 3)] });
    expect(rendered).toContain("traced flow(s) are not drawn");
    expect(rendered).not.toContain("established in the handler itself");
    // And says a gap is what puts a flow last, not only where its steps came from.
    expect(rendered).toContain("no gap in it");
  });

  it("counts how many drawn flows rest on package evidence, rather than asserting it", () => {
    // "Most flows here have at least one such step" was counted by hand, once,
    // against one target, and asserted for every render after.
    const rendered = render("prd-flows", {
      flows: [
        flow("feat_A", "svc:GET /a", { vague: 1, steps: 3 }),
        flow("feat_B", "svc:GET /b", { vague: 0, steps: 3 }),
      ],
      features: [feature("A", 1), feature("B", 1)] });
    expect(rendered).toContain("2 traced flows");
    expect(rendered).toContain("1 of those drawn carry at least one step");
  });

  it("says whether any drawn flow has a gap, having looked", () => {
    const whole = render("prd-flows", {
      flows: [flow("feat_A", "svc:GET /a")],
      features: [feature("A", 1)] });
    expect(whole).toContain("None of them has a gap");

    const gapped = render("prd-flows", {
      flows: [flow("feat_A", "svc:GET /a", { partial: true })],
      features: [feature("A", 1)] });
    expect(gapped).toContain("1 of them still has a gap");
    expect(gapped).not.toContain("None of them has a gap");
  });

  it("draws a complete trace before one with a gap", () => {
    const rendered = render("prd-flows", {
      flows: [
        flow("feat_Leave", "svc:GET /partial", { partial: true }),
        flow("feat_Leave", "svc:GET /whole"),
      ],
      features: [feature("Leave", 2)] });
    expect(rendered.indexOf("/whole")).toBeLessThan(rendered.indexOf("/partial"));
  });

  it("draws a trace observed in the handler before one observed in its package", () => {
    // The section opened on a delete endpoint drawn against 13 tables, every edge
    // dotted and labelled "observed in the handler's package". Same step count on
    // both, or the shorter-trace tiebreak would order them without this rule.
    const rendered = render("prd-flows", {
      flows: [
        // Named so that alphabetical order opposes the rule under test: without
        // the package-scope term, the entry-key tiebreak alone would order these
        // correctly and the assertion would hold for the wrong reason.
        flow("feat_Leave", "svc:GET /a-vague", { vague: 3, steps: 4 }),
        flow("feat_Leave", "svc:GET /z-crisp", { vague: 0, steps: 4 }),
      ],
      features: [feature("Leave", 2)] });
    expect(rendered.indexOf("/z-crisp")).toBeLessThan(rendered.indexOf("/a-vague"));
  });

  it("draws at most a couple of flows for one capability", () => {
    // A diagram is a page each: WCP's Review capability alone has 55 flows, and
    // drawing them all is how the section came to 2,068 lines.
    const flows = Array.from({ length: 9 }, (_, n) => flow("feat_Leave", `svc:GET /f${n}`));
    const rendered = render("prd-flows", { flows, features: [feature("Leave", 9)] });
    expect(rendered.split("```mermaid").length - 1).toBeLessThan(4);
  });

  it("says how many capabilities with flows have no diagram", () => {
    // 28 of WCP's 36 capabilities with traced flows vanished from a section whose
    // lead read as covering all of them.
    const features = Array.from({ length: 20 }, (_, n) => feature(`Cap${n}`, n + 1));
    const flows = features.map((f) => flow(f.id, `svc:GET /${f.name}`));
    const rendered = render("prd-flows", { flows, features });
    const drawnCaps = [...rendered.matchAll(/^\*\*Cap\d+\*\*/gm)].length;
    const said = Number(/(\d+) of the 20 capabilities with a traced flow/.exec(rendered)?.[1] ?? 0);
    expect(drawnCaps + said).toBe(20);
    expect(said).toBeGreaterThan(0);
    // Enough of them to be a section: the accounting holds for a bound of one too.
    expect(drawnCaps).toBeGreaterThan(4);
  });

  it("draws flows for some capabilities, not for forty-eight", () => {
    const features = Array.from({ length: 20 }, (_, n) => feature(`Cap${n}`, n + 1));
    const flows = features.map((f) => flow(f.id, `svc:GET /${f.name}`));
    const rendered = render("prd-flows", { flows, features });
    const drawn = rendered.split("```mermaid").length - 1;
    expect(drawn).toBeLessThan(features.length);
    expect(drawn).toBeGreaterThan(0);
    // And what is left out is still accounted for.
    expect(Number(/(\d+) of 20 traced flow/.exec(rendered)?.[1] ?? 0)).toBe(features.length - drawn);
  });

  it("accounts for every flow it does not draw", () => {
    const flows = Array.from({ length: 9 }, (_, n) => flow("feat_Leave", `svc:GET /f${n}`));
    const rendered = render("prd-flows", { flows, features: [feature("Leave", 9)] });
    const drawn = rendered.split("```mermaid").length - 1;
    const left = Number(/(\d+) of 9 traced flow/.exec(rendered)?.[1] ?? 0);
    expect(drawn + left).toBe(9);
    expect(drawn).toBeGreaterThan(0);
  });

  it("counts a capability's partial flows, and does not call them established", () => {
    const rendered = render("prd-flows", {
      flows: [flow("feat_Leave", "svc:GET /a", { partial: true }), flow("feat_Leave", "svc:GET /b")],
      features: [feature("Leave", 2)] });
    expect(rendered).toContain(
      FRAME_EN["prd-flow-partial"]!.replace("{0}", "1").replace("{1}", "2"),
    );
    expect(rendered).not.toContain("every step established");
  });

  it("says every step was established where none is missing", () => {
    const rendered = render("prd-flows", {
      flows: [flow("feat_Leave", "svc:GET /a"), flow("feat_Leave", "svc:GET /b")],
      features: [feature("Leave", 2)] });
    expect(rendered).toContain(FRAME_EN["prd-flow-whole"]!.replace("{0}", "2"));
    expect(rendered).not.toContain("could not be resolved");
  });

  it("says a capability has no entry point rather than no traceable chain", () => {
    // All 12 of WCP's flowless capabilities have no endpoint at all, so "an entry
    // point was found, but no call chain could be followed" was wrong for every
    // one of them — and this run had call-edge extraction switched off besides.
    const rendered = render("prd-flows", {
      flows: [flow("feat_Leave", "svc:GET /a")],
      features: [feature("Leave", 1), feature("Vocabulary", 0)] });
    expect(rendered).toContain("no entry point was attributed");
    expect(rendered).not.toContain("no call chain");
  });

  it("separates a capability with an entry point but no flow from one with neither", () => {
    const rendered = render("prd-flows", {
      flows: [flow("feat_Leave", "svc:GET /a")],
      features: [feature("Leave", 1), feature("Silent", 4), feature("Vocabulary", 0)] });
    expect(rendered).toContain("no entry point was attributed");
    expect(rendered).toContain("have an entry point but no flow traced");
  });

  it("names the endpoints no capability claimed", () => {
    // 65 of WCP's 539 endpoints belonged to no capability and appeared nowhere in
    // a document meant to be built from.
    const rendered = render("prd-features", {
      features: [feature("Leave", 1)],
      endpoints: [
        { method: "GET", path: "/leave/0", rootName: "svc", middleware: [], handlerName: null },
        { method: "POST", path: "/cronjobs", rootName: "svc", middleware: [], handlerName: null },
      ] });
    expect(rendered).toContain("/cronjobs");
    expect(rendered).toContain("1 of 2 endpoints belong to no capability");
  });

  it("marks an absent address with a dash, as every other absence is marked", () => {
    // A capability detected from vocabulary alone has no address, and the cell was
    // rendered empty where the rest of the document writes an em dash.
    const rendered = render("prd-features", {
      features: [feature("Vocabulary", 0)],
      endpoints: [] });
    // By position: the endpoint-count cell is a dash too, so a bare `contains`
    // passed while the addresses cell rendered blank.
    const cells = rendered
      .split("\n")
      .find((line) => line.includes("Vocabulary"))!
      .split("|")
      .map((part) => part.trim());
    expect(cells[4]).toBe("—");
  });

  it("says nothing about orphan endpoints where every one is claimed", () => {
    const rendered = render("prd-features", {
      features: [feature("Leave", 1)],
      endpoints: [
        { method: "GET", path: "/leave/0", rootName: "svc", middleware: [], handlerName: null },
      ] });
    expect(rendered).not.toContain("belong to no capability");
  });

  it("says when one message is thrown in one place and returned in another", () => {
    // One of WCP's 682 rules is stated both ways, and a single label for the pair
    // would have called it whichever the walk met first.
    const rendered = render("prd-validation", {
      guards: [
        { ...guard("svc", "a.go", "start_date must be on or before end_date", "x"), exit: "throw" },
        { ...guard("svc", "b.js", "start_date must be on or before end_date", "y"), exit: "return" },
      ] });
    expect(rendered).toContain(FRAME_EN["exit-return-and-throw"]!);
  });

  it("labels how a rule was stated through the frame", () => {
    const rendered = render("prd-validation", {
      guards: [{ ...guard("svc", "a.go", "ErrNope", "x"), messageKind: "error-code" }] });
    expect(rendered).toContain(FRAME_EN["message-kind-error-code"]);
    expect(rendered).not.toContain("error-code |");
  });
});
