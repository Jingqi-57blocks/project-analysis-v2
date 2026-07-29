/**
 * Reads the screens a React application declares.
 *
 * An indexer reports a component file as a route, which yields paths like
 * `/admin/Employees` — a module's location dressed as a URL. What the
 * application actually declares is a route configuration naming a path and the
 * component that fills it, plus `<Route path="...">` elements inside those
 * components. The difference is between a screen list a reader can use and a
 * directory listing that looks like one.
 *
 * Both halves are needed, for the same reason Express needs a mount map: a
 * configuration entry says `/manage/timesheet` and lazily imports an outlet,
 * and the outlet's own file says `list/:id`. Neither is the address on its own.
 */

import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import type { SgNode } from "@ast-grep/napi";

import { findCalls, languageOf, literalText, parseSource } from "../../../text/ast.js";
import { inferred, resolved } from "../../../structural/provenance.js";
import type { RouteRecord } from "../../../structural/boundaries.js";
import type { ExtractionFailure, StructuralRootInput } from "../../../structural/provider.js";
import { joinRoutePath, type FrameworkReading, type FrameworkRouteReader } from "./types.js";

const COMPONENT_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js"];

function attributeValue(element: SgNode, name: string): string | null {
  for (const attribute of element.children()) {
    if ((attribute.kind() as string) !== "jsx_attribute") continue;
    const key = attribute.children()[0]?.text();
    if (key !== name) continue;

    const value = attribute.children()[attribute.children().length - 1];
    if (value === undefined) return null;
    const text = value.text();
    const quoted = /^["'{]?["']?([^"'{}]*)["']?[}]?$/.exec(text);
    return quoted ? quoted[1]! : text;
  }
  return null;
}

/** Resolves an import specifier to an analyzed file, absolute or relative. */
function resolveModule(
  fromRelPath: string,
  specifier: string,
  analyzed: ReadonlySet<string>,
): string | null {
  const bases: string[] = [];
  if (specifier.startsWith(".")) {
    const directory = fromRelPath.includes("/")
      ? fromRelPath.slice(0, fromRelPath.lastIndexOf("/"))
      : "";
    bases.push(normalize(join(directory, specifier)));
  } else {
    // `src/pages/PersonalOutlet` — a path rooted at the project, which is how
    // a bundler alias usually reads.
    bases.push(specifier);
  }

  for (const base of bases) {
    for (const candidate of [
      base,
      ...COMPONENT_EXTENSIONS.map((extension) => base + extension),
      ...COMPONENT_EXTENSIONS.map((extension) => `${base}/index${extension}`),
    ]) {
      if (analyzed.has(candidate)) return candidate;
    }
  }
  return null;
}

/** Every dynamic-import specifier inside a node. */
function importSpecifiers(node: SgNode): string[] {
  const found: string[] = [];
  for (const call of findCalls(node)) {
    if (call.callee !== "import") continue;
    const specifier = literalText(call.args[0]);
    if (specifier !== null) found.push(specifier);
  }
  for (const match of node.text().matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push(match[1]!);
  }
  return [...new Set(found)];
}

