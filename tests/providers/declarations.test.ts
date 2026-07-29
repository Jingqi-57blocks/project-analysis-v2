import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDeclarationProvider } from "../../engine/providers/symbols/provider.js";
import { capabilityFor, ANY_LANGUAGE } from "../../engine/structural/provider.js";
import { createCodeGraphProvider } from "../../engine/providers/codegraph/provider.js";
import { languageOf } from "../../engine/text/ast.js";
import type { ImportRecord, SymbolRecord } from "../../engine/structural/code.js";

let workDir: string;

function write(relPath: string, content: string): void {
  const full = join(workDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function extract(files: readonly string[]) {
  const contribution = createDeclarationProvider().extract({
    name: "svc",
    path: workDir,
    analyzedFiles: files,
  });
  return {
    symbols: contribution.records.symbol as readonly SymbolRecord[],
    imports: contribution.records.import as readonly ImportRecord[],
    gaps: contribution.gaps,
    failures: contribution.failures,
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-declarations-"));
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

describe("Go", () => {
  beforeEach(() => {
    write(
      "server.go",
      `package svc

import (
	"fmt"
	h "net/http"
)

type Server struct { port int }

type Handler interface { Serve() error }

const MaxHours = 40

var timeout = 30

func New(port int) *Server { return &Server{port} }

func (s *Server) Serve() error { return nil }

func internal() {}
`,
    );
  });

  it("reads functions, methods, types, constants and variables", () => {
    const { symbols } = extract(["server.go"]);
    expect(symbols.map((symbol) => [symbol.name, symbol.kind])).toEqual([
      ["Server", "struct"],
      ["Handler", "interface"],
      ["MaxHours", "constant"],
      ["timeout", "variable"],
      ["New", "function"],
      ["Serve", "method"],
      ["internal", "function"],
    ]);
  });

  it("names a method by what it belongs to", () => {
    // The separator is what the linking stage uses to tell a method from a
    // plain function, so a route naming `leave.Creation` prefers the
    // package-level one.
    const serve = extract(["server.go"]).symbols.find((symbol) => symbol.name === "Serve")!;
    expect(serve.qualifiedName).toBe("Server::Serve");
    expect(serve.containerId).not.toBeNull();
  });

  it("takes visibility from capitalization, which is how Go states it", () => {
    const symbols = new Map(extract(["server.go"]).symbols.map((s) => [s.name, s.visibility]));
    expect(symbols.get("New")).toBe("public");
    expect(symbols.get("internal")).toBe("private");
    expect(symbols.get("timeout")).toBe("private");
  });

  it("records imports as written, including an alias", () => {
    const { imports } = extract(["server.go"]);
    expect(imports.map((entry) => [entry.specifier, entry.importedNames])).toEqual([
      ["fmt", []],
      ["net/http", ["h"]],
    ]);
    // Never resolved here: joining a specifier to a file is a workspace
    // question, and one file's syntax tree cannot answer it.
    expect(imports.every((entry) => entry.resolvedPath === null)).toBe(true);
  });
});

describe("TypeScript", () => {
  beforeEach(() => {
    write(
      "service.ts",
      `import { readFile } from "node:fs";
import type { Options } from "./options";

export class Service {
  async load(): Promise<void> {}
  helper() {}
}

export interface Config { retries: number }

export type Id = string;

export function create(options: Options) { return new Service(); }

export const LIMIT = 40;

const hidden = () => 1;
`,
    );
  });

  it("reads classes with their methods, interfaces, types, functions and constants", () => {
    const { symbols } = extract(["service.ts"]);
    expect(symbols.map((symbol) => [symbol.name, symbol.kind])).toEqual([
      ["Service", "class"],
      ["load", "method"],
      ["helper", "method"],
      ["Config", "interface"],
      ["Id", "type"],
      ["create", "function"],
      ["LIMIT", "constant"],
      ["hidden", "function"],
    ]);
  });

  it("reads an arrow function as a function", () => {
    // A route's handler is declared this way as often as with the keyword,
    // and recording it as a constant would lose the resolution.
    const hidden = extract(["service.ts"]).symbols.find((symbol) => symbol.name === "hidden")!;
    expect(hidden.kind).toBe("function");
    expect(hidden.visibility).toBe("private");
  });

  it("takes visibility from the export keyword", () => {
    const symbols = new Map(extract(["service.ts"]).symbols.map((s) => [s.name, s.visibility]));
    expect(symbols.get("create")).toBe("public");
    expect(symbols.get("hidden")).toBe("private");
  });

  it("marks a type-only import as one", () => {
    const { imports } = extract(["service.ts"]);
    expect(imports.map((entry) => [entry.specifier, entry.isTypeOnly])).toEqual([
      ["node:fs", false],
      ["./options", true],
    ]);
    expect(imports[0]!.importedNames).toEqual(["readFile"]);
  });
});

describe("identity", () => {
  it("gives one declaration one id, however often it is read", () => {
    write("a.go", "package a\nfunc Handle() {}\n");
    const first = extract(["a.go"]).symbols[0]!;
    const second = extract(["a.go"]).symbols[0]!;
    expect(first.id).toBe(second.id);
  });

  it("keeps two same-named functions in different files apart", () => {
    write("a.go", "package a\nfunc Handle() {}\n");
    write("b.go", "package b\nfunc Handle() {}\n");
    const symbols = extract(["a.go", "b.go"]).symbols;
    expect(new Set(symbols.map((symbol) => symbol.id)).size).toBe(2);
  });

  it("records no signature rather than an approximation of one", () => {
    // The merge contract treats what a provider states as declared. Two
    // providers spelling one signature differently would store two symbols
    // where the code has one.
    write("a.ts", "export function handle(a: string, b?: number): void {}\n");
    expect(extract(["a.ts"]).symbols[0]!.signature).toBeNull();
  });
});

describe("what it cannot read", () => {
  it("names the extensions it passed over, rather than counting them", () => {
    write("main.py", "def handle():\n    pass\n");
    write("app.rb", "def handle\nend\n");
    const { symbols, gaps } = extract(["main.py", "app.rb"]);
    expect(symbols).toEqual([]);
    expect(gaps[0]?.reason).toContain(".py, .rb");
  });

  it("records a file it cannot read rather than skipping it silently", () => {
    write("good.go", "package good\nfunc F() {}\n");
    const { symbols, failures } = extract(["good.go", "missing.go"]);
    expect(symbols).toHaveLength(1);
    expect(failures[0]?.scope).toBe("missing.go");
  });

  it("declares what it does not attempt, per language", () => {
    const capabilities = createDeclarationProvider().structuralCapabilities();
    expect(capabilityFor(capabilities, "symbol", "go")?.support).toBe("partial");
    // A language with no grammar here is a declared none, not an empty result.
    expect(capabilityFor(capabilities, "symbol", ANY_LANGUAGE)?.support).toBe("none");
    expect(capabilityFor(capabilities, "call-edge", "go")).toBeNull();
  });
});

describe("two readers, one workspace", () => {
  it("leaves a file another reader parsed to that reader", () => {
    // Both readers describing one function is not agreement: their ids
    // differ, so both records survive, and the linking stage reads two
    // symbols of one name as ambiguous. On WCP-V2 that took handler
    // resolution from 438 to 38.
    write("a.go", "package a\nfunc Handle() {}\n");
    const skipped = createCodeGraphProvider({
      roots: [workDir],
      skipSymbolsIn: () => true,
    }).structuralCapabilities();
    // The option exists on the adapter and the declaration reader claims the
    // languages it parses, which is what the partition is drawn from.
    expect(skipped.declarations.length).toBeGreaterThan(0);
    expect(languageOf("a.go")).toBe("go");
    expect(languageOf("main.php")).toBeNull();
  });
});
