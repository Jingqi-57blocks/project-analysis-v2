/**
 * Reads the client routes a Vue application declares through vue-router.
 *
 * A Vue app names its screens in a route table passed to createRouter:
 *   createRouter({ routes: [{ path: '/checkout', component: CheckoutView }, ...] })
 * Each entry is a screen — a path and the component that fills it — and entries
 * nest through `children`, a child's relative path composing under its parent's,
 * the same shape React Router's configuration objects use. The code index reports
 * the router file as a symbol but never the table as routes; this reads the table
 * so a Vue frontend has a screen list rather than an empty structure.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SgNode } from "@ast-grep/napi";

import { languageOf, literalText, parseSource } from "../../../text/ast.js";
import { lineRef, resolved } from "../../../structural/provenance.js";
import type { RouteRecord } from "../../../structural/boundaries.js";
import type { ExtractionFailure, StructuralRootInput } from "../../../structural/provider.js";
import { joinRoutePath, type FrameworkReading, type FrameworkRouteReader } from "./types.js";

const SOURCE_EXTENSIONS = [".js", ".ts", ".mjs", ".mts", ".vue"];

function isSourceFile(relPath: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => relPath.endsWith(extension));
}

/** The value node of an object's `name` property, or null. */
function objectProperty(object: SgNode, name: string): SgNode | null {
  for (const property of object.children()) {
    if ((property.kind() as string) !== "pair") continue;
    if ((property.field("key")?.text() ?? "").replace(/['"]/g, "") !== name) continue;
    return property.field("value") ?? null;
  }
  return null;
}

/** A bare component identifier names the screen; a lazy import has no symbol here. */
function componentName(object: SgNode): string | null {
  const value = objectProperty(object, "component") ?? objectProperty(object, "components");
  if (value === null) return null;
  const text = value.text();
  return /^[A-Za-z_$][\w$]*$/.test(text) ? text : null;
}

/**
 * A route record has a path and at least one screen-defining key. Requiring the
 * second key keeps an unrelated object that merely has a `path` (a file config,
 * an icon spec) from being read as a screen.
 */
function isRouteObject(object: SgNode): boolean {
  if (objectProperty(object, "path") === null) return false;
  return ["component", "components", "name", "children", "redirect"].some(
    (key) => objectProperty(object, key) !== null,
  );
}

function scanRouterFile(
  root: StructuralRootInput,
  relPath: string,
  routes: RouteRecord[],
  failures: ExtractionFailure[],
): void {
  const content = readFileSync(join(root.path, relPath), "utf8");
  // Only files that build a router or import vue-router; a route table defined
  // in a separate module and passed in is not followed.
  if (!content.includes("createRouter") && !content.includes("vue-router")) return;

  const language = languageOf(relPath);
  if (language === null) return;
  const parsed = parseSource(language, content);
  if (parsed.root === null) {
    failures.push({ scope: relPath, reason: parsed.reason ?? "the file could not be parsed" });
    return;
  }

  let objects: SgNode[];
  try {
    objects = parsed.root.findAll({ rule: { kind: "object" as never } });
  } catch {
    return;
  }

  // Composed top-down: an entry's own path, then its children's beneath it —
  // the same ancestor walk the React Router configuration reader uses.
  const prefixOf = new Map<string, string>();
  const keyOf = (node: SgNode): string => `${node.range().start.line}:${node.range().start.column}`;

  for (const object of objects) {
    if (!isRouteObject(object)) continue;

    const declared = literalText(objectProperty(object, "path") ?? undefined);
    if (declared === null) {
      failures.push({
        scope: `${relPath}:${object.range().start.line + 1}`,
        reason: "route path is not a string literal",
      });
      continue;
    }

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

    const composed = declared.startsWith("/") ? declared : joinRoutePath(inherited, declared);
    prefixOf.set(keyOf(object), composed);

    const handler = componentName(object);
    routes.push({
      rootName: root.name,
      surface: "client",
      method: null,
      path: composed,
      handlerSymbolId: null,
      handlerName: handler,
      handlerCandidates: handler === null ? [] : [handler],
      middleware: [],
      provenance: resolved(lineRef(root.name, relPath, object.range().start.line + 1), "medium"),
    });
  }
}

export function createVueRouterReader(): FrameworkRouteReader {
  return {
    id: "vue-router",
    language: "javascript",
    limits: [
      "routes are read from route-record objects (path plus component/name/children) in files that build a router or import vue-router; a table defined in a separate module and passed in is not followed",
      "a lazily imported component (() => import('...')) names no symbol here, so the screen's handler stays null",
      "a path assembled at runtime rather than declared as a string literal is recorded as a failure, never guessed",
    ],

    detect(root: StructuralRootInput): boolean {
      if (!root.analyzedFiles.includes("package.json")) return false;
      try {
        const manifest = JSON.parse(readFileSync(join(root.path, "package.json"), "utf8")) as {
          dependencies?: Record<string, string>;
        };
        return manifest.dependencies?.["vue-router"] !== undefined;
      } catch {
        return false;
      }
    },

    read(root: StructuralRootInput): FrameworkReading {
      const routes: RouteRecord[] = [];
      const failures: ExtractionFailure[] = [];

      for (const relPath of root.analyzedFiles.filter(isSourceFile)) {
        try {
          scanRouterFile(root, relPath, routes, failures);
        } catch (error) {
          failures.push({
            scope: relPath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { routes, gaps: [], failures };
    },
  };
}
