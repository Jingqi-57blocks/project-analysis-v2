/**
 * Reads Gin route registrations from the parsed source.
 *
 * `v2 := engine.Group("/v2")` then `leaveGrp := v2.Group("/leaves", auth.Authentication())`
 * then `leaveGrp.POST("", e.CatchError(leave.Creation))` yields the full path
 * `/v2/leaves`, the middleware stack the route inherits, and the handler
 * identifier — the three facts a registration-site index cannot see.
 *
 * Group variables are local to the function that declares them, and the chain
 * is followed in document order because that is Gin's own order: Group() copies
 * the parent's handler chain as it stands when the call runs, and Use() adds to
 * what comes after it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SgNode } from "@ast-grep/napi";

import {
  enclosingFunction,
  findCalls,
  literalText,
  parseSource,
  type AstCall,
} from "../../../text/ast.js";
import { lineRef, resolved, inferred } from "../../../structural/provenance.js";
import type { RouteRecord } from "../../../structural/boundaries.js";
import type { ExtractionFailure, StructuralRootInput } from "../../../structural/provider.js";
import { joinRoutePath, type FrameworkReading, type FrameworkRouteReader } from "./types.js";

const REGISTRATION_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "Any",
  "Handle",
]);

interface GroupInfo {
  /** Null when the group arrived as a parameter and its prefix is unknown. */
  readonly prefix: string | null;
  readonly middleware: readonly string[];
}

/**
 * The identifier a call is assigned to, when the call is an assignment's value.
 *
 * Go wraps both sides of `v2 := engine.Group("/v2")` in expression lists, so
 * the assignment is the call's grandparent rather than its parent.
 */
const ASSIGNMENT_KINDS = new Set<string>([
  "short_var_declaration",
  "assignment_statement",
  "var_spec",
]);

function assignmentTarget(call: AstCall): string | null {
  let node = call.node.parent();
  for (let depth = 0; node !== null && depth < 3; depth++) {
    if (ASSIGNMENT_KINDS.has(node.kind() as string)) {
      const left = node.field("left")?.text() ?? node.field("name")?.text() ?? "";
      return /^[A-Za-z_]\w*$/.test(left) ? left : null;
    }
    node = node.parent();
  }
  return null;
}

/** A middleware argument reduced to the name it calls. */
function middlewareName(node: SgNode): string | null {
  if ((node.kind() as string) === "call_expression") {
    return node.field("function")?.text() ?? null;
  }
  return /^[\w.]+$/.test(node.text()) ? node.text() : null;
}

function middlewareNames(args: readonly SgNode[]): string[] {
  return args.map(middlewareName).filter((name): name is string => name !== null);
}

/**
 * Every name a registration's handler argument could mean, most-likely first.
 *
 * `e.CatchError(leave.Creation)` reads as the inner function wrapped by an
 * error adapter; `ginSwagger.WrapHandler(swaggerFiles.Handler)` reads as the
 * wrapper doing the work over a value. Nothing in the registration
 * distinguishes them, so both survive to the symbol join, which settles it by
 * what the repository actually defines.
 */
export function handlerNamesOf(node: SgNode): string[] {
  const kind = node.kind() as string;
  if (kind === "func_literal" || kind === "function_literal") return [];
  if (/^[\w.]+$/.test(node.text())) return [node.text()];

  if (kind === "call_expression") {
    const outer = node.field("function")?.text() ?? null;
    const inner = node
      .field("arguments")
      ?.children()
      .find((child) => /^[\w.]+$/.test(child.text()));
    const names = [inner?.text(), outer].filter(
      (name): name is string => name !== undefined && name !== null,
    );
    return [...new Set(names)];
  }

  return [];
}

/** Group variables a scope roots, from its parameters. */
function rootsIn(scope: SgNode): Map<string, GroupInfo> {
  const groups = new Map<string, GroupInfo>();
  const text = scope.text();

  for (const match of text.matchAll(/([A-Za-z_]\w*)\s+\*gin\.Engine\b/g)) {
    groups.set(match[1]!, { prefix: "", middleware: [] });
  }
  // A *gin.RouterGroup parameter carries an unknown prefix from its caller.
  for (const match of text.matchAll(/([A-Za-z_]\w*)\s+\*gin\.RouterGroup\b/g)) {
    if (!groups.has(match[1]!)) groups.set(match[1]!, { prefix: null, middleware: [] });
  }
  // `engine := svReg.Gin` — the engine exposed as a struct field, which is how
  // registration gets split across files in practice.
  for (const match of text.matchAll(/([A-Za-z_]\w*)\s*:?=\s*[\w.]+\.(?:Gin|Engine)\b/g)) {
    if (!groups.has(match[1]!)) groups.set(match[1]!, { prefix: "", middleware: [] });
  }

  return groups;
}

