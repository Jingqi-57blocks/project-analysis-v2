/**
 * Reads the screens a React application declares.
 *
 * An indexer reports a component file as a route, which yields paths like
 * `/admin/Employees` — the module's location dressed as a URL. What the
 * application actually declares is `<Route path="leave">` with children, and
 * the difference between those two is the difference between a screen list a
 * reader can use and a directory listing that looks like one.
 *
 * Nesting is composed within a file, which is where React Router puts a
 * screen's own subtree. A file whose routes are mounted under a parent
 * elsewhere keeps its declared path and says the prefix is unknown, the same
 * way a Gin group arriving as a parameter does.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { positionAt, scanSource } from "../../../text/scan.js";
import { inferred, resolved } from "../../../structural/provenance.js";
import type { RouteRecord } from "../../../structural/boundaries.js";
import type { ExtractionFailure, StructuralRootInput } from "../../../structural/provider.js";
import { joinRoutePath, type FrameworkReading, type FrameworkRouteReader } from "./types.js";

const ROUTE_ELEMENT = /<Route\b([^>]*?)(\/?)>/g;
const CLOSING = /<\/Route\s*>/g;
const COMPONENT_EXTENSIONS = [".tsx", ".jsx"];

interface DeclaredRoute {
  readonly path: string;
  readonly line: number;
  /** True when the path is composed from a root this file declares. */
  readonly rooted: boolean;
}

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*['"]([^'"]*)['"]\\s*\\})`).exec(
    attributes,
  );
  if (match === null) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * The routes a file declares, with nesting composed.
 *
 * Walks the `<Route>` elements in document order, keeping a stack of open
 * parents: a self-closing element is a leaf under whatever is open, and an
 * element with children pushes its own path. Only elements that actually
 * declare a path contribute — an index route names its parent's path.
 */
export function declaredRoutes(content: string): DeclaredRoute[] {
  const map = scanSource(content, { hashLineComments: false });
  const found: DeclaredRoute[] = [];

  interface Token {
    readonly index: number;
    readonly kind: "open" | "close";
    readonly attributes: string;
    readonly selfClosing: boolean;
  }

  const tokens: Token[] = [];
  for (const match of content.matchAll(ROUTE_ELEMENT)) {
    if (map.comment[match.index] === 1) continue;
    tokens.push({
      index: match.index,
      kind: "open",
      attributes: match[1] ?? "",
      selfClosing: match[2] === "/",
    });
  }
  for (const match of content.matchAll(CLOSING)) {
    if (map.comment[match.index] === 1) continue;
    tokens.push({ index: match.index, kind: "close", attributes: "", selfClosing: false });
  }
  tokens.sort((a, b) => a.index - b.index);

  const stack: string[] = [];
  for (const token of tokens) {
    if (token.kind === "close") {
      stack.pop();
      continue;
    }

    const declared = attribute(token.attributes, "path");
    const prefix = stack.length > 0 ? stack[stack.length - 1]! : "";
    // An absolute path ignores its parents, which is how React Router reads it.
    const composed =
      declared === null
        ? prefix
        : declared.startsWith("/")
          ? declared
          : joinRoutePath(prefix, declared);

    if (declared !== null) {
      found.push({
        path: composed,
        line: positionAt(map, token.index).line,
        rooted: declared.startsWith("/") || stack.length > 0,
      });
    }

    if (!token.selfClosing) stack.push(composed);
  }

  return found;
}

export function createReactRouterReader(): FrameworkRouteReader {
  return {
    id: "react-router",
    language: "typescript",
    limits: [
      "screens are read from Route elements; nesting is composed within a file, and a subtree mounted from another file keeps its declared path",
      "a route rendered from a configuration array rather than a Route element is not read",
      "an index route is not listed separately, since it names its parent's path",
    ],

    detect(root: StructuralRootInput): boolean {
      if (!root.analyzedFiles.includes("package.json")) return false;
      try {
        const manifest = JSON.parse(readFileSync(join(root.path, "package.json"), "utf8")) as {
          dependencies?: Record<string, string>;
        };
        const dependencies = manifest.dependencies ?? {};
        return dependencies["react-router-dom"] !== undefined || dependencies["react-router"] !== undefined;
      } catch {
        return false;
      }
    },

    read(root: StructuralRootInput): FrameworkReading {
      const routes: RouteRecord[] = [];
      const failures: ExtractionFailure[] = [];

      for (const relPath of root.analyzedFiles) {
        if (!COMPONENT_EXTENSIONS.some((extension) => relPath.endsWith(extension))) continue;
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

        for (const declared of declaredRoutes(content)) {
          const source = {
            rootName: root.name,
            relPath,
            startLine: declared.line,
            endLine: declared.line,
            startColumn: null,
            endColumn: null,
          };

          routes.push({
            rootName: root.name,
            surface: "client",
            method: null,
            path: declared.path,
            handlerSymbolId: null,
            handlerName: null,
            handlerCandidates: [],
            middleware: [],
            // A path composed only from this file's own nesting is real but
            // may sit under a parent declared elsewhere, so it is not stated
            // as the address a user visits.
            provenance: declared.rooted
              ? resolved(source, "medium")
              : inferred(source, "low"),
          });
        }
      }

      return { routes, gaps: [], failures };
    },
  };
}
