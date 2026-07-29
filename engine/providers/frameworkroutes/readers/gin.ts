/**
 * Reads Gin route registrations by following group-variable chains.
 *
 * `v2 := engine.Group("/v2")` then `leaveGrp := v2.Group("/leaves", auth.Authentication())`
 * then `leaveGrp.POST("", e.CatchError(leave.Creation))` yields the full path
 * `/v2/leaves`, the middleware stack the route inherits, and the handler
 * identifier — the three facts CodeGraph's registration-site view cannot see.
 *
 * A `*gin.Engine` function parameter roots a chain at `""`, which is how
 * registration split across files works: each file's chains resolve
 * independently from its own roots.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { leadingName, parseCalls, scanSource, stringLiteral } from "../../../text/scan.js";
import { lineRef, resolved, inferred } from "../../../structural/provenance.js";
import type { RouteRecord } from "../../../structural/boundaries.js";
import type { ExtractionFailure, StructuralRootInput } from "../../../structural/provider.js";
import { joinRoutePath, type FrameworkReading, type FrameworkRouteReader } from "./types.js";

const CALL_PATTERN = /\b([A-Za-z_][\w]*)\.(Group|Use|GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any|Handle)\s*\(/g;

interface GroupInfo {
  /** Null when the group arrived as a function parameter and its prefix is unknown. */
  readonly prefix: string | null;
  readonly middleware: readonly string[];
}

/** The `X :=` or `X =` immediately before a call, if the call is an assignment's right side. */
function assignmentTarget(content: string, callIndex: number): string | null {
  const lineStart = content.lastIndexOf("\n", callIndex - 1) + 1;
  const before = content.slice(lineStart, callIndex);
  const match = /([A-Za-z_][\w]*)\s*:?=\s*$/.exec(before);
  return match ? match[1]! : null;
}

/** Middleware argument expressions reduced to their dotted names. */
function middlewareNames(args: readonly string[]): string[] {
  return args.map(leadingName).filter((name): name is string => name !== null);
}

/**
 * Every name a registration's handler argument could mean, most-likely first.
 *
 * `e.CatchError(leave.Creation)` reads as the inner function wrapped by an
 * error adapter; `ginSwagger.WrapHandler(swaggerFiles.Handler)` reads as the
 * wrapper doing the work over a value. Nothing in the registration line
 * distinguishes them, so both names are kept and the symbol join picks
 * whichever the repository actually defines.
 */
export function handlerNamesOf(arg: string): string[] {
  const trimmed = arg.trim();
  if (/^func\b/.test(trimmed)) return [];
  if (/^[\w.]+$/.test(trimmed)) return [trimmed];

  const wrapped = /^([\w.]+)\s*\(\s*([\w.]+)\s*\)$/.exec(trimmed);
  return wrapped ? [wrapped[2]!, wrapped[1]!] : [];
}

function scanFile(
  root: StructuralRootInput,
  relPath: string,
  routes: RouteRecord[],
  failures: ExtractionFailure[],
): void {
  const content = readFileSync(join(root.path, relPath), "utf8");
  // Cheap non-global pre-check — testing the shared /g pattern here would
  // carry lastIndex across files and silently skip matches.
  if (!/\.(Group|GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any|Handle)\s*\(/.test(content)) return;

  const map = scanSource(content, { hashLineComments: false });
  const calls = parseCalls(content, map, CALL_PATTERN);

  const groups = new Map<string, GroupInfo>();
  for (const match of content.matchAll(/([A-Za-z_][\w]*)\s*:?=\s*gin\.(?:New|Default)\s*\(/g)) {
    groups.set(match[1]!, { prefix: "", middleware: [] });
  }
  // `engine := svReg.Gin` — the engine exposed as a struct field, which is how
  // registration gets split across files in practice (the reference's
  // "split registration" hard case). A field named Gin or Engine is taken as
  // the engine itself, rooted at "".
  for (const match of content.matchAll(/([A-Za-z_][\w]*)\s*:?=\s*[\w.]+\.(?:Gin|Engine)\b/g)) {
    if (!groups.has(match[1]!)) groups.set(match[1]!, { prefix: "", middleware: [] });
  }
  // `func Handler(engine *gin.Engine)` — the engine arrives as a parameter and
  // roots this file's chains at "".
  for (const match of content.matchAll(/([A-Za-z_][\w]*)\s+\*gin\.Engine\b/g)) {
    groups.set(match[1]!, { prefix: "", middleware: [] });
  }
  // A *gin.RouterGroup parameter carries an unknown prefix from its caller.
  for (const match of content.matchAll(/([A-Za-z_][\w]*)\s+\*gin\.RouterGroup\b/g)) {
    if (!groups.has(match[1]!)) groups.set(match[1]!, { prefix: null, middleware: [] });
  }

  // Group assignments can chain, and a child can appear before its parent
  // resolves on a single pass — iterate to a fixpoint, bounded.
  for (let pass = 0; pass < 5; pass++) {
    let progressed = false;
    for (const call of calls) {
      if (call.method !== "Group") continue;
      const target = assignmentTarget(content, call.index);
      if (target === null || groups.has(target)) continue;

      const parent = groups.get(call.receiver);
      if (!parent) continue;

      const subpath = stringLiteral(call.args[0] ?? "") ?? "";
      groups.set(target, {
        prefix: parent.prefix === null ? null : joinRoutePath(parent.prefix, subpath),
        middleware: [...parent.middleware, ...middlewareNames(call.args.slice(1))],
      });
      progressed = true;
    }
    if (!progressed) break;
  }

  for (const call of calls) {
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
    if (call.method === "Group") continue;

    const pathArg = call.method === "Handle" ? call.args[1] : call.args[0];
    const pathLiteral = pathArg === undefined ? null : stringLiteral(pathArg);

    const base = groups.get(call.receiver);
    if (!base) {
      // A receiver this file never roots. On a known group any literal is a
      // subpath (Gin joins `GET("count")` onto the group), but on an unknown
      // receiver only a leading slash distinguishes a real registration from
      // something like `zap.Any("key", value)` — a logger call that would
      // otherwise pollute the failure list with non-routes.
      if (pathLiteral !== null && pathLiteral.startsWith("/")) {
        failures.push({
          scope: `${relPath}:${call.line}`,
          reason: `route registered on "${call.receiver}", whose group chain could not be resolved in this file`,
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

    let method: string | null;
    let rest: readonly string[];

    if (call.method === "Handle") {
      method = stringLiteral(call.args[0] ?? "");
      rest = call.args.slice(2);
    } else {
      method = call.method === "Any" ? null : call.method;
      rest = call.args.slice(1);
    }
    const subpath = pathLiteral;

    const handlerCandidates = rest.length > 0 ? handlerNamesOf(rest[rest.length - 1]!) : [];
    const handlerName = handlerCandidates[0] ?? null;
    const middleware = [...base.middleware, ...middlewareNames(rest.slice(0, -1))];
    const source = lineRef(root.name, relPath, call.line);

    if (base.prefix === null) {
      // The prefix lives in another file's group chain. The subpath alone is
      // real but incomplete, so it must not be asserted as the served path.
      routes.push({
        rootName: root.name,
        method,
        path: joinRoutePath("", subpath),
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
      method,
      path: joinRoutePath(base.prefix, subpath),
      handlerSymbolId: null,
      handlerName,
      handlerCandidates,
      middleware,
      provenance: resolved(source, "high"),
    });
  }
}

export function createGinReader(): FrameworkRouteReader {
  return {
    id: "gin",
    language: "go",
    limits: [
      "group chains are followed within one file; a group passed between files carries an unknown prefix",
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
