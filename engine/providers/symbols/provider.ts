/**
 * Declarations and imports, read in process.
 *
 * The same trees that already yield routes, conditions, value sets and data
 * usage also hold every function, type and import in the file — so reading
 * them needs no external indexer, no cache written anywhere, and no tool
 * installed before this one works.
 *
 * What it does not do is resolve anything across files. An import specifier is
 * recorded as written, never resolved to a path; a symbol's identity comes
 * from where it is declared. Resolution across a workspace is the linking
 * stage's job and it has the whole model to do it with, which one file's
 * syntax tree does not.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SgNode } from "@ast-grep/napi";

import { languageOf, parseSource, type ParsedLanguage } from "../../text/ast.js";
import { symbolId, type SymbolId } from "../../structural/identity.js";
import { declared, lineRef } from "../../structural/provenance.js";
import { emptyRecords } from "../../structural/kinds.js";
import {
  ANY_LANGUAGE,
  type ExtractionFailure,
  type StructuralContribution,
  type StructuralProvider,
  type StructuralRootInput,
} from "../../structural/provider.js";
import type { ImportRecord, SymbolRecord } from "../../structural/code.js";

export const PROVIDER_ID = "declarations";
export const PROVIDER_VERSION = "1.0.0";

const MAX_FILE_BYTES = 1_000_000;

interface Reading {
  readonly symbols: SymbolRecord[];
  readonly imports: ImportRecord[];
}

function text(node: SgNode | undefined | null): string {
  return node?.text() ?? "";
}

function line(node: SgNode): number {
  return node.range().start.line + 1;
}

function unquote(value: string): string {
  return value.replace(/^["'`]/, "").replace(/["'`]$/, "");
}

/** Go exports by capitalization; the script languages by an `export` keyword. */
function goVisibility(name: string): "public" | "private" {
  const first = name[0] ?? "";
  return first === first.toUpperCase() && first !== first.toLowerCase() ? "public" : "private";
}

function makeSymbol(
  rootName: string,
  relPath: string,
  node: SgNode,
  name: string,
  kind: string,
  visibility: string,
  container: { id: SymbolId; name: string } | null,
): SymbolRecord {
  // `Server::Serve`, not `Server.Serve`. The separator is not cosmetic: the
  // linking stage tells a plain function from a method by it, and a route
  // naming `leave.Creation` must prefer the package-level function over a
  // method of the same name. Spelled with a dot, every such pair read as
  // ambiguous and neither resolved.
  const qualifiedName = container === null ? name : `${container.name}::${name}`;
  return {
    id: symbolId({ rootName, relPath, kind, qualifiedName, signature: null }),
    name,
    qualifiedName,
    kind,
    visibility,
    // Null rather than reconstructed: an approximated signature is a fact the
    // merge contract would treat as declared, and two providers spelling one
    // differently would store two symbols where the code has one.
    signature: null,
    containerId: container?.id ?? null,
    provenance: declared(lineRef(rootName, relPath, line(node))),
  };
}

