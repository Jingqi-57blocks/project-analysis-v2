/**
 * Reads the API calls a browser application makes.
 *
 * The outbound detector looks for absolute URL literals, which a single-page
 * app never writes. Every call in a real front end reads
 * `` httpClient.get(`${appRunnerApi}/v2/leaves/me`) `` — a base configured at
 * deploy time plus a path template — so without this reader the frontend half
 * of every flow is invisible.
 *
 * Two things are recorded that a URL literal would not carry: the path with
 * its interpolations reduced to route parameters, so it can be matched against
 * a route pattern, and the identifier naming the base, which is the only
 * evidence available for deciding which service answers the call.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseCalls, positionAt, scanSource } from "../../text/scan.js";
import { inferred, resolved } from "../../structural/provenance.js";
import { emptyRecords } from "../../structural/kinds.js";
import type { OutboundCallRecord } from "../../structural/boundaries.js";
import {
  ANY_LANGUAGE,
  declaredKinds,
  type ExtractionFailure,
  type ProviderCapabilities,
  type StructuralContribution,
  type StructuralProvider,
  type StructuralRootInput,
} from "../../structural/provider.js";
import type { PreflightResult } from "../types.js";

export const PROVIDER_ID = "ui-calls";
export const PROVIDER_VERSION = "1.0.0";

/** The helpers a browser application makes requests through. */
const CLIENT_PATTERN =
  /\b(httpClient|authRequest|axios|fetch|request|api|http)\.(get|post|put|patch|delete|head|options|request)\s*\(/g;

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte"];

export interface ParsedUrlTemplate {
  readonly baseIdentifier: string | null;
  readonly path: string;
}

/**
 * Splits a template literal into the base it starts from and the path it adds.
 *
 * `` `${config.appRunnerApi}/v2/leaves/${id}` `` reads as the base
 * `config.appRunnerApi` and the path `/v2/leaves/:param`. Interpolations
 * inside the path become route parameters because that is what they are: a
 * value substituted into one path segment. A template whose interpolation
 * spans a segment boundary cannot be reduced this way and is refused rather
 * than guessed at.
 */
export function parseUrlTemplate(argument: string): ParsedUrlTemplate | null {
  const template = /^`([^]*)`$/.exec(argument.trim());
  if (template === null) return null;
  const body = template[1]!;

  const leading = /^\$\{\s*([\w.$]+)\s*\}/.exec(body);
  // `config.appRunnerApi` and a destructured `appRunnerApi` are the same base;
  // keeping both spellings would split one base's evidence in half and could
  // drop each part below the threshold that names a service.
  const baseIdentifier = leading ? leading[1]!.split(".").pop()! : null;
  const rest = leading ? body.slice(leading[0].length) : body;

  // A query string is not part of the route pattern.
  const withoutQuery = rest.split(/[?#]/)[0]!;

  // Any remaining interpolation stands for one path segment's value. An
  // interpolation that is not the whole segment (`/v2/x${suffix}`) still
  // occupies that segment, so the segment as a whole becomes a parameter.
  const path = withoutQuery
    .split("/")
    .map((segment) => (segment.includes("${") ? ":param" : segment))
    .join("/");

  if (path === "" && baseIdentifier === null) return null;
  if (path !== "" && !path.startsWith("/")) return null;

  return { baseIdentifier, path: path === "" ? "/" : path };
}

export interface BaseAlias {
  readonly baseIdentifier: string | null;
  readonly prefix: string;
}

/**
 * Bases a file derives from another, as in
 * `const mainApiV2 = `${config.performanceReviewMainApi}/v2``.
 *
 * A call through such an alias states a longer path than it appears to, and
 * reading the declaration is the difference between resolving it and reporting
 * a service the front end supposedly never reaches.
 */
export function collectBaseAliases(content: string): Map<string, BaseAlias> {
  const aliases = new Map<string, BaseAlias>();
  for (const match of content.matchAll(
    /(?:const|let|var)\s+([\w$]+)\s*=\s*`\$\{\s*([\w.$]+)\s*\}([^`$]*)`/g,
  )) {
    const prefix = match[3]!;
    if (prefix !== "" && !prefix.startsWith("/")) continue;
    aliases.set(match[1]!, { baseIdentifier: match[2]!.split(".").pop()!, prefix });
  }
  return aliases;
}

export function uiCallCapabilities(): ProviderCapabilities {
  return {
    declarations: [
      {
        kind: "outbound-call",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: [
          "calls written as a template literal through a recognized HTTP helper are read; a URL assembled across statements is not",
          "the base identifier is recorded, not resolved — which service it names is deployment configuration and is inferred separately",
          "an interpolated path segment is recorded as a parameter, since its value is not known statically",
          "a helper this reader does not recognize is not read, and its calls are absent rather than reported",
          "a base is identified by its final name, so two differently-scoped bases sharing a name are treated as one",
          "a base derived from another in the same file is followed one level; a longer chain is not",
        ],
      },
    ],
  };
}

function isSourceFile(relPath: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => relPath.endsWith(extension));
}

function scanFile(
  root: StructuralRootInput,
  relPath: string,
  calls: OutboundCallRecord[],
  failures: ExtractionFailure[],
): void {
  const content = readFileSync(join(root.path, relPath), "utf8");
  if (!/\.(get|post|put|patch|delete|head|options|request)\s*\(/.test(content)) return;

  const map = scanSource(content, { hashLineComments: false });
  const aliases = collectBaseAliases(content);

  for (const call of parseCalls(content, map, CLIENT_PATTERN)) {
    const first = call.args[0];
    if (first === undefined) continue;

    const source = {
      rootName: root.name,
      relPath,
      startLine: call.line,
      endLine: call.line,
      startColumn: positionAt(map, call.index).column,
      endColumn: null,
    };

    // `.request(...)` names its method in an options object, not in the call
    // name, so it states nothing here.
    const method = call.method === "request" ? null : call.method.toUpperCase();

    const parsed = parseUrlTemplate(first);
    if (parsed === null) {
      // A URL built somewhere else is a call whose destination is unknown,
      // which is a fact worth keeping — dropping it would make the front end
      // look like it talks to fewer services than it does.
      const literal = /^['"]([^'"]*)['"]$/.exec(first.trim());
      if (literal && literal[1]!.startsWith("/")) {
        calls.push({
          rootName: root.name,
          target: literal[1]!,
          kind: "http",
          method,
          callerSymbolId: null,
          baseIdentifier: null,
          provenance: resolved(source, "high"),
        });
        continue;
      }

      calls.push({
        rootName: root.name,
        target: null,
        kind: "http",
        method,
        callerSymbolId: null,
        baseIdentifier: null,
        provenance: inferred(source, "low"),
      });
      failures.push({
        scope: `${relPath}:${call.line}`,
        reason: "the request URL is not a template literal or path string at the call site",
      });
      continue;
    }

    const alias = parsed.baseIdentifier === null ? undefined : aliases.get(parsed.baseIdentifier);
    const baseIdentifier = alias ? alias.baseIdentifier : parsed.baseIdentifier;
    const path = alias ? `${alias.prefix}${parsed.path === "/" ? "" : parsed.path}` : parsed.path;

    calls.push({
      rootName: root.name,
      target: path === "" ? "/" : path,
      kind: "http",
      method,
      callerSymbolId: null,
      baseIdentifier,
      provenance: resolved(source, baseIdentifier === null ? "medium" : "high"),
    });
  }
}

export function createUiCallsProvider(): StructuralProvider {
  const capabilities = uiCallCapabilities();

  return {
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,
    capabilities: () => declaredKinds(capabilities),
    preflight: (): PreflightResult => ({ available: true, version: PROVIDER_VERSION }),
    structuralCapabilities: () => capabilities,

    extract(root: StructuralRootInput): StructuralContribution {
      const calls: OutboundCallRecord[] = [];
      const failures: ExtractionFailure[] = [];

      for (const relPath of root.analyzedFiles) {
        if (!isSourceFile(relPath)) continue;
        try {
          scanFile(root, relPath, calls, failures);
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
        records: { ...emptyRecords(), "outbound-call": calls },
        gaps: [],
        failures,
      };
    },
  };
}
