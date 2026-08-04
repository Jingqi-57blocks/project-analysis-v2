import { describe, expect, it } from "vitest";

import { ClaimsError, citedIdentitiesBySection, identityNamespaces, parseClaims, reportSections } from "../../engine/report/claims.js";
import { auditReport, type AuditInput } from "../../engine/report/kb-audit.js";
import { IN_MEMORY, openStore } from "../../engine/store/open.js";

const NAMESPACES = new Set(["wcp-auth", "behavioral"]);

const EMPTY_INVENTORY = {
  paths: new Set<string>(),
  extensions: new Set<string>(),
  denominators: new Set<number>(),
};

/** Everything the claims checks need, with nothing else able to fire. */
function audit(over: Partial<AuditInput>) {
  return auditReport({
    report: "",
    inventory: EMPTY_INVENTORY,
    namespaces: NAMESPACES,
    ...over,
  });
}

const codes = (result: { findings: readonly { code: string }[] }) => result.findings.map((f) => f.code);

describe("splitting a report into chapters", () => {
  it("counts chapters by position, whatever the headings say", () => {
    const report = "# Title\n\n## 一、开头\nbody\n\n## 二、下一章\nmore\n";
    expect(reportSections(report)).toHaveLength(2);
    expect(reportSections(report)[0]).toContain("开头");
  });

  it("does not split on a subheading", () => {
    expect(reportSections("## One\n### Sub\ntext\n## Two\n")).toHaveLength(2);
  });

  it("does not split on a heading inside a fenced block", () => {
    expect(reportSections("## One\n```\n## not a chapter\n```\ntext\n")).toHaveLength(1);
  });
});

describe("finding the identities a chapter cites", () => {
  const report = "## One\ntext `wcp-auth|a|b` and `internal/handlers/x.go`\n\n## Two\n`behavioral|guard|x`\n";

  it("reads a backticked span whose namespace the snapshot uses", () => {
    const cited = citedIdentitiesBySection(report, NAMESPACES);
    expect([...(cited.get(1) ?? [])]).toEqual(["wcp-auth|a|b"]);
    expect([...(cited.get(2) ?? [])]).toEqual(["behavioral|guard|x"]);
  });

  it("leaves paths, endpoints and field names alone", () => {
    const prose = "## One\n`internal/x.go`, `GET /v2/review/:key`, `proposal.Password`\n";
    expect(citedIdentitiesBySection(prose, NAMESPACES).size).toBe(0);
  });

  it("reads the namespaces from the base rather than being told them", () => {
    const store = openStore(IN_MEMORY);
    store.run("INSERT INTO workspaces (path, created_at) VALUES ('/w', 't')");
    store.run("INSERT INTO snapshots (workspace_id, identity, created_at) VALUES (1, 'i', 't')");
    store.run(
      "INSERT INTO behavior_facts (snapshot_id, fact_id, kind, family, schema_version, payload) VALUES (1, 'behavioral|guard|x', 'guard', 'rule', '1', '{}')",
    );

    expect([...identityNamespaces(store, 1)]).toEqual(["behavioral"]);
    store.close();
  });
});

describe("parsing claims", () => {
  it("reads a well-formed file", () => {
    const parsed = parseClaims(
      JSON.stringify({ claims: [{ id: "c1", section: 3, marker: "fact", evidenceIds: ["x"] }] }),
    );
    expect(parsed[0]).toEqual({ id: "c1", section: 3, marker: "fact", evidenceIds: ["x"] });
  });

  it("refuses a section written as the heading's text", () => {
    expect(() => parseClaims(JSON.stringify({ claims: [{ id: "c1", section: "3", marker: "fact" }] }))).toThrow(
      ClaimsError,
    );
  });

  it("refuses a malformed entry rather than skipping it", () => {
    expect(() => parseClaims(JSON.stringify({ claims: [{ section: 1, marker: "fact" }] }))).toThrow(ClaimsError);
  });
});