/** Go: functions, methods, types, package-level constants and variables. */
function readGo(root: SgNode, rootName: string, relPath: string, into: Reading): void {
  const add = (
    node: SgNode,
    name: string,
    kind: string,
    container: { id: SymbolId; name: string } | null = null,
  ): SymbolRecord | null => {
    if (name === "" || name === "_") return null;
    const record = makeSymbol(rootName, relPath, node, name, kind, goVisibility(name), container);
    into.symbols.push(record);
    return record;
  };

  for (const node of root.children()) {
    const kind = node.kind() as string;

    if (kind === "function_declaration") {
      add(node, text(node.field("name")), "function");
      continue;
    }

    if (kind === "method_declaration") {
      // The receiver names what the method belongs to: `func (s *Server) Serve()`
      // is `Server.Serve`, which is how a reader refers to it.
      const receiverType = text(node.field("receiver")).replace(/[()*]/g, "").split(/\s+/).pop() ?? "";
      const name = text(node.field("name"));
      const container =
        receiverType === ""
          ? null
          : {
              id: symbolId({
                rootName,
                relPath,
                kind: "struct",
                qualifiedName: receiverType,
                signature: null,
              }),
              name: receiverType,
            };
      add(node, name, "method", container);
      continue;
    }

    if (kind === "type_declaration") {
      for (const spec of node.children()) {
        if ((spec.kind() as string) !== "type_spec") continue;
        const body = spec.field("type");
        const bodyKind = (body?.kind() as string) ?? "";
        const declaredKind = bodyKind.includes("struct")
          ? "struct"
          : bodyKind.includes("interface")
            ? "interface"
            : "type";
        add(spec, text(spec.field("name")), declaredKind);
      }
      continue;
    }

    if (kind === "const_declaration" || kind === "var_declaration") {
      const specKind = kind === "const_declaration" ? "const_spec" : "var_spec";
      const symbolKind = kind === "const_declaration" ? "constant" : "variable";
      for (const spec of node.children()) {
        if ((spec.kind() as string) !== specKind) continue;
        for (const child of spec.children()) {
          if ((child.kind() as string) !== "identifier") continue;
          add(child, text(child), symbolKind);
        }
      }
      continue;
    }

    if (kind === "import_declaration") {
      for (const spec of node.findAll({ rule: { kind: "import_spec" as never } })) {
        const path = unquote(text(spec.field("path") ?? spec.children().at(-1)));
        if (path === "") continue;
        const alias = text(spec.field("name"));
        into.imports.push({
          rootName,
          relPath,
          specifier: path,
          resolvedPath: null,
          importedNames: alias === "" ? [] : [alias],
          isTypeOnly: false,
          provenance: declared(lineRef(rootName, relPath, line(spec))),
        });
      }
    }
  }
}

const SCRIPT_DECLARATIONS: Readonly<Record<string, string>> = {
  class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  function_declaration: "function",
  generator_function_declaration: "function",
  enum_declaration: "enum",
};

/** TypeScript, JavaScript and TSX: top-level declarations and class members. */
function readScript(root: SgNode, rootName: string, relPath: string, into: Reading): void {
  const declare = (
    node: SgNode,
    name: string,
    kind: string,
    exported: boolean,
    container: { id: SymbolId; name: string } | null = null,
  ): SymbolRecord | null => {
    if (name === "") return null;
    const record = makeSymbol(
      rootName,
      relPath,
      node,
      name,
      kind,
      exported ? "public" : "private",
      container,
    );
    into.symbols.push(record);
    return record;
  };

  const readDeclaration = (node: SgNode, exported: boolean): void => {
    const kind = node.kind() as string;

    const declaredKind = SCRIPT_DECLARATIONS[kind];
    if (declaredKind !== undefined) {
      const name = text(node.field("name"));
      const record = declare(node, name, declaredKind, exported);
      if (record === null || declaredKind !== "class") return;

      // Methods belong to the class, and a report about a class nobody can
      // see the members of is a report about a name.
      const body = node.field("body");
      for (const member of body?.children() ?? []) {
        const memberKind = member.kind() as string;
        if (memberKind !== "method_definition") continue;
        declare(member, text(member.field("name")), "method", exported, {
          id: record.id,
          name: record.name,
        });
      }
      return;
    }

    if (kind === "lexical_declaration" || kind === "variable_declaration") {
      for (const child of node.children()) {
        if ((child.kind() as string) !== "variable_declarator") continue;
        const value = child.field("value");
        const valueKind = (value?.kind() as string) ?? "";
        // `const create = () => {}` is a function by any reading a person
        // would give it, and the handler a route names may be declared that
        // way as often as with the keyword.
        const isFunction = valueKind === "arrow_function" || valueKind.includes("function");
        declare(child, text(child.field("name")), isFunction ? "function" : "constant", exported);
      }
    }
  };

  for (const node of root.children()) {
    const kind = node.kind() as string;

    if (kind === "import_statement") {
      const source = unquote(text(node.field("source")));
      if (source === "") continue;
      const names = node
        .findAll({ rule: { kind: "import_specifier" as never } })
        .map((specifier) => text(specifier.field("name")))
        .filter((name) => name !== "");
      into.imports.push({
        rootName,
        relPath,
        specifier: source,
        resolvedPath: null,
        importedNames: names,
        isTypeOnly: node.text().startsWith("import type"),
        provenance: declared(lineRef(rootName, relPath, line(node))),
      });
      continue;
    }

    if (kind === "export_statement") {
      for (const child of node.children()) readDeclaration(child, true);
      continue;
    }

    readDeclaration(node, false);
  }
}

