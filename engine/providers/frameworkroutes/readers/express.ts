/**
 * Reads Express route registrations from the parsed source.
 *
 * Two passes, because a registration's path is only half-written where it is
 * declared: `app.use('/worklogs', require('./routes/worklogs')(passport))`
 * mounts a file at a prefix, and `router.get('/me', ...)` inside that file
 * completes it. Neither half means anything alone.
 *
 * Express handlers are usually anonymous closures, so a handler's identity is
 * taken from the first service call inside it — the thing the route actually
 * does — and stays null when there is none.
 */

import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { SgNode } from "@ast-grep/napi";

import { findCalls, languageOf, literalText, parseSource } from "../../../text/ast.js";
import { inferred, lineRef, resolved } from "../../../structural/provenance.js";
import type { RouteRecord } from "../../../structural/boundaries.js";
import type { ExtractionFailure, StructuralRootInput } from "../../../structural/provider.js";
import { joinRoutePath, type FrameworkReading, type FrameworkRouteReader } from "./types.js";

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
const SOURCE_EXTENSIONS = [".js", ".cjs", ".mjs", ".ts"];

function isSourceFile(relPath: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => relPath.endsWith(extension));
}

/** Resolves a `require('./routes/x')` specifier to an analyzed file's relPath. */
function resolveModule(
  fromRelPath: string,
  specifier: string,
  analyzed: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = normalize(join(dirname(fromRelPath), specifier));
  for (const candidate of [base, ...SOURCE_EXTENSIONS.map((e) => base + e), join(base, "index.js")]) {
    if (analyzed.has(candidate)) return candidate;
  }
  return null;
}

/** The specifier of any `require(...)` anywhere inside a node. */
function requiredSpecifier(node: SgNode): string | null {
  for (const call of findCalls(node)) {
    if (call.callee !== "require") continue;
    const specifier = literalText(call.args[0]);
    if (specifier !== null) return specifier;
  }
  return null;
}

/**
 * The nearest declaration of an identifier, or null.
 *
 * Resolved against the declaration's own node rather than by searching text,
 * so `logRouter` cannot match inside `catalogRouter` — the defect that mounted
 * one file's routes at another file's prefix.
 */
function declarationOf(root: SgNode, name: string): SgNode | null {
  for (const kind of ["variable_declarator", "assignment_expression"]) {
    let nodes: SgNode[];
    try {
      nodes = root.findAll({ rule: { kind: kind as never } });
    } catch {
      continue;
    }
    for (const node of nodes) {
      const declared = node.field("name")?.text() ?? node.field("left")?.text() ?? "";
      if (declared === name) return node;
    }
  }
  return null;
}

/** Which route file is mounted at which prefix. */
export function buildMountMap(
  root: StructuralRootInput,
  files: readonly string[],
): Map<string, string[]> {
  const analyzed = new Set(root.analyzedFiles);
  const mounts = new Map<string, string[]>();

  for (const relPath of files) {
    let content: string;
    try {
      content = readFileSync(join(root.path, relPath), "utf8");
    } catch {
      continue;
    }
    if (!content.includes(".use(")) continue;

    const language = languageOf(relPath);
    if (language === null) continue;
    const parsed = parseSource(language, content);
    if (parsed.root === null) continue;

    for (const call of findCalls(parsed.root)) {
      if (call.method !== "use") continue;
      const prefix = literalText(call.args[0]);
      const target = call.args[1];
      if (prefix === null || !prefix.startsWith("/") || target === undefined) continue;

      let specifier = requiredSpecifier(target);
      if (specifier === null) {
        // The mount names a variable, so the require is wherever that
        // variable was declared.
        const identifier = /^[A-Za-z_$][\w$]*/.exec(target.text())?.[0];
        if (identifier !== undefined) {
          const declaration = declarationOf(parsed.root, identifier);
          if (declaration !== null) specifier = requiredSpecifier(declaration);
        }
      }
      if (specifier === null) continue;

      const routeFile = resolveModule(relPath, specifier, analyzed);
      if (routeFile === null) continue;

      const existing = mounts.get(routeFile) ?? [];
      existing.push(prefix);
      mounts.set(routeFile, existing);
    }
  }

  return mounts;
}

/** The closure's effective identity: the first service call inside it. */
export function serviceCallIn(node: SgNode): string | null {
  for (const call of findCalls(node)) {
    if (/[Ss]ervices?$/.test(call.receiver)) return call.callee;
  }
  return null;
}

function handlerOf(node: SgNode): { name: string | null; fromClosure: boolean } {
  const text = node.text();
  if (/^[\w$.]+$/.test(text)) return { name: text, fromClosure: false };
  return { name: serviceCallIn(node), fromClosure: true };
}

