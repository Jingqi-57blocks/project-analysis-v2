/**
 * Reads Express route registrations: a mount-map pass over `app.use(...)`
 * calls, then balanced-parenthesis parsing of `router.METHOD(...)` blocks —
 * which routinely span several lines, so line regexes are known-insufficient.
 *
 * Express handlers are usually anonymous closures. Their identity is taken
 * from the first `xService.method(` call inside the closure body — the thing
 * the route actually does — and stays null when none is found, with the
 * registration's location kept.
 */

import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import { leadingName, parseCalls, scanSource, stringLiteral } from "../../../text/scan.js";
import { inferred, lineRef, resolved } from "../../../structural/provenance.js";
import type { RouteRecord } from "../../../structural/boundaries.js";
import type { ExtractionFailure, StructuralRootInput } from "../../../structural/provider.js";
import { joinRoutePath, type FrameworkReading, type FrameworkRouteReader } from "./types.js";

const ROUTE_PATTERN = /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all|use)\s*\(/g;
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

/**
 * Pass 1: which route file is mounted at which prefix.
 *
 * Handles the inline form `app.use('/p', require('./routes/x')(passport))` and
 * the identifier form where the require sits earlier in the same file.
 */
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

    const map = scanSource(content, { hashLineComments: false });
    for (const call of parseCalls(content, map, /\b([A-Za-z_$][\w$]*)\.(use)\s*\(/g)) {
      const prefix = stringLiteral(call.args[0] ?? "");
      if (prefix === null || !prefix.startsWith("/") || call.args.length < 2) continue;

      const target = call.args[1]!;
      let specifier = /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(target)?.[1] ?? null;

      if (specifier === null) {
        const identifier = leadingName(target)?.split(".")[0];
        if (identifier) {
          specifier =
            new RegExp(
              `${identifier}[^=\\n]*=\\s*require\\(\\s*['"]([^'"]+)['"]\\s*\\)`,
            ).exec(content)?.[1] ?? null;
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
export function serviceCallIn(closureText: string): string | null {
  const match = /\b([A-Za-z_$][\w$]*[Ss]ervices?)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(closureText);
  return match ? `${match[1]}.${match[2]}` : null;
}

function handlerOf(arg: string): { name: string | null; fromClosure: boolean } {
  const trimmed = arg.trim();
  if (/^[\w$.]+$/.test(trimmed)) return { name: trimmed, fromClosure: false };

  // wrapAsync(async (req, res) => { ... }) or a bare closure.
  const service = serviceCallIn(trimmed);
  return { name: service, fromClosure: true };
}

function scanRouteFile(
  root: StructuralRootInput,
  relPath: string,
  prefixes: readonly string[] | undefined,
  routes: RouteRecord[],
  failures: ExtractionFailure[],
): void {
  const content = readFileSync(join(root.path, relPath), "utf8");
  const map = scanSource(content, { hashLineComments: false });

  const routerVars = new Set<string>();
  for (const match of content.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*express\.Router\s*\(/g)) {
    routerVars.add(match[1]!);
  }
  if (routerVars.size === 0) return;

  // router.use(mw) applies to registrations after it, in order.
  const fileMiddleware: string[] = [];

  for (const call of parseCalls(content, map, ROUTE_PATTERN)) {
    if (!routerVars.has(call.receiver)) continue;

    if (call.method === "use") {
      const maybePath = stringLiteral(call.args[0] ?? "");
      if (maybePath === null) fileMiddleware.push(...call.args.map(leadingName).filter((n): n is string => n !== null));
      continue;
    }

    const subpath = stringLiteral(call.args[0] ?? "");
    if (subpath === null) {
      failures.push({
        scope: `${relPath}:${call.line}`,
        reason: "registration path is not a string literal",
      });
      continue;
    }

    const rest = call.args.slice(1);
    const handlerArg = rest[rest.length - 1];
    const handler = handlerArg === undefined ? { name: null, fromClosure: false } : handlerOf(handlerArg);
    const handlerCandidates = handler.name === null ? [] : [handler.name];
    const middleware = [
      ...fileMiddleware,
      ...rest.slice(0, -1).map(leadingName).filter((name): name is string => name !== null),
    ];
    const method = call.method === "all" ? null : call.method.toUpperCase();
    const source = lineRef(root.name, relPath, call.line);

    for (const prefix of prefixes ?? [null]) {
      if (prefix === null) {
        // The file was never seen mounted, so the served path is unknown —
        // the subpath is real but must not be asserted as complete.
        routes.push({
          rootName: root.name,
          method,
          path: joinRoutePath("", subpath),
          handlerSymbolId: null,
          handlerName: handler.name,
          handlerCandidates,
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
        method,
        path: joinRoutePath(prefix, subpath),
        handlerSymbolId: null,
        handlerName: handler.name,
        handlerCandidates,
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