export function readDeclarations(
  rootName: string,
  relPath: string,
  content: string,
): Reading & { readonly reason: string | null } {
  const into: Reading = { symbols: [], imports: [] };
  const language: ParsedLanguage | null = languageOf(relPath);
  if (language === null) return { ...into, reason: null };

  const parsed = parseSource(language, content);
  if (parsed.root === null) return { ...into, reason: parsed.reason };

  if (language === "go") readGo(parsed.root, rootName, relPath, into);
  else readScript(parsed.root, rootName, relPath, into);

  return { ...into, reason: null };
}

const PARSED_LANGUAGES = ["go", "typescript", "javascript", "tsx"] as const;

export function createDeclarationProvider(): StructuralProvider {
  return {
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,
    capabilities: () => ["symbol", "import"],
    preflight: () => ({ available: true, version: PROVIDER_VERSION }),

    structuralCapabilities: () => ({
      declarations: [
        ...PARSED_LANGUAGES.flatMap((language) => [
          {
            kind: "symbol" as const,
            language,
            support: "partial" as const,
            limits: [
              "declarations only: a symbol produced at runtime, or assigned to a name through indirection, is not read",
              "signatures are not recorded, so two overloads in one file share an identity",
              language === "go"
                ? "functions, methods, types, and package-level constants and variables"
                : "top-level declarations and class methods; a function nested inside another is not recorded separately",
            ],
          },
          {
            kind: "import" as const,
            language,
            support: "partial" as const,
            limits: [
              "specifiers are recorded as written and never resolved to a file",
              "a dynamic import, or one built from a variable, is not read",
            ],
          },
        ]),
        // Said once, plainly: a language with no grammar here yields nothing,
        // and that is about this reader rather than about the project.
        {
          kind: "symbol",
          language: ANY_LANGUAGE,
          support: "none",
          limits: ["only Go, TypeScript, JavaScript and TSX are parsed"],
        },
        {
          kind: "import",
          language: ANY_LANGUAGE,
          support: "none",
          limits: ["only Go, TypeScript, JavaScript and TSX are parsed"],
        },
      ],
    }),

    extract: (root: StructuralRootInput): StructuralContribution => {
      const symbols: SymbolRecord[] = [];
      const imports: ImportRecord[] = [];
      const failures: ExtractionFailure[] = [];
      const unparsed = new Set<string>();

      for (const relPath of root.analyzedFiles) {
        if (languageOf(relPath) === null) {
          const dot = relPath.lastIndexOf(".");
          if (dot !== -1) unparsed.add(relPath.slice(dot));
          continue;
        }

        try {
          const content = readFileSync(join(root.path, relPath), "utf8");
          if (content.length > MAX_FILE_BYTES) {
            failures.push({ scope: relPath, reason: "file exceeds the read size limit" });
            continue;
          }
          const reading = readDeclarations(root.name, relPath, content);
          if (reading.reason !== null) {
            failures.push({ scope: relPath, reason: reading.reason });
            continue;
          }
          symbols.push(...reading.symbols);
          imports.push(...reading.imports);
        } catch (error) {
          failures.push({
            scope: relPath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        providerId: PROVIDER_ID,
        providerVersion: PROVIDER_VERSION,
        rootName: root.name,
        records: { ...emptyRecords(), symbol: symbols, import: imports },
        // Which extensions were passed over, named rather than counted: a
        // project that is mostly Python should say so here, not look like a
        // project with very few functions.
        gaps:
          unparsed.size === 0
            ? []
            : [
                {
                  kind: "symbol" as const,
                  language: ANY_LANGUAGE,
                  reason: `no grammar for ${[...unparsed].sort().join(", ")}, so declarations in those files were not read`,
                },
              ],
        failures,
      };
    },
  };
}