function scanFile(
  root: StructuralRootInput,
  relPath: string,
  routes: RouteRecord[],
  failures: ExtractionFailure[],
): void {
  const content = readFileSync(join(root.path, relPath), "utf8");
  if (!content.includes("gin.") && !/\.(Group|GET|POST|PUT|PATCH|DELETE)\s*\(/.test(content)) return;

  const parsed = parseSource("go", content);
  if (parsed.root === null) {
    failures.push({ scope: relPath, reason: parsed.reason ?? "the file could not be parsed" });
    return;
  }

  // A scope is a function body, or the file itself for package-level
  // registration. Group variables never escape the function that declares
  // them, so resolving them file-wide would give one function's routes
  // another function's prefix.
  const byScope = new Map<string, { scope: SgNode; calls: AstCall[] }>();
  for (const call of findCalls(parsed.root)) {
    const enclosing = enclosingFunction(call.node) ?? parsed.root;
    const key = `${enclosing.range().start.line}:${enclosing.range().start.column}`;
    const existing = byScope.get(key);
    if (existing) existing.calls.push(call);
    else byScope.set(key, { scope: enclosing, calls: [call] });
  }

  for (const { scope, calls } of byScope.values()) {
    const groups = rootsIn(scope);

    for (const call of calls) {
      if (call.receiver === "gin" && (call.method === "New" || call.method === "Default")) {
        const target = assignmentTarget(call);
        if (target !== null) groups.set(target, { prefix: "", middleware: [] });
        continue;
      }

      if (call.method === "Use") {
        const existing = groups.get(call.receiver);
        if (existing) {
          groups.set(call.receiver, {
            prefix: existing.prefix,
            middleware: [...existing.middleware, ...middlewareNames(call.args)],
          });
        }
        continue;
      }

      if (call.method === "Group") {
        const target = assignmentTarget(call);
        const parent = groups.get(call.receiver);
        if (target === null || parent === undefined) continue;

        const subpath = literalText(call.args[0]) ?? "";
        groups.set(target, {
          prefix: parent.prefix === null ? null : joinRoutePath(parent.prefix, subpath),
          middleware: [...parent.middleware, ...middlewareNames(call.args.slice(1))],
        });
        continue;
      }

      if (!REGISTRATION_METHODS.has(call.method)) continue;

      const pathArg = call.method === "Handle" ? call.args[1] : call.args[0];
      const pathLiteral = literalText(pathArg);
      const base = groups.get(call.receiver);

      if (base === undefined) {
        // A receiver this scope never roots. Only a leading slash separates a
        // registration from something like `zap.Any("key", value)`.
        if (pathLiteral !== null && pathLiteral.startsWith("/")) {
          failures.push({
            scope: `${relPath}:${call.line}`,
            reason: `route registered on "${call.receiver}", whose group chain could not be resolved in this function`,
          });
        }
        continue;
      }
      if (pathLiteral === null) {
        failures.push({
          scope: `${relPath}:${call.line}`,
          reason: "registration path is not a string literal",
        });
        continue;
      }

      const method =
        call.method === "Handle"
          ? literalText(call.args[0])
          : call.method === "Any"
            ? null
            : call.method;
      const rest = call.method === "Handle" ? call.args.slice(2) : call.args.slice(1);

      const last = rest[rest.length - 1];
      const handlerCandidates = last === undefined ? [] : handlerNamesOf(last);
      const handlerName = handlerCandidates[0] ?? null;
      const middleware = [...base.middleware, ...middlewareNames(rest.slice(0, -1))];
      const source = lineRef(root.name, relPath, call.line);

      if (base.prefix === null) {
        // The prefix lives in another function's chain. The subpath alone is
        // real but incomplete, so it must not be asserted as the served path.
        routes.push({
          rootName: root.name,
          surface: "server",
          method,
          path: joinRoutePath("", pathLiteral),
          handlerSymbolId: null,
          handlerName,
          handlerCandidates,
          middleware,
          provenance: inferred(source, "low"),
        });
        failures.push({
          scope: `${relPath}:${call.line}`,
          reason: "group prefix arrives as a function parameter; the full path is unknown",
        });
        continue;
      }

      routes.push({
        rootName: root.name,
        surface: "server",
        method,
        path: joinRoutePath(base.prefix, pathLiteral),
        handlerSymbolId: null,
        handlerName,
        handlerCandidates,
        middleware,
        provenance: resolved(source, "high"),
      });
    }
  }
}

export function createGinReader(): FrameworkRouteReader {
  return {
    id: "gin",
    language: "go",
    limits: [
      "group chains are followed within one function; a group passed between functions or files carries an unknown prefix",
      "handler identifiers are unwrapped through one call layer only",
      "registration paths that are not string literals are recorded as failures",
    ],

    detect(root: StructuralRootInput): boolean {
      if (!root.analyzedFiles.includes("go.mod")) return false;
      try {
        return readFileSync(join(root.path, "go.mod"), "utf8").includes("github.com/gin-gonic/gin");
      } catch {
        return false;
      }
    },

    read(root: StructuralRootInput): FrameworkReading {
      const routes: RouteRecord[] = [];
      const failures: ExtractionFailure[] = [];

      for (const relPath of root.analyzedFiles) {
        if (!relPath.endsWith(".go") || relPath.endsWith("_test.go")) continue;
        try {
          scanFile(root, relPath, routes, failures);
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
