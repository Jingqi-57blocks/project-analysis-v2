/**
 * Detects calls leaving a root over a network boundary.
 *
 * A second provider rather than a branch inside the CodeGraph adapter: the
 * stated principle is that a capability gap is filled by composing another
 * provider, and this is its first real test.
 *
 * The technique is a heuristic and stays visibly one. Dynamic destinations are
 * recorded as unresolved rather than guessed — a plausible-looking wrong
 * endpoint survives review precisely because it looks right.
 */

import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { emptyRecords } from "../../structural/kinds.js";
import { inferred, lineRef, unresolved } from "../../structural/provenance.js";
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
import type { OutboundCallRecord, OutboundKind } from "../../structural/boundaries.js";

export const PROVIDER_ID = "outbound-calls";
export const PROVIDER_VERSION = "1.0.0";

const MAX_FILE_BYTES = 1_000_000;

/** Extensions worth scanning. Data and markup files name URLs that are not calls. */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".go", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".java", ".kt",
  ".swift", ".cs", ".php", ".rs", ".scala", ".dart", ".vue",
]);

// A host is required: a bare "https://" is a fragment of a URL built
// elsewhere, not a destination.
const ABSOLUTE_URL = /["'`](https?:\/\/[a-zA-Z0-9][a-zA-Z0-9.\-]*[^"'`\s]*)["'`]/g;
/** A quoted string with interpolation or concatenation immediately after a URL-ish prefix. */
const DYNAMIC_URL = /["'`](https?:\/\/[^"'`]*?)(\$\{|"\s*\+|'\s*\+|`\s*\+)/g;

/**
 * URLs that are identifiers rather than destinations — XML namespaces, schema
 * and specification URIs, licence references. Nothing ever fetches them.
 *
 * Measured before adding: `http://www.w3.org/2000/svg` was the single most
 * common match across both targets, because every file containing inline SVG
 * declares it. Reporting those as outbound calls would bury the real ones,
 * which is a worse failure than missing a call — a signal nobody trusts gets
 * ignored wholesale.
 */
const NON_ENDPOINT_HOSTS: readonly string[] = [
  "http://www.w3.org/",
  "https://www.w3.org/",
  "http://schemas.xmlsoap.org/",
  "http://schema.org/",
  "https://schema.org/",
  "http://www.apache.org/licenses/",
  "https://opensource.org/licenses/",
  "http://purl.org/",
  "http://xmlns.com/",
  "https://spdx.org/licenses/",
];

function isEndpoint(url: string): boolean {
  return !NON_ENDPOINT_HOSTS.some((prefix) => url.startsWith(prefix));
}

function kindFor(url: string): OutboundKind {
  if (url.startsWith("http")) return "http";
  return "unknown";
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === "\n") line += 1;
  return line;
}

export function outboundCapabilities(): ProviderCapabilities {
  return {
    declarations: [
      {
        kind: "outbound-call",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: [
          "absolute URL literals only; relative paths and base-URL composition are not detected",
          "destinations built at runtime are recorded as unresolved, never guessed",
          "matches are textual, so URLs in comments or documentation strings are possible",
          "XML namespace, schema and licence URIs are excluded as identifiers rather than destinations",
          "the calling symbol is not resolved here; it is attached later from source ranges",
          "this is never a complete list of what a service talks to",
        ],
      },
    ],
  };
}

function scan(root: StructuralRootInput, relPath: string, content: string): OutboundCallRecord[] {
  const found: OutboundCallRecord[] = [];
  const dynamicLines = new Set<number>();

  for (const match of content.matchAll(DYNAMIC_URL)) {
    const line = lineAt(content, match.index);
    dynamicLines.add(line);
    found.push({
      rootName: root.name,
      target: null,
      kind: "http",
      callerSymbolId: null,
      provenance: unresolved(
        lineRef(root.name, relPath, line),
        `destination is built at runtime from "${match[1]}…"`,
      ),
    });
  }

  for (const match of content.matchAll(ABSOLUTE_URL)) {
    const line = lineAt(content, match.index);
    // Already recorded as dynamic; recording it again as a fixed target would
    // assert an endpoint the code never calls.
    if (dynamicLines.has(line)) continue;

    const url = match[1]!;
    if (!isEndpoint(url)) continue;

    found.push({
      rootName: root.name,
      target: url,
      kind: kindFor(url),
      callerSymbolId: null,
      provenance: inferred(lineRef(root.name, relPath, line), "medium"),
    });
  }

  return found;
}

export function createOutboundProvider(): StructuralProvider {
  const capabilities = outboundCapabilities();

  return {
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,
    capabilities: () => declaredKinds(capabilities),
    preflight: (): PreflightResult => ({ available: true, version: PROVIDER_VERSION }),
    structuralCapabilities: () => capabilities,

    extract: (root: StructuralRootInput): StructuralContribution => {
      const calls: OutboundCallRecord[] = [];
      const failures: ExtractionFailure[] = [];

      for (const relPath of root.analyzedFiles) {
        if (!CODE_EXTENSIONS.has(extname(relPath).toLowerCase())) continue;

        const full = join(root.path, relPath);
        try {
          if (statSync(full).size > MAX_FILE_BYTES) {
            failures.push({ scope: relPath, reason: "file exceeds the scan size limit" });
            continue;
          }
          calls.push(...scan(root, relPath, readFileSync(full, "utf8")));
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
