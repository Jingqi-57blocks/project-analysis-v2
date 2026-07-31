import { describe, expect, it } from "vitest";

import { buildFeatureFacts } from "../../engine/kb/features.js";
import type { DomainFeature } from "../../engine/modules/features.js";
import type { FeatureFlow } from "../../engine/flows/types.js";
import type { BusinessRule } from "../../engine/semantics/rules.js";
import type { RouteRecord } from "../../engine/structural/boundaries.js";
import { declared, lineRef } from "../../engine/structural/provenance.js";

function route(path: string, method = "POST", rootName = "svc"): RouteRecord {
  return {
    rootName,
    method,
    path,
    handlerSymbolId: null,
    handlerName: null,
    handlerCandidates: [],
    middleware: [],
    surface: "server",
    provenance: declared(lineRef(rootName, "router.go", 10, 1)),
  };
}

function feature(overrides: Partial<DomainFeature> = {}): DomainFeature {
  return {
    id: "feat_leave",
    weight: 9,
    term: "leave",
    name: "Leave",
    entities: ["leaves"],
    routes: [route("/v2/leaves")],
    filePaths: ["svc/leave.go"],
    rootNames: ["svc"],
    signals: ["1 entity", "1 endpoint"],
    ...overrides,
  };
}

function flow(overrides: Partial<FeatureFlow> = {}): FeatureFlow {
  return {
    featureId: "feat_leave",
    featureName: "Leave",
    entryKey: "svc:POST /v2/leaves",
    method: "POST",
    path: "/v2/leaves",
    steps: [
      {
        kind: "data-access",
        label: "leaves",
        rootName: "svc",
        conditions: [],
        unresolvedReason: null,
        provenance: null,
      },
    ],
    partial: false,
    ...overrides,
  };
}

function rule(overrides: Partial<BusinessRule> = {}): BusinessRule {
  return {
    rootName: "svc",
    subject: "lv.Hours",
    operator: ">",
    literal: 40,
    statement: "hours is more than 40",
    meanings: [],
    valueSetName: null,
    relPath: "leave.go",
    startLine: 88,
    text: "lv.Hours > 40",
    fullTest: null,
    guarded: "rejects",
    enclosingFunction: "Apply",
    ...overrides,
  };
}

describe("joining a capability to what was observed of it", () => {
  it("lists the tables its flows actually reached", () => {
    const facts = buildFeatureFacts([feature()], [flow()]);
    expect(facts.features[0]!.tables).toEqual(["leaves"]);
    expect(facts.features[0]!.flowCount).toBe(1);
  });

  it("leaves an unresolved table out of the list rather than naming it", () => {
    const unresolved = flow({
      steps: [
        {
          kind: "data-access",
          label: "unknown",
          rootName: "svc",
          conditions: [],
          unresolvedReason: "the query was built at runtime",
          provenance: null,
        },
      ],
    });
    expect(buildFeatureFacts([feature()], [unresolved]).features[0]!.tables).toEqual([]);
  });

  it("carries forward that a trace stopped counting tables", () => {
    // The assembler caps tables per flow and records the remainder as a step with
    // a reason. Dropping it with the other unresolved steps lost the fact, and a
    // capability published twelve tables where twenty-eight had been counted.
    const truncated = flow({
      steps: [
        {
          kind: "data-access",
          label: "16 more tables",
          rootName: "svc",
          conditions: [],
          unresolvedReason: "only the first 12 tables are shown",
          truncated: true,
          provenance: null,
        },
      ],
    });
    const facts = buildFeatureFacts([feature()], [truncated]);
    expect(facts.features[0]!.tablesTruncated).toBe(true);
    // And the remainder step is not mistaken for a table of its own.
    expect(facts.features[0]!.tables).toEqual([]);
  });

  it("does not claim a trace stopped counting where none did", () => {
    // An unresolved step is not a truncated one: a query built at runtime says
    // nothing about how many tables the trace could hold.
    const unresolved = flow({
      steps: [
        {
          kind: "data-access",
          label: "unknown",
          rootName: "svc",
          conditions: [],
          unresolvedReason: "the query was built at runtime",
          provenance: null,
        },
      ],
    });
    expect(buildFeatureFacts([feature()], [unresolved]).features[0]!.tablesTruncated).toBe(false);
    expect(buildFeatureFacts([feature()], [flow()]).features[0]!.tablesTruncated).toBe(false);
  });

  it("gives an endpoint to the capability whose flow claimed it, not to every match", () => {
    // "cancel a leave application" matches both Leave and Application. Listing
    // it under both puts a workflow under a capability it has nothing to do
    // with and dilutes the two.
    const application = feature({
      id: "feat_application",
      term: "application",
      name: "Application",
      routes: [route("/v2/leaves")],
    });

    const facts = buildFeatureFacts([feature(), application], [flow()]);
    const byId = new Map(facts.features.map((entry) => [entry.id, entry]));
    expect(byId.get("feat_leave")!.endpoints).toHaveLength(1);
    expect(byId.get("feat_application")!.endpoints).toHaveLength(0);
  });

  it("keeps an endpoint no flow claimed under its best match", () => {
    // Dropping it would lose the endpoint entirely, which is worse than
    // filing it under the capability whose term it carries.
    const facts = buildFeatureFacts([feature()], []);
    expect(facts.features[0]!.endpoints).toHaveLength(1);
  });

  it("puts complete flows before partial ones", () => {
    const partial = flow({ entryKey: "svc:GET /v2/leaves", path: "/v2/leaves/1", partial: true });
    const facts = buildFeatureFacts([feature()], [partial, flow()]);
    expect(facts.flows.map((entry) => entry.partial)).toEqual([false, true]);
    expect(facts.features[0]!.partialFlowCount).toBe(1);
  });

  it("stores each flow's diagram, so two documents draw the same picture", () => {
    const facts = buildFeatureFacts([feature()], [flow()]);
    expect(facts.flows[0]!.diagram).toContain("flowchart");
  });
});