describe("auditing the body against its claims", () => {
  it("blocks a report that declares no claims at all", () => {
    expect(codes(audit({ report: "## One\ntext\n" }))).toContain("claims-block-missing");
  });

  it("passes a chapter whose cited row is declared and resolves", () => {
    const result = audit({
      report: "## One\nsee `wcp-auth|a|b`\n",
      claims: JSON.stringify({ claims: [{ id: "c1", section: 1, marker: "fact", evidenceIds: ["wcp-auth|a|b"] }] }),
      resolveIds: () => new Set(["wcp-auth|a|b"]),
    });
    expect(result.findings).toEqual([]);
  });

  it("catches prose that cites a row no claim accounts for", () => {
    const result = audit({
      report: "## One\nsee `wcp-auth|invented|row`\n",
      claims: JSON.stringify({ claims: [{ id: "c1", section: 1, marker: "unavailable", reason: "nothing recorded" }] }),
      resolveIds: () => new Set(),
    });
    expect(codes(result)).toEqual(["body-id-not-declared"]);
  });

  it("catches a claim citing a row that is not in the base", () => {
    const result = audit({
      report: "## One\nsee `wcp-auth|a|b`\n",
      claims: JSON.stringify({ claims: [{ id: "c1", section: 1, marker: "fact", evidenceIds: ["wcp-auth|a|b"] }] }),
      resolveIds: () => new Set(),
    });
    expect(codes(result)).toContain("cited-id-not-in-base");
  });

  it("catches a claim filed against a chapter that never cites the row", () => {
    const result = audit({
      report: "## One\nnothing here\n\n## Two\nsee `wcp-auth|a|b`\n",
      claims: JSON.stringify({ claims: [{ id: "c1", section: 1, marker: "fact", evidenceIds: ["wcp-auth|a|b"] }] }),
      resolveIds: () => new Set(["wcp-auth|a|b"]),
    });
    expect(codes(result)).toContain("claim-evidence-not-in-its-section");
  });

  it("rejects a marker outside the four", () => {
    const result = audit({
      report: "## One\n",
      claims: JSON.stringify({ claims: [{ id: "c1", section: 1, marker: "probable", evidenceIds: ["x"] }] }),
    });
    expect(codes(result)).toEqual(["claim-marker-unknown"]);
  });

  it("rejects a grounded claim that names nothing it rests on", () => {
    const result = audit({
      report: "## One\n",
      claims: JSON.stringify({ claims: [{ id: "c1", section: 1, marker: "inferred", evidenceIds: [] }] }),
    });
    expect(codes(result)).toEqual(["claim-without-evidence"]);
  });

  it("rejects an unavailable claim that does not say why", () => {
    const result = audit({
      report: "## One\n",
      claims: JSON.stringify({ claims: [{ id: "c1", section: 1, marker: "unavailable" }] }),
    });
    expect(codes(result)).toEqual(["claim-missing-reason"]);
  });

  it("says nothing about the body when the snapshot's namespaces are unknown", () => {
    const result = auditReport({ report: "## One\n`wcp-auth|a|b`\n", inventory: EMPTY_INVENTORY });
    expect(result.findings).toEqual([]);
  });
});

describe("auditing the query log", () => {
  const withLog = (queriesLog?: string) =>
    codes(
      audit({
        report: "## One\n",
        claims: JSON.stringify({ claims: [] }),
        requireQueriesLog: true,
        ...(queriesLog === undefined ? {} : { queriesLog }),
      }),
    );

  it("blocks a run that kept no record of what it asked", () => {
    expect(withLog()).toContain("queries-log-missing");
    expect(withLog("   \n")).toContain("queries-log-missing");
  });

  it("blocks a logged query that names snapshot_id and binds it to nothing", () => {
    expect(withLog("select count(*) from derived_records where snapshot_id > 0\n")).toContain(
      "query-not-scoped-to-snapshot",
    );
  });

  it("accepts a query bound to the parameter or to a literal snapshot", () => {
    expect(withLog("select 1 from derived_records where snapshot_id = :snapshot\n")).toEqual([]);
    expect(withLog("select 1 from derived_records where snapshot_id = 3\n")).toEqual([]);
  });

  it("says nothing about a query that reads no snapshot-scoped table", () => {
    expect(withLog("select name from source_roots\n")).toEqual([]);
  });
});