function objectProperty(object: SgNode, name: string): SgNode | null {
  for (const property of object.children()) {
    if ((property.kind() as string) !== "pair") continue;
    if ((property.field("key")?.text() ?? "").replace(/['"]/g, "") !== name) continue;
    return property.field("value") ?? null;
  }
  return null;
}

/**
 * Prefixes that route-configuration objects mount component files at.
 *
 * Walks each configuration object, composing nested `children` paths, and
 * records the prefix against whatever file the entry imports.
 */
export function buildScreenMounts(
  root: StructuralRootInput,
  files: readonly string[],
): Map<string, string[]> {
  const analyzed = new Set(root.analyzedFiles);
  const mounts = new Map<string, string[]>();

  const record = (relPath: string, prefix: string): void => {
    const existing = mounts.get(relPath) ?? [];
    if (!existing.includes(prefix)) existing.push(prefix);
    mounts.set(relPath, existing);
  };

  for (const relPath of files) {
    let content: string;
    try {
      content = readFileSync(join(root.path, relPath), "utf8");
    } catch {
      continue;
    }
    if (!content.includes("path:")) continue;

    const language = languageOf(relPath);
    if (language === null) continue;
    const parsed = parseSource(language, content);
    if (parsed.root === null) continue;

    let objects: SgNode[];
    try {
      objects = parsed.root.findAll({ rule: { kind: "object" as never } });
    } catch {
      continue;
    }

    // Composed top-down: an entry's own path, then its children's beneath it.
    const prefixOf = new Map<string, string>();
    const keyOf = (node: SgNode): string =>
      `${node.range().start.line}:${node.range().start.column}`;

    for (const object of objects) {
      const declared = literalText(objectProperty(object, "path") ?? undefined);
      if (declared === null) continue;

      let inherited = "";
      let ancestor: SgNode | null = object.parent();
      while (ancestor !== null) {
        const known = prefixOf.get(keyOf(ancestor));
        if (known !== undefined) {
          inherited = known;
          break;
        }
        ancestor = ancestor.parent();
      }

      const composed = declared.startsWith("/")
        ? declared
        : joinRoutePath(inherited, declared);
      prefixOf.set(keyOf(object), composed);

      // Only the entry's own component, never its children's. Searching the
      // whole subtree would mount a parent's prefix onto every file its
      // children import, so an outlet declared under `/manage/approval/*`
      // would also appear to answer at `/manage`.
      for (const property of ["lazy", "Component", "element", "component"]) {
        const value = objectProperty(object, property);
        if (value === null) continue;
        for (const specifier of importSpecifiers(value)) {
          const target = resolveModule(relPath, specifier, analyzed);
          if (target !== null) record(target, composed);
        }
      }
    }
  }

  return mounts;
}

interface DeclaredScreen {
  readonly path: string;
  readonly line: number;
}

/** The `<Route path="...">` elements a file declares, with nesting composed. */
export function declaredRoutes(root: SgNode): DeclaredScreen[] {
  const found: DeclaredScreen[] = [];

  const walk = (node: SgNode, prefix: string): void => {
    for (const child of node.children()) {
      const kind = child.kind() as string;
      const isElement =
        kind === "jsx_element" || kind === "jsx_self_closing_element" || kind === "element";

      if (!isElement) {
        walk(child, prefix);
        continue;
      }

      const opening =
        kind === "jsx_self_closing_element"
          ? child
          : child.children().find((c) => (c.kind() as string) === "jsx_opening_element") ?? child;
      const name = opening.children().find((c) => (c.kind() as string) === "identifier")?.text();

      if (name !== "Route") {
        walk(child, prefix);
        continue;
      }

      const declared = attributeValue(opening, "path");
      const composed =
        declared === null
          ? prefix
          : declared.startsWith("/")
            ? declared
            : joinRoutePath(prefix, declared);

      if (declared !== null) {
        found.push({ path: composed, line: child.range().start.line + 1 });
      }
      walk(child, composed);
    }
  };

  walk(root, "");
  return found;
}

export function createReactRouterReader(): FrameworkRouteReader {
  return {
    id: "react-router",
    language: "typescript",
    limits: [
      "screens are read from Route elements and from route configuration objects; a path assembled at runtime is not read",
      "a configuration entry is linked to its component by the module it imports, so a component chosen by a value rather than an import is not followed",
      "an index route is not listed separately, since it names its parent's path",
    ],

    detect(root: StructuralRootInput): boolean {
      if (!root.analyzedFiles.includes("package.json")) return false;
      try {
        const manifest = JSON.parse(readFileSync(join(root.path, "package.json"), "utf8")) as {
          dependencies?: Record<string, string>;
        };
        const dependencies = manifest.dependencies ?? {};
        return (
          dependencies["react-router-dom"] !== undefined || dependencies["react-router"] !== undefined
        );
      } catch {
        return false;
      }
    },

    read(root: StructuralRootInput): FrameworkReading {
      const routes: RouteRecord[] = [];
      const failures: ExtractionFailure[] = [];
      const candidates = root.analyzedFiles.filter((relPath) =>
        COMPONENT_EXTENSIONS.some((extension) => relPath.endsWith(extension)),
      );

      const mounts = buildScreenMounts(root, candidates);

      for (const relPath of candidates) {
        let content: string;
        try {
          content = readFileSync(join(root.path, relPath), "utf8");
        } catch (error) {
          failures.push({
            scope: relPath,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (!content.includes("<Route")) continue;

        const language = languageOf(relPath);
        if (language === null) continue;
        const parsed = parseSource(language, content);
        if (parsed.root === null) {
          failures.push({ scope: relPath, reason: parsed.reason ?? "the file could not be parsed" });
          continue;
        }

        const prefixes = mounts.get(relPath);
        for (const declared of declaredRoutes(parsed.root)) {
          const source = {
            rootName: root.name,
            relPath,
            startLine: declared.line,
            endLine: declared.line,
            startColumn: null,
            endColumn: null,
          };

          for (const prefix of prefixes ?? [null]) {
            // A splat mount hands the rest of the path to the component's own
            // router, so the child's path replaces the `*` rather than
            // following it.
            const base = prefix === null ? null : prefix.replace(/\/\*$/, "");
            const composed = base === null ? declared.path : joinRoutePath(base, declared.path);
            routes.push({
              rootName: root.name,
              surface: "client",
              method: null,
              path: composed,
              handlerSymbolId: null,
              handlerName: null,
              handlerCandidates: [],
              middleware: [],
              // Without a mount the path is a real fragment but not the
              // address a user visits, which is a different claim.
              provenance:
                prefix === null ? inferred(source, "low") : resolved(source, "medium"),
            });
          }
        }
      }

      return { routes, gaps: [], failures };
    },
  };
}
