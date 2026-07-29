import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectBaseAliases,
  createUiCallsProvider,
  parseUrlTemplate,
} from "../../engine/providers/uicalls/provider.js";
import type { OutboundCallRecord } from "../../engine/structural/boundaries.js";

let workDir: string;

function write(relPath: string, content: string): void {
  const full = join(workDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function extract(files: readonly string[]): readonly OutboundCallRecord[] {
  return createUiCallsProvider().extract({ name: "ui", path: workDir, analyzedFiles: files })
    .records["outbound-call"];
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-uicalls-"));
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

describe("parseUrlTemplate", () => {
  it("splits a configured base from the path it adds", () => {
    expect(parseUrlTemplate("`${appRunnerApi}/v2/leaves/me`")).toEqual({
      baseIdentifier: "appRunnerApi",
      path: "/v2/leaves/me",
    });
  });

  it("treats a member access and a destructured name as one base", () => {
    // Keeping both spellings would split one base's evidence in half.
    expect(parseUrlTemplate("`${config.appRunnerApi}/v2/leaves`")?.baseIdentifier).toBe(
      "appRunnerApi",
    );
  });

  it("reduces an interpolated segment to a route parameter", () => {
    expect(parseUrlTemplate("`${appRunnerApi}/v2/leaves/${id}/approve`")?.path).toBe(
      "/v2/leaves/:param/approve",
    );
  });

  it("treats a segment only partly interpolated as a parameter too", () => {
    expect(parseUrlTemplate("`${api}/v2/report-${kind}`")?.path).toBe("/v2/:param");
  });

  it("drops a query string, which is not part of a route pattern", () => {
    expect(parseUrlTemplate("`${api}/v2/leaves?status=open`")?.path).toBe("/v2/leaves");
  });

  it("reads a path with no base", () => {
    expect(parseUrlTemplate("`/v2/leaves/${id}`")).toEqual({
      baseIdentifier: null,
      path: "/v2/leaves/:param",
    });
  });

  it("refuses anything that is not a template literal", () => {
    expect(parseUrlTemplate("url")).toBeNull();
    expect(parseUrlTemplate("'/v2/leaves'")).toBeNull();
  });

  it("refuses a template whose path does not start at a segment boundary", () => {
    expect(parseUrlTemplate("`${base}v2/leaves`")).toBeNull();
  });
});

describe("collectBaseAliases", () => {
  it("follows a base derived from another in the same file", () => {
    // Verbatim from the real target: without this, 25 calls resolve to nothing.
    const aliases = collectBaseAliases(
      "const mainApiV2 = `${config.performanceReviewMainApi}/v2`;\n",
    );
    expect(aliases.get("mainApiV2")).toEqual({
      baseIdentifier: "performanceReviewMainApi",
      prefix: "/v2",
    });
  });

  it("ignores a derivation that is not a path suffix", () => {
    expect(collectBaseAliases("const weird = `${base}?x=1`;").size).toBe(0);
  });
});

describe("the provider", () => {
  it("records the path, the method, and the base of a call", () => {
    write(
      "src/api/leaveApi.ts",
      "export const getLeaves = () => httpClient.get(`${appRunnerApi}/v2/leaves/me`);\n",
    );

    const calls = extract(["src/api/leaveApi.ts"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      target: "/v2/leaves/me",
      method: "GET",
      baseIdentifier: "appRunnerApi",
      kind: "http",
    });
  });

  it("resolves a derived base into the base it came from", () => {
    write(
      "src/api/reviewApi.ts",
      "const mainApiV2 = `${config.performanceReviewMainApi}/v2`;\n" +
        "export const entrance = () => authRequest.get(`${mainApiV2}/review/entrance`);\n",
    );

    const calls = extract(["src/api/reviewApi.ts"]);
    expect(calls[0]).toMatchObject({
      baseIdentifier: "performanceReviewMainApi",
      target: "/v2/review/entrance",
    });
  });

  it("states no method for a request whose method lives in an options object", () => {
    write("src/api/x.ts", "httpClient.request(`${api}/v2/x`, { method: verb });\n");
    expect(extract(["src/api/x.ts"])[0]!.method).toBeNull();
  });

  it("keeps a call whose URL it cannot read, with the reason recorded", () => {
    // Dropping it would make the front end look like it reaches fewer
    // services than it does.
    write("src/api/x.ts", "httpClient.get(buildUrl(kind));\n");

    const contribution = createUiCallsProvider().extract({
      name: "ui",
      path: workDir,
      analyzedFiles: ["src/api/x.ts"],
    });

    expect(contribution.records["outbound-call"]).toHaveLength(1);
    expect(contribution.records["outbound-call"][0]!.target).toBeNull();
    expect(contribution.failures[0]!.reason).toContain("not a template literal");
  });

  it("reads a plain path string as the destination it is", () => {
    write("src/api/x.ts", "httpClient.post('/v2/leaves', body);\n");
    expect(extract(["src/api/x.ts"])[0]).toMatchObject({ target: "/v2/leaves", method: "POST" });
  });

  it("skips a call inside a comment", () => {
    write("src/api/x.ts", "// httpClient.get(`${api}/v2/old`);\nhttpClient.get(`${api}/v2/new`);\n");
    const calls = extract(["src/api/x.ts"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe("/v2/new");
  });

  it("reads a call whose arguments span several lines", () => {
    write(
      "src/api/x.ts",
      "httpClient.post(\n  `${appRunnerApi}/v2/leaves`,\n  { reason: 'sick, tired' },\n);\n",
    );
    expect(extract(["src/api/x.ts"])[0]!.target).toBe("/v2/leaves");
  });
});
