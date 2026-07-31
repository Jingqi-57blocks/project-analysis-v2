/**
 * The capabilities table and the page map, row by row.
 */

import { describe, expect, it } from "vitest";


import { FRAME_EN } from "../../engine/render/strings.js";

import { feature, screen, render } from "./prd-rows.js";

describe("the recovered specification's capability tables", () => {
  it("numbers capabilities by surface area, widest first, zero-padded", () => {
    // Named against alphabetical order deliberately: `Large/Middle/Small` sorts the
    // same way under both rules, so the assertion held under pure alphabetical.
    const rendered = render("prd-features", {
      features: [feature("Alpha", 2), feature("Zulu", 30), feature("Mike", 9)] });
    const ids = [...rendered.matchAll(/\| (F\d+) \| (\w+)/g)].map((m) => [m[1], m[2]]);
    expect(ids).toEqual([
      ["F001", "Zulu"],
      ["F002", "Mike"],
      ["F003", "Alpha"],
    ]);
  });

  it("does not tell a reader a dash means nothing was attributed at either scope", () => {
    // The lead said exactly that while 24 of 38 dashes had 1 to 45 tables in the
    // facts, and the flows section drew them three pages later.
    const rendered = render("prd-features", {
      features: [feature("Billing", 1, [], { nearby: ["wcp_billing"] })],
      endpoints: [] });
    expect(rendered).not.toContain("nothing could be attributed at all");
  });

  it("names the tables its package touches where its own files touch none", () => {
    // 24 of 38 dashes stood for 1 to 45 attributed tables, and the flows section
    // drew Billing's seven tables three pages after Billing's row said none.
    const rendered = render("prd-features", {
      features: [feature("Billing", 2, [], { nearby: ["wcp_billing", "wcp_project"] })],
      endpoints: [] });
    expect(rendered).toContain("wcp_billing");
    expect(rendered).toContain(FRAME_EN["tables-in-package"]!.replace("{0}", "").trim().split(":")[0]!);
  });

  it("marks nothing where no trace stopped counting", () => {
    // On the row: the lead explains what the marker means, so the word is in the
    // section either way.
    const rendered = render("prd-features", {
      features: [feature("Leave", 1, ["wcp_leave"])],
      endpoints: [] });
    const row = rendered.split("\n").find((line) => line.includes("| Leave |"))!;
    expect(row).not.toContain("uncounted");
  });

  it("does not print the truncation marker as a row's whole table cell", () => {
    // A capability with no table at either scope and a truncated trace printed the
    // marker alone, which reads as a table named "and more, uncounted".
    const rendered = render("prd-features", {
      features: [feature("Vocabulary", 0, [], { truncated: true })],
      endpoints: [] });
    const cells = rendered
      .split("\n")
      .find((line) => line.includes("Vocabulary"))!
      .split("|")
      .map((part) => part.trim());
    expect(cells[5]).toBe("—");
  });

  it("says the lists are short where a trace stopped counting tables", () => {
    // Two caps compound: this section's, and the assembler's per-flow cap whose
    // remainder is unknowable. Eleven capabilities printed twelve tables and said
    // nothing, while their own diagrams read "16 more tables".
    const rendered = render("prd-features", {
      features: [feature("Openai", 1, [], { nearby: ["a_table"], truncated: true })],
      endpoints: [] });
    const row = rendered.split("\n").find((line) => line.includes("| Openai |"))!;
    expect(row).toContain("uncounted");
  });

  it("accounts for the tables it does not name at either scope", () => {
    const own = Array.from({ length: 20 }, (_, n) => `own_${String(n).padStart(2, "0")}`);
    const near = Array.from({ length: 30 }, (_, n) => `near_${String(n).padStart(2, "0")}`);
    const rendered = render("prd-features", {
      features: [feature("Wide", 1, own, { nearby: near })],
      endpoints: [] });
    const shownOwn = [...rendered.matchAll(/own_\d\d/g)].length;
    const shownNear = [...rendered.matchAll(/near_\d\d/g)].length;
    const counted = [...rendered.matchAll(/and (\d+) more/g)].map((m) => Number(m[1]));
    expect(shownOwn + shownNear + counted.reduce((a, b) => a + b, 0)).toBe(50);
    expect(shownOwn).toBeGreaterThan(4);
    expect(shownNear).toBeGreaterThan(4);
  });

  it("does not repeat a table in both scopes", () => {
    const rendered = render("prd-features", {
      features: [feature("Leave", 1, ["wcp_leave"], { nearby: ["wcp_leave", "wcp_user"] })],
      endpoints: [] });
    expect([...rendered.matchAll(/wcp_leave/g)]).toHaveLength(1);
  });

  it("keeps the two scopes apart rather than merging them into one list", () => {
    const rendered = render("prd-features", {
      features: [feature("Leave", 1, ["wcp_leave"], { nearby: ["wcp_user"] })],
      endpoints: [] });
    const row = rendered.split("\n").find((line) => line.includes("Leave"))!;
    expect(row.indexOf("wcp_leave")).toBeLessThan(row.indexOf("elsewhere in its package"));
    expect(row.indexOf("elsewhere in its package")).toBeLessThan(row.indexOf("wcp_user"));
  });

  it("names an address with the service that serves it, so a count adds up", () => {
    // Deduped on the address alone, a capability said 2 endpoints and listed one,
    // losing the fact that both services serve it.
    const rendered = render("prd-features", {
      features: [
        {
          ...feature("Support", 0),
          endpoints: [
            { method: "GET", path: "/v2/support/projects", rootName: "svc-a" },
            { method: "GET", path: "/v2/support/projects", rootName: "svc-b" },
          ] },
      ],
      endpoints: [] });
    expect(rendered).toContain("svc-a: GET /v2/support/projects");
    expect(rendered).toContain("svc-b: GET /v2/support/projects");
  });

  it("names a capability's addresses and tables, not only how many", () => {
    // "Billing — 32 endpoints" and not one path is what a rebuild team was given.
    const rendered = render("prd-features", {
      features: [feature("Leave", 2, ["wcp_leave", "wcp_leave_detail"])] });
    expect(rendered).toContain("/leave/0");
    expect(rendered).toContain("wcp_leave_detail");
  });

  it("counts every address it does not name", () => {
    const rendered = render("prd-features", { features: [feature("Wide", 30)] });
    const more = Number(/and (\d+) more/.exec(rendered)?.[1]);
    const shown = [...rendered.matchAll(/\/wide\/\d+/g)].length;
    expect(shown + more).toBe(30);
  });

  it("keeps two front ends apart and counts an address once", () => {
    // Grouping on the path alone merged them and counted a shared path twice.
    const rendered = render("prd-pages", {
      screens: [screen("ui-a", "/login"), screen("ui-b", "/login")] });
    expect(rendered).toContain("ui-a");
    expect(rendered).toContain("ui-b");
    expect(rendered).not.toMatch(/\| \/login \| 2 \|/);
  });

  it("groups pages two segments deep, so an area is navigable", () => {
    // One repository put 132 of 182 addresses under `/manage` and listed six.
    // Asserted on the area headings rather than on the address column, where
    // `/manage/leave` appears as a substring however the grouping is done.
    const rendered = render("prd-pages", {
      screens: [
        screen("ui", "/manage/leave/list"),
        screen("ui", "/manage/leave/:id"),
        screen("ui", "/manage/employee/list"),
      ] });
    const areas = [...rendered.matchAll(/^\| (\/\S+) \|/gm)].map((m) => m[1]);
    expect(areas).toEqual(["/manage/leave", "/manage/employee"]);
  });

  it("accounts for every page, shown or summarised", () => {
    const screens = Array.from({ length: 20 }, (_, n) => screen("ui", `/area/sub/page${n}`));
    const rendered = render("prd-pages", { screens });
    const more = Number(/and (\d+) more/.exec(rendered)?.[1] ?? 0);
    const shown = [...rendered.matchAll(/\/area\/sub\/page\d+/g)].length;
    expect(shown + more).toBe(20);
    // And enough of each area to be worth reading. The accounting holds for any
    // limit, including one, so the property is "several per area" rather than the
    // constant's value — a section naming one page in seven is not a page map.
    expect(shown).toBeGreaterThan(4);
  });

  it("survives a root address without rendering a doubled slash", () => {
    expect(render("prd-pages", { screens: [screen("ui", "/")] })).not.toContain("//");
  });

});