/** Names a middleware argument by what it calls, or by what it is. */
function middlewareName(node: SgNode): string | null {
  if ((node.kind() as string) === "call_expression") {
    return node.field("function")?.text() ?? null;
  }
  return /^[\w$.]+$/.test(node.text()) ? node.text() : null;
}

function scanRouteFile(
  root: StructuralRootInput,
  relPath: string,
  prefixes: readonly string[] | undefined,
  routes: RouteRecord[],
  failures: ExtractionFailure[],
): void {
  const content = readFileSync(join(root.path, relPath), "utf8");
  if (!content.includes("express.Router")) return;

  const language = languageOf(relPath);
  if (language === null) return;
  const parsed = parseSource(language, content);
  if (parsed.root === null) {
    failures.push({ scope: relPath, reason: parsed.reason ?? "the file could not be parsed" });
    return;
  }

  const routerVars = new Set<string>();
  for (const call of findCalls(parsed.root)) {
    if (call.callee !== "express.Router") continue;
    let node: SgNode | null = call.node.parent();
    for (let depth = 0; node !== null && depth < 3; depth++) {
      const name = node.field("name")?.text() ?? node.field("left")?.text();
      if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) {
        routerVars.add(name);
        break;
      }
      node = node.parent();
    }
  }
  if (routerVars.size === 0) return;

  // router.use(mw) applies to registrations after it, in document order.
  const fileMiddleware: string[] = [];

  for (const call of findCalls(parsed.root)) {
    if (!routerVars.has(call.receiver)) continue;

    if (call.method === "use") {
      // A path-scoped use is a nested mount, not a middleware for everything
      // after it, and this reader does not follow those.
      if (literalText(call.args[0]) !== null) continue;
      fileMiddleware.push(
        ...call.args.map(middlewareName).filter((name): name is string => name !== null),
      );
      continue;
    }
    if (!METHODS.has(call.method)) continue;

    const subpath = literalText(call.args[0]);
    if (subpath === null) {
      failures.push({
        scope: `${relPath}:${call.line}`,
        reason: "registration path is not a string literal",
      });
      continue;
    }

    const rest = call.args.slice(1);
    const handlerArg = rest[rest.length - 1];
    const handler =
      handlerArg === undefined ? { name: null, fromClosure: false } : handlerOf(handlerArg);
    const middleware = [
      ...fileMiddleware,
      ...rest.slice(0, -1).map(middlewareName).filter((name): name is string => name !== null),
    ];
    const method = call.method === "all" ? null : call.method.toUpperCase();
    const source = lineRef(root.name, relPath, call.line);

    for (const prefix of prefixes ?? [null]) {
      if (prefix === null) {
        // The file was never seen mounted, so the served path is unknown —
        // the subpath is real but must not be asserted as complete.
        routes.push({
          rootName: root.name,
          surface: "server",
          method,
          path: joinRoutePath("", subpath),
          handlerSymbolId: null,
          handlerName: handler.name,
          handlerCandidates: handler.name === null ? [] : [handler.name],
          middleware,
          provenance: inferred(source, "low"),
        });
        failures.push({
          scope: `${relPath}:${call.line}`,
          reason: "route file is not reachable from any observed mount; prefix unknown",
        });
        continue;
      }

      routes.push({
        rootName: root.name,
        surface: "server",
        method,
        path: joinRoutePath(prefix, subpath),
        handlerSymbolId: null,
        handlerName: handler.name,
        handlerCandidates: handler.name === null ? [] : [handler.name],
        middleware,
        provenance: resolved(source, handler.fromClosure ? "medium" : "high"),
      });
    }
  }
}

export function createExpressReader(): FrameworkRouteReader {
  return {
    id: "express",
    language: "javascript",
    limits: [
      "mounts are read from app.use with a string prefix; nested router mounts are not followed",
      "a closure handler's identity is the first service call inside it, or null",
      "route files not reachable from an observed mount keep their subpath at low confidence",
      "registrations on the application object rather than a router are not read",
    ],

    detect(root: StructuralRootInput): boolean {
      if (!root.analyzedFiles.includes("package.json")) return false;
      try {
        const manifest = JSON.parse(readFileSync(join(root.path, "package.json"), "utf8")) as {
          dependencies?: Record<string, string>;
        };
        return manifest.dependencies?.["express"] !== undefined;
      } catch {
        return false;
      }
    },

    read(root: StructuralRootInput): FrameworkReading {
      const routes: RouteRecord[] = [];
      const failures: ExtractionFailure[] = [];
      const sourceFiles = root.analyzedFiles.filter(isSourceFile);

      const mounts = buildMountMap(root, sourceFiles);

      for (const relPath of sourceFiles) {
        try {
          scanRouteFile(root, relPath, mounts.get(relPath), routes, failures);
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
