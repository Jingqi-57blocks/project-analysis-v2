import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { assembleEvidence, collectAll, evidenceKey } from "../../engine/semantic/assemble.js";
import { readEvidence, readEvidenceConflicts, recordEvidence } from "../../engine/semantic/persist.js";
import type { EvidenceItem, SemanticCollector, SemanticContribution } from "../../engine/semantic/types.js";
import { declared, lineRef } from "../../engine/structural/provenance.js";
import { createDocumentationCollector, readmeSections, configKeys } from "../../engine/collectors/documentation.js";
import { createCodeTextCollector, docComments, sourceExcerpts } from "../../engine/collectors/code.js";

let workDir: string;

function write(relPath: string, content: string): void {
  const full = join(workDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function root(files: readonly string[]) {
  return { name: "svc", path: workDir, analyzedFiles: files };
}

function item(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  const source = overrides.source ?? lineRef("svc", "a.go", 3);
  return {
    rootName: "svc",
    kind: "doc-comment",
    text: "does a thing",
    label: null,
    symbolId: null,
    source,
    provenance: declared(source),
    ...overrides,
  };
}

function contribution(id: string, items: readonly EvidenceItem[]): SemanticContribution {
  return {
    collectorId: id,
    collectorVersion: "1.0.0",
    rootName: "svc",
    items,
    gaps: [],
    failures: [],
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-semantic-"));
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

describe("assembleEvidence", () => {
  it("merges the same evidence from two collectors, keeping both attributions", () => {
    const assembled = assembleEvidence("svc", [
      contribution("a", [item()]),
      contribution("b", [item()]),
    ]);

    expect(assembled.items).toHaveLength(1);
    expect(assembled.items[0]!.attributions.map((x) => x.collectorId)).toEqual(["a", "b"]);
  });

  it("keeps both texts when collectors disagree about the same location", () => {
    // Where documentation and code disagree, silently preferring one is a
    // claim this stage cannot support.
    const assembled = assembleEvidence("svc", [
      contribution("a", [item({ text: "one reading" })]),
      contribution("b", [item({ text: "another reading" })]),
    ]);

    expect(assembled.items).toHaveLength(1);
    expect(assembled.items[0]!.conflictingText).toEqual([
      { collectorId: "b", text: "another reading" },
    ]);
  });

  it("keeps evidence from different locations apart", () => {
    const assembled = assembleEvidence("svc", [
      contribution("a", [
        item({ source: lineRef("svc", "a.go", 3) }),
        item({ source: lineRef("svc", "b.go", 3) }),
      ]),
    ]);
    expect(assembled.items).toHaveLength(2);
  });

  it("includes the column in identity, so two items on one line stay distinct", () => {
    const at = (column: number) =>
      item({
        source: { rootName: "svc", relPath: "a.vue", startLine: 1, endLine: 1, startColumn: column, endColumn: null },
      });
    expect(evidenceKey(at(4))).not.toBe(evidenceKey(at(40)));
  });
});

describe("collectAll", () => {
  it("isolates a collector that throws, keeping the others' evidence", () => {
    const broken: SemanticCollector = {
      id: "broken",
      version: "1.0.0",
      capabilities: () => ({ declarations: [] }),
      collect: () => {
        throw new Error("collector blew up");
      },
    };
    const working: SemanticCollector = {
      id: "working",
      version: "1.0.0",
      capabilities: () => ({ declarations: [] }),
      collect: () => contribution("working", [item()]),
    };

    const assembled = assembleEvidence("svc", collectAll([broken, working], root([])));

    expect(assembled.items).toHaveLength(1);
    expect(assembled.failures).toEqual([
      { collectorId: "broken", scope: "svc", reason: "collector blew up" },
    ]);
  });
});

describe("documentation collector", () => {
  it("keeps a README section as written rather than summarizing it", () => {
    // A summary can always be derived again; the original cannot be recovered.
    write("README.md", "# Orders\n\nHandles order placement and refunds.\nSupports card payment.\n");

    const items = createDocumentationCollector().collect(root(["README.md"])).items;
    const section = items.find((i) => i.kind === "readme-section");
    expect(section?.text).toBe("Handles order placement and refunds.\nSupports card payment.");
    expect(section?.label).toBe("Orders");
  });

  it("reads the project name and description from a manifest", () => {
    write("package.json", JSON.stringify({ name: "orders", description: "Order service" }));

    const items = createDocumentationCollector().collect(root(["package.json"])).items;
    expect(items.find((i) => i.kind === "project-title")?.text).toBe("orders");
    expect(items.find((i) => i.kind === "project-description")?.text).toBe("Order service");
  });

  it("records a gap when a root has no README, rather than failing", () => {
    write("package.json", JSON.stringify({ name: "x" }));

    const contribution = createDocumentationCollector().collect(root(["package.json"]));
    expect(contribution.failures).toEqual([]);
    expect(contribution.gaps.some((g) => g.reason.includes("no README"))).toBe(true);
  });

  it("collects config key names but never their values", () => {
    // Values may hold credentials, and nothing here has a use for one.
    write(".env.example", "DATABASE_URL=postgres://user:hunter2@localhost/db\nAPI_KEY=secret\n");

    const items = createDocumentationCollector().collect(root([".env.example"])).items;
    const keys = items.filter((i) => i.kind === "config-key");
    expect(keys.map((k) => k.text)).toEqual(["DATABASE_URL", "API_KEY"]);
    for (const key of keys) {
      expect(key.text).not.toContain("hunter2");
      expect(key.text).not.toContain("secret");
    }
  });

  it("records a failure for one unreadable file without losing the others", () => {
    write("README.md", "# A\n\ntext\n");
    const contribution = createDocumentationCollector().collect(root(["README.md", "package.json"]));
    expect(contribution.items.length).toBeGreaterThan(0);
    expect(contribution.failures).toHaveLength(1);
  });

  it("splits sections at headings", () => {
    const sections = readmeSections("# One\n\nfirst\n\n## Two\n\nsecond\n");
    expect(sections.map((s) => s.heading)).toEqual(["One", "Two"]);
  });

  it("ignores comments and blank lines when reading config keys", () => {
    expect(configKeys("# comment\n\nA=1\nB: 2\n").map((k) => k.key)).toEqual(["A", "B"]);
  });
});

describe("code-text collector", () => {
  it("joins consecutive line comments into one thought", () => {
    // Splitting a five-line comment into five fragments loses the thought
    // while keeping the words.
    const comments = docComments("// Orders are placed\n// then paid for.\nfunc F() {}\n", ".go");
    expect(comments).toHaveLength(1);
    expect(comments[0]!.text).toBe("Orders are placed then paid for.");
  });

  it("strips block-comment markup", () => {
    const comments = docComments("/**\n * Places an order.\n */\n", ".ts");
    expect(comments[0]!.text).toBe("Places an order.");
  });

  it("collects test names, which state business rules structure cannot recover", () => {
    write("order.test.ts", 'it("rejects an order with an expired card", () => {});\n');

    const items = createCodeTextCollector().collect(root(["order.test.ts"])).items;
    expect(items.find((i) => i.kind === "test-name")?.text).toBe(
      "rejects an order with an expired card",
    );
  });

  it("does not mistake a schema validator for a test", () => {
    // Yup and Joi schemas use .test("name", ...) to declare a *validator*.
    // Measured on a real React codebase: every "test name" found this way was
    // a validation rule, which would tell a reader the project has tests it
    // does not have.
    write("schema.ts", 'const s = yup.string().test("payment-term-days", "bad", v => true);\n');

    const items = createCodeTextCollector().collect(root(["schema.ts"])).items;
    expect(items.filter((i) => i.kind === "test-name")).toEqual([]);
  });

  it("still finds a real test declared at statement position", () => {
    write("a.test.ts", 'describe("orders", () => {\n  it("rejects an expired card", () => {});\n});\n');

    const names = createCodeTextCollector()
      .collect(root(["a.test.ts"]))
      .items.filter((i) => i.kind === "test-name")
      .map((i) => i.text);
    expect(names).toContain("rejects an expired card");
    expect(names).toContain("orders");
  });

  it("records a test name as inferred, since calling it a test is a judgement", () => {
    write("a.test.ts", 'it("does a thing", () => {});\n');
    const found = createCodeTextCollector().collect(root(["a.test.ts"])).items.find((i) => i.kind === "test-name");
    expect(found?.provenance.resolutionClass).toBe("inferred");
  });

  it("collects Go and Python test function names", () => {
    write("a_test.go", "func TestCreateOrder(t *testing.T) {}\n");
    write("test_b.py", "def test_creates_order():\n    pass\n");

    const items = createCodeTextCollector().collect(root(["a_test.go", "test_b.py"])).items;
    const names = items.filter((i) => i.kind === "test-name").map((i) => i.text);
    expect(names).toContain("TestCreateOrder");
    expect(names).toContain("test_creates_order");
  });

  it("records UI labels as inferred, not as a definitive list of visible text", () => {
    write("Form.vue", '<template><label title="Order number">Submit Order</label></template>\n');

    const labels = createCodeTextCollector().collect(root(["Form.vue"])).items.filter((i) => i.kind === "ui-label");
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label.provenance.resolutionClass).toBe("inferred");
    }
  });

  it("keeps bounded verbatim function excerpts for cached semantic review", () => {
    const content = [
      "export async function approve(request: Request) {",
      "  if (request.status !== 'pending') throw new Error('invalid state');",
      "  return repository.save(request);",
      "}",
      "const cancel = async (request: Request) => {",
      "  request.status = 'cancelled';",
      "  return repository.save(request);",
      "};",
    ].join("\n");
    const excerpts = sourceExcerpts(content, "approval.ts");
    expect(excerpts.map((excerpt) => excerpt.label)).toEqual(["approve", "cancel"]);
    expect(excerpts[0]!.text).toContain("request.status !== 'pending'");
    expect(excerpts[1]!.startLine).toBe(5);
  });

  it("stores excerpts as declared source evidence without a symbol dependency", () => {
    write("approval.go", "func Approve(status string) error {\n  if status != \"pending\" { return errors.New(\"invalid state\") }\n  return nil\n}\n");
    const excerpt = createCodeTextCollector()
      .collect(root(["approval.go"]))
      .items.find((candidate) => candidate.kind === "source-excerpt");
    expect(excerpt?.label).toBe("Approve");
    expect(excerpt?.text).toContain("status != \"pending\"");
    expect(excerpt?.provenance.resolutionClass).toBe("declared");
  });

  it("declares a gap for a language whose comment syntax it does not know", () => {
    write("a.zig", "// a comment\n");
    const contribution = createCodeTextCollector().collect(root(["a.zig"]));
    expect(contribution.gaps.some((g) => g.language === ".zig")).toBe(true);
  });

  it("needs no structural model, leaving symbol ids null", () => {
    // The exit criterion for this MVP: complete evidence with no structural
    // provider present at all.
    write("a.go", "// Places an order.\nfunc Place() {}\n");

    const items = createCodeTextCollector().collect(root(["a.go"])).items;
    expect(items.length).toBeGreaterThan(0);
    for (const evidence of items) expect(evidence.symbolId).toBeNull();
  });
});

describe("persistence", () => {
  let store: Store;
  let snapshotId: number;
  let rootId: number;

  beforeEach(() => {
    store = openStore(IN_MEMORY);
    store.run("INSERT INTO workspaces (path, created_at) VALUES ('/w','t')");
    store.run("INSERT INTO snapshots (workspace_id, identity, created_at, published_at) VALUES (1,'i','t',NULL)");
    snapshotId = store.get<{ id: number }>("SELECT id FROM snapshots")!.id;
    store.run(
      "INSERT INTO source_roots (snapshot_id,name,path,content_digest,vcs) VALUES (?,'svc','/p','d','git')",
      [snapshotId],
    );
    rootId = store.get<{ id: number }>("SELECT id FROM source_roots")!.id;
  });

  afterEach(() => store.close());

  it("round-trips evidence with its attribution", () => {
    const assembled = assembleEvidence("svc", [contribution("a", [item({ text: "does a thing" })])]);
    recordEvidence(store, snapshotId, rootId, assembled);

    const stored = readEvidence(store, snapshotId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.text).toBe("does a thing");
    expect(stored[0]!.attributions).toEqual(["a"]);
  });

  it("round-trips the complete source range for multi-line evidence", () => {
    const source = {
      rootName: "svc",
      relPath: "approval.go",
      startLine: 10,
      endLine: 14,
      startColumn: 0,
      endColumn: null,
    };
    const excerpt = item({
      kind: "source-excerpt",
      text: "func Approve() {\n  if blocked {\n    return\n  }\n}",
      source,
      provenance: declared(source),
    });
    recordEvidence(store, snapshotId, rootId, assembleEvidence("svc", [contribution("a", [excerpt])]));

    expect(readEvidence(store, snapshotId)[0]).toMatchObject({ startLine: 10, endLine: 14 });
  });

  it("persists a disagreement rather than resolving it", () => {
    const assembled = assembleEvidence("svc", [
      contribution("a", [item({ text: "one" })]),
      contribution("b", [item({ text: "two" })]),
    ]);
    recordEvidence(store, snapshotId, rootId, assembled);

    expect(readEvidenceConflicts(store, snapshotId).map((c) => c.text)).toEqual(["two"]);
  });

  it("does not lose two items that share a line", () => {
    const at = (column: number) =>
      item({
        text: `label ${column}`,
        source: { rootName: "svc", relPath: "a.vue", startLine: 1, endLine: 1, startColumn: column, endColumn: null },
      });

    recordEvidence(store, snapshotId, rootId, assembleEvidence("svc", [contribution("a", [at(4), at(40)])]));
    expect(readEvidence(store, snapshotId)).toHaveLength(2);
  });

  it("writes nothing if the transaction is interrupted", () => {
    expect(() =>
      store.transaction(() => {
        recordEvidence(store, snapshotId, rootId, assembleEvidence("svc", [contribution("a", [item()])]));
        throw new Error("later step failed");
      }),
    ).toThrow("later step failed");

    expect(store.all("SELECT * FROM evidence_items")).toEqual([]);
  });
});
