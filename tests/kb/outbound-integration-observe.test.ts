import { describe, expect, it } from "vitest";

import type {
  CodeGraphEdgeRecord,
  CodeGraphNodeRecord,
  CodeGraphSnapshot,
} from "../../engine/providers/codegraph/batch.js";
import { inferred } from "../../engine/structural/provenance.js";
import type { ExternalCallRecord } from "../../engine/structural/boundaries.js";
import {
  detectOutboundSinks,
  deriveOutboundReachability,
} from "../../engine/kb/outbound-integration-observe.js";

const ROOT = "svc";

const ids = (recs: readonly ExternalCallRecord[]) =>
  recs.map((r) => `${r.packageName}.${r.memberName ?? ""}@${r.provenance.source.relPath}:${r.provenance.source.startLine}`);

describe("detectOutboundSinks — library-standard outbound primitives", () => {
  it("matches an AWS SDK operation only in a file that imports the SDK", () => {
    const content = [
      `import (`,
      `\t"github.com/aws/aws-sdk-go-v2/service/s3"`,
      `)`,
      ``,
      `func PutObject() {`,
      `\tAwsClient.PutObject(c, input)`,
      `}`,
    ].join("\n");
    const recs = detectOutboundSinks(ROOT, "internal/third_party/s3/s3.go", content);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ packageName: "aws-sdk-go", memberName: "PutObject" });
    expect(recs[0]!.provenance.source.startLine).toBe(6);
  });

  it("does NOT match a wrapper reusing an SDK operation name in a file without the SDK import", () => {
    // The handler calls the project's own s3 wrapper — no aws-sdk import here, so
    // the shared method name must not be mistaken for the SDK call it forwards to.
    const content = [
      `import wcpS3 "bitbucket.org/x/internal/third_party/s3"`,
      ``,
      `func Export() {`,
      `\turl, err := wcpS3.PutObject(key, ct, buffer)`,
      `}`,
    ].join("\n");
    expect(detectOutboundSinks(ROOT, "internal/handlers/leave/service.go", content)).toEqual([]);
  });

  it("matches net/smtp SendMail and net/http one-shot calls", () => {
    const smtp = detectOutboundSinks(
      ROOT,
      "ses.go",
      `import "net/smtp"\nfunc f(){ smtp.SendMail(addr, auth, from, to, msg) }`,
    );
    expect(ids(smtp)).toEqual(["net/smtp.SendMail@ses.go:2"]);

    const http = detectOutboundSinks(
      ROOT,
      "client.go",
      `import "net/http"\nfunc f(){ http.Get(url); http.Post(url, ct, body) }`,
    );
    expect(ids(http)).toEqual(["net/http.Get@client.go:2", "net/http.Post@client.go:2"]);
  });

  it("matches JS axios calls and a global fetch, gated on the axios import", () => {
    const recs = detectOutboundSinks(
      ROOT,
      "api.js",
      [
        `import axios from "axios";`,
        `const a = await axios.get(url);`,
        `const b = await axios("post", url, body);`,
        `const c = await fetch(url);`,
      ].join("\n"),
    );
    expect(ids(recs)).toEqual([
      "axios.get@api.js:2",
      "axios.request@api.js:3",
      "fetch.fetch@api.js:4",
    ]);
  });

  it("does not treat a member access `.fetch(` as a global fetch", () => {
    expect(detectOutboundSinks(ROOT, "cache.js", `const x = store.fetch(key);`)).toEqual([]);
  });

  it("skips a sink that sits inside a comment", () => {
    const content = `import "net/smtp"\n// smtp.SendMail(addr, auth, from, to, msg)`;
    expect(detectOutboundSinks(ROOT, "ses.go", content)).toEqual([]);
  });

  it("does not flood on ordinary method calls", () => {
    const content = `import "gorm.io/gorm"\nfunc f(){ db.Save(x); db.Find(&y); obj.Process(); repo.Persist() }`;
    expect(detectOutboundSinks(ROOT, "repo.go", content)).toEqual([]);
  });
});

// --- reverse-reachability -------------------------------------------------

function node(
  nativeId: string,
  kind: string,
  filePath: string,
  startLine: number,
  endLine: number,
  name = nativeId,
): CodeGraphNodeRecord {
  return { nativeId, kind, name, filePath, startLine, endLine, metadata: {} };
}

function callsEdge(nativeId: string, from: string, to: string, filePath: string): CodeGraphEdgeRecord {
  return { nativeId, kind: "calls", fromNativeId: from, toNativeId: to, filePath, startLine: 1 };
}

