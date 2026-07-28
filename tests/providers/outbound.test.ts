import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOutboundProvider, outboundCapabilities } from "../../engine/providers/outbound/provider.js";
import { buildEnclosingIndex } from "../../engine/structural/enclosing.js";
import { symbolId } from "../../engine/structural/identity.js";
import { declared, lineRef } from "../../engine/structural/provenance.js";
import { capabilityFor, ANY_LANGUAGE } from "../../engine/structural/provider.js";
import type { SymbolRecord } from "../../engine/structural/code.js";

let workDir: string;

function write(relPath: string, content: string): void {
  const full = join(workDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function extract(files: readonly string[]) {
  return createOutboundProvider().extract({ name: "svc", path: workDir, analyzedFiles: files });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-outbound-"));
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

describe("static destinations", () => {
  it("records an absolute URL literal as a target", () => {
    write("client.go", 'resp, _ := http.Get("https://api.example.com/v1/users")\n');

    const calls = extract(["client.go"]).records["outbound-call"];
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe("https://api.example.com/v1/users");
    expect(calls[0]!.kind).toBe("http");
  });

  it("never claims a static URL as directly observed", () => {
    // A URL in a string could be documentation, a comment, or a test constant.
    write("client.go", 'const base = "https://api.example.com"\n');
    expect(extract(["client.go"]).records["outbound-call"][0]!.provenance.resolutionClass).toBe(
      "inferred",
    );
  });

  it("records the line it was found on", () => {
    write("a.ts", '\n\nfetch("https://x.dev/a");\n');
    expect(extract(["a.ts"]).records["outbound-call"][0]!.provenance.source.startLine).toBe(3);
  });
});

describe("dynamic destinations", () => {
  it("records an interpolated URL as unresolved rather than guessing it", () => {
    // A plausible-looking wrong endpoint survives review because it looks
    // right, which makes it worse than an acknowledged unknown.
    write("a.ts", "fetch(`https://api.example.com/users/${id}`);\n");

    const calls = extract(["a.ts"]).records["outbound-call"];
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBeNull();
    expect(calls[0]!.provenance.resolutionClass).toBe("unresolved");
  });

  it("explains why it could not be resolved", () => {
    write("a.ts", "fetch(`https://api.example.com/${path}`);\n");
    const provenance = extract(["a.ts"]).records["outbound-call"][0]!.provenance;
    if (provenance.resolutionClass === "unresolved") {
      expect(provenance.unresolvedReason).toContain("built at runtime");
    }
  });

  it("records a concatenated URL as unresolved", () => {
    write("a.js", 'fetch("https://api.example.com/" + path);\n');
    expect(extract(["a.js"]).records["outbound-call"][0]!.target).toBeNull();
  });

  it("does not also assert the prefix as a fixed target", () => {
    // Recording both would claim an endpoint the code never calls.
    write("a.ts", "fetch(`https://api.example.com/users/${id}`);\n");
    expect(extract(["a.ts"]).records["outbound-call"]).toHaveLength(1);
  });
});

describe("what it does not scan", () => {
  it("ignores non-code files, where URLs are rarely calls", () => {
    write("README.md", "See https://example.com for docs\n");
    write("config.json", '{"homepage": "https://example.com"}');
    expect(extract(["README.md", "config.json"]).records["outbound-call"]).toEqual([]);
  });

  it("records an unreadable file as a failure without losing other files", () => {
    write("good.go", 'http.Get("https://a.dev")\n');
    const contribution = extract(["good.go", "missing.go"]);
    expect(contribution.records["outbound-call"]).toHaveLength(1);
    expect(contribution.failures).toHaveLength(1);
  });
});

describe("declared capabilities", () => {
  it("never claims completeness", () => {
    const declaration = capabilityFor(outboundCapabilities(), "outbound-call", ANY_LANGUAGE);
    expect(declaration?.support).toBe("partial");
    expect(declaration?.limits.join(" ")).toContain("never a complete list");
  });

  it("states that relative paths and base-URL composition are missed", () => {
    const declaration = capabilityFor(outboundCapabilities(), "outbound-call", ANY_LANGUAGE);
    expect(declaration?.limits.join(" ")).toContain("relative paths");
  });
});

describe("buildEnclosingIndex", () => {
  function symbol(name: string, startLine: number, endLine: number): SymbolRecord {
    return {
      id: symbolId({
        rootName: "svc",
        relPath: "a.go",
        kind: "function",
        qualifiedName: name,
        signature: null,
      }),
      name,
      qualifiedName: name,
      kind: "function",
      visibility: "unknown",
      signature: null,
      containerId: null,
      provenance: declared(lineRef("svc", "a.go", startLine, endLine)),
    };
  }

  it("finds the symbol whose range contains the fact", () => {
    const index = buildEnclosingIndex([symbol("Outer", 1, 50)]);
    expect(index.find(lineRef("svc", "a.go", 10))).toBe(symbol("Outer", 1, 50).id);
  });

  it("prefers the innermost symbol when ranges nest", () => {
    // A method inside a class is a better answer than the class.
    const outer = symbol("Outer", 1, 100);
    const inner = symbol("Inner", 40, 50);
    const index = buildEnclosingIndex([outer, inner]);

    expect(index.find(lineRef("svc", "a.go", 45))).toBe(inner.id);
  });

  it("returns null rather than attaching to the nearest candidate", () => {
    // File-level code genuinely has no enclosing symbol, and guessing would
    // attribute calls to functions that never make them.
    const index = buildEnclosingIndex([symbol("Fn", 20, 30)]);
    expect(index.find(lineRef("svc", "a.go", 5))).toBeNull();
  });

  it("does not match a fact in a different file", () => {
    const index = buildEnclosingIndex([symbol("Fn", 1, 100)]);
    expect(index.find(lineRef("svc", "other.go", 10))).toBeNull();
  });

  it("ignores symbols with no known line", () => {
    const noLine: SymbolRecord = {
      ...symbol("X", 1, 1),
      provenance: { resolutionClass: "declared", source: { rootName: "svc", relPath: "a.go", startLine: null, endLine: null, startColumn: null, endColumn: null } },
    };
    expect(buildEnclosingIndex([noLine]).find(lineRef("svc", "a.go", 1))).toBeNull();
  });
});

describe("URLs that are not destinations", () => {
  it("ignores XML namespace URIs, which nothing ever fetches", () => {
    // Measured: this was the single most common match across both targets,
    // because every file with inline SVG declares it. Reporting them would
    // bury the real calls, and a signal nobody trusts gets ignored wholesale.
    write("Icon.vue", '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
    expect(extract(["Icon.vue"]).records["outbound-call"]).toEqual([]);
  });

  it("ignores licence and schema URIs", () => {
    write("a.ts", 'const licence = "https://opensource.org/licenses/MIT";\n');
    expect(extract(["a.ts"]).records["outbound-call"]).toEqual([]);
  });

  it("ignores a bare scheme with no host", () => {
    // A fragment of a URL built elsewhere, not a destination.
    write("a.ts", 'const scheme = "https://";\n');
    expect(extract(["a.ts"]).records["outbound-call"]).toEqual([]);
  });

  it("still records a real endpoint on a host that merely looks unusual", () => {
    write("a.ts", 'fetch("http://localhost:8080/api");\n');
    expect(extract(["a.ts"]).records["outbound-call"][0]!.target).toBe("http://localhost:8080/api");
  });
});

describe("two URLs on one line", () => {
  it("keeps two dynamic URLs on one line as two distinct facts", () => {
    // Without a column they share a record key and the second is dropped at
    // persistence, with nothing recorded.
    write("a.ts", "fetch(`https://a.dev/x/${p}`); fetch(`https://b.dev/y/${q}`);\n");

    const calls = extract(["a.ts"]).records["outbound-call"];
    expect(calls).toHaveLength(2);
    expect(calls[0]!.provenance.source.startColumn).not.toBe(
      calls[1]!.provenance.source.startColumn,
    );
  });

  it("does not suppress a real static URL sharing a line with a dynamic one", () => {
    write("a.ts", 'fetch(`https://a.dev/${p}`); fetch("https://static.example.com/b");\n');

    const calls = extract(["a.ts"]).records["outbound-call"];
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.target === "https://static.example.com/b")).toBe(true);
    expect(calls.some((c) => c.target === null)).toBe(true);
  });
});

describe("enclosing index across roots", () => {
  it("does not attach a fact from one root to a symbol in another", () => {
    // Two services analyzed together can both contain src/main.go.
    const inA: SymbolRecord = {
      id: symbolId({ rootName: "a", relPath: "src/main.go", kind: "function", qualifiedName: "Run", signature: null }),
      name: "Run",
      qualifiedName: "Run",
      kind: "function",
      visibility: "unknown",
      signature: null,
      containerId: null,
      provenance: declared(lineRef("a", "src/main.go", 1, 100)),
    };

    const index = buildEnclosingIndex([inA]);
    expect(index.find(lineRef("a", "src/main.go", 10))).toBe(inA.id);
    expect(index.find(lineRef("b", "src/main.go", 10))).toBeNull();
  });
});