describe("which rules are worth publishing", () => {
  const owned = new Map([["feat_leave", new Set(["svc/leave.go"])]]);

  it("publishes a rule two parts apply differently, ahead of everything else", () => {
    const rules = [
      rule(),
      rule({ rootName: "other", operator: ">=", text: "takeHours >= 40", subject: "takeHours" }),
      rule({ startLine: 12, subject: "lv.Days", literal: 7, text: "lv.Days > 7" }),
    ];
    const facts = buildFeatureFacts([feature()], [flow()], {
      rules,
      discarded: [],
      filesByFeature: owned,
    });

    const published = facts.rulesByFeature.get("feat_leave")!;
    expect(published[0]!.subject).toBe("lv.Hours");
  });

  it("leaves out a comparison whose value the project explains", () => {
    // A rule stated in the project's own vocabulary reads for itself. Only
    // ones nothing explains are worth a reader's attention.
    const explained = rule({ meanings: ["approved"], valueSetName: "LeaveStatus", literal: 4 });
    const facts = buildFeatureFacts([feature()], [flow()], {
      rules: [explained],
      discarded: [],
      filesByFeature: owned,
    });
    expect(facts.rulesByFeature.get("feat_leave")).toEqual([]);
  });

  it("counts every condition in its files, not only the published ones", () => {
    const facts = buildFeatureFacts([feature()], [flow()], {
      rules: [rule(), rule({ meanings: ["approved"], valueSetName: "S", literal: 4, startLine: 9 })],
      discarded: [],
      filesByFeature: owned,
    });
    expect(facts.features[0]!.conditionCount).toBe(2);
    expect(facts.rulesByFeature.get("feat_leave")).toHaveLength(1);
  });

  it("attributes a rule to no capability when the file belongs to none", () => {
    const facts = buildFeatureFacts([feature()], [flow()], {
      rules: [rule({ relPath: "elsewhere/util.go" })],
      discarded: [],
      filesByFeature: owned,
    });
    expect(facts.features[0]!.conditionCount).toBe(0);
  });
});

describe("evidence that matches what is published", () => {
  it("counts the endpoints the capability kept, not the ones its term matched", () => {
    // Detection counts every route carrying the term; ownership then gives a
    // contested route to one capability only. The two numbers were published
    // side by side — "2 endpoints" above a list of one.
    const application = feature({
      id: "feat_application",
      term: "application",
      name: "Application",
      routes: [route("/v2/leaves"), route("/v2/applications")],
      signals: ["1 entity", "2 endpoints"],
    });

    const facts = buildFeatureFacts([application], [flow()]);
    const published = facts.features[0]!;
    expect(published.endpoints).toHaveLength(1);
    expect(published.signals).toContain("1 endpoints");
    expect(published.signals).not.toContain("2 endpoints");
  });

  it("drops the endpoint evidence entirely when the capability kept none", () => {
    const application = feature({
      id: "feat_application",
      term: "application",
      name: "Application",
      routes: [route("/v2/leaves")],
      signals: ["1 entity", "1 endpoints", "3 files"],
    });

    const facts = buildFeatureFacts([application], [flow()]);
    expect(facts.features[0]!.signals).toEqual(["1 entity", "3 files"]);
  });
});