function snapshotOf(
  nodes: readonly CodeGraphNodeRecord[],
  edges: readonly CodeGraphEdgeRecord[] = [],
): CodeGraphSnapshot {
  return {
    nodes,
    edges,
    unresolvedReferences: [],
    metadata: {
      codegraphVersion: "1.5.0",
      schemaVersion: "8",
      indexRoot: "/idx",
      rootPrefixes: [],
      nodeCount: nodes.length,
      edgeCount: edges.length,
    },
    truncation: { truncated: false, limit: null, reason: null },
  };
}

function sink(relPath: string, startLine: number, packageName = "aws-sdk-go", memberName = "PutObject"): ExternalCallRecord {
  const source = { rootName: ROOT, relPath, startLine, endLine: startLine, startColumn: 1, endColumn: null };
  return { rootName: ROOT, callerSymbolId: null, packageName, memberName, provenance: inferred(source, "medium") };
}

describe("deriveOutboundReachability — reverse-reaching an SDK sink to its handler", () => {
  it("attributes the handler that reaches the sink, not the sink's own function", () => {
    // handler service.go:1-10 → wrapper s3.go:12-20, and the SDK sink sits at s3.go:15.
    const snapshot = snapshotOf(
      [node("wrapper", "function", "s3.go", 12, 20), node("handler", "function", "service.go", 1, 10)],
      [callsEdge("e1", "handler", "wrapper", "service.go")],
    );
    const result = deriveOutboundReachability({ rootName: ROOT, sinks: [sink("s3.go", 15)], snapshot });

    // Only the caller (depth 1) is a reached record; the wrapper (depth 0) is left
    // to its direct sink. Reached records carry no member and low confidence.
    expect(ids(result.external)).toEqual(["aws-sdk-go.@service.go:1"]);
    expect(result.external[0]!.provenance).toMatchObject({ resolutionClass: "inferred", confidence: "low" });
    expect(result.external[0]!.memberName).toBeNull();
  });

  it("is deterministic regardless of node/edge input order", () => {
    const nodes = [node("handler", "function", "service.go", 1, 10), node("wrapper", "method", "s3.go", 12, 20)];
    const edges = [callsEdge("e1", "handler", "wrapper", "service.go")];
    const forward = deriveOutboundReachability({ rootName: ROOT, sinks: [sink("s3.go", 15)], snapshot: snapshotOf(nodes, edges) });
    const reversed = deriveOutboundReachability({
      rootName: ROOT,
      sinks: [sink("s3.go", 15)],
      snapshot: snapshotOf([...nodes].reverse(), [...edges].reverse()),
    });
    expect(reversed.external).toEqual(forward.external);
  });

  it("collapses several sinks a function reaches into one record per package", () => {
    // wrapperA holds a PutObject sink, wrapperB a GetObject sink; one handler calls
    // both — a single aws-sdk-go reached record, not two.
    const snapshot = snapshotOf(
      [
        node("wa", "function", "s3.go", 1, 9),
        node("wb", "function", "s3.go", 10, 19),
        node("handler", "function", "service.go", 20, 40),
      ],
      [callsEdge("e1", "handler", "wa", "service.go"), callsEdge("e2", "handler", "wb", "service.go")],
    );
    const result = deriveOutboundReachability({
      rootName: ROOT,
      sinks: [sink("s3.go", 5, "aws-sdk-go", "PutObject"), sink("s3.go", 15, "aws-sdk-go", "GetObject")],
      snapshot,
    });
    expect(ids(result.external)).toEqual(["aws-sdk-go.@service.go:20"]);
  });

  it("stops at maxHops", () => {
    // sink in f0; f1→f0, f2→f1, f3→f2. With maxHops 1 only f1 (depth 1) is reached.
    const nodes = [node("f0", "function", "c.go", 100, 110)];
    const edges: CodeGraphEdgeRecord[] = [];
    for (let i = 1; i <= 3; i++) {
      nodes.push(node(`f${i}`, "function", "c.go", i * 10, i * 10 + 9));
      edges.push(callsEdge(`e${i}`, `f${i}`, `f${i - 1}`, "c.go"));
    }
    const result = deriveOutboundReachability({
      rootName: ROOT,
      sinks: [sink("c.go", 105)],
      snapshot: snapshotOf(nodes, edges),
      maxHops: 1,
    });
    const lines = result.external.map((r) => r.provenance.source.startLine);
    expect(lines).toEqual([10]); // f1 only
  });
});
