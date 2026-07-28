/**
 * The entire CodeGraph surface this tool touches.
 *
 * Everything vendor-specific is confined to this directory: if
 * `grep -r codegraph engine/` hits anything outside `providers/codegraph/`,
 * the boundary has leaked and the vendor has become load-bearing somewhere it
 * should not be.
 *
 * Queries go through the documented CLI with `--json`. The index database
 * inside `.codegraph/` is never read directly — that store is theirs to change
 * between versions, and reading it would couple us to something they never
 * promised to keep stable.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The version this adapter was written and verified against. */
export const VERIFIED_VERSION = "1.5.0";

/** Where CodeGraph puts its index. Named here only to detect prior indexing — never opened. */
const INDEX_DIRECTORY = ".codegraph";

/**
 * Upper bound on nodes fetched in one query.
 *
 * A cap rather than unbounded paging, and declared as a capability limit so a
 * repository large enough to hit it reports a truncation rather than silently
 * describing part of itself as the whole.
 */
export const NODE_LIMIT = 100_000;

export interface CodeGraphNode {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly qualifiedName: string | null;
  readonly filePath: string;
  readonly language: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly startColumn: number | null;
  readonly endColumn: number | null;
  readonly signature?: string | null;
  readonly visibility?: string | null;
  readonly isExported?: boolean;
}

export interface CodeGraphFile {
  readonly path: string;
  readonly language: string | null;
  readonly nodeCount: number;
  readonly size: number;
}

export interface CodeGraphRelation {
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly startLine: number | null;
}

function run(args: readonly string[], cwd?: string): string {
  return execFileSync("codegraph", args, {
    encoding: "utf8",
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Parses CLI JSON, tolerating the banner lines the tool prints alongside it.
 *
 * The CLI mixes human-facing notices (telemetry notice, update checks) with
 * `--json` output, so the payload is located rather than assumed to start at
 * byte zero. Assuming would make the adapter break on an unrelated day when a
 * new notice appears.
 */
function parseJson<T>(output: string): T {
  const trimmed = output.trim();
  const start = trimmed.search(/[[{]/);
  if (start === -1) throw new Error(`CodeGraph returned no JSON: ${trimmed.slice(0, 200)}`);
  return JSON.parse(trimmed.slice(start)) as T;
}

/** The installed version, or null when CodeGraph is not on PATH. */
export function codegraphVersion(): string | null {
  try {
    return run(["--version"]).trim();
  } catch {
    return null;
  }
}

export function isIndexed(rootPath: string): boolean {
  return existsSync(join(rootPath, INDEX_DIRECTORY));
}

/**
 * Builds or refreshes the index for a root.
 *
 * This writes `.codegraph/` inside the analyzed root — CodeGraph offers no
 * flag to relocate it. That is an accepted, bounded exception to the read-only
 * guarantee toward analyzed source: `.codegraph/` is excluded from content
 * digests and recorded as an excluded entry in inventory, so indexing cannot
 * masquerade as a source change or as project content.
 */
export function ensureIndexed(rootPath: string): void {
  run(isIndexed(rootPath) ? ["index", "-q", rootPath] : ["init", rootPath]);
}

/**
 * Every node in the index, in one call.
 *
 * An empty search with no kind filter returns all kinds, including ones this
 * adapter has never heard of. That matters for a tool meant to read any
 * language: a per-kind enumeration would silently omit whatever the next
 * language introduces, whereas this carries unknown kinds through to the
 * model's open unions.
 */
export function queryNodes(rootPath: string, limit: number = NODE_LIMIT): readonly CodeGraphNode[] {
  const raw = parseJson<{ node: CodeGraphNode }[]>(
    run(["query", "", "--limit", String(limit), "--json", "-p", rootPath]),
  );
  return raw.map((entry) => entry.node);
}

export function listFiles(rootPath: string): readonly CodeGraphFile[] {
  return parseJson<CodeGraphFile[]>(run(["files", "--json", "-p", rootPath]));
}

/**
 * What a symbol calls.
 *
 * Callees rather than callers: one direction is enough to build the edge set,
 * and querying both would double the subprocess cost for the same graph.
 */
export function calleesOf(rootPath: string, symbol: string, limit = 200): readonly CodeGraphRelation[] {
  const parsed = parseJson<{ callees?: CodeGraphRelation[] }>(
    run(["callees", symbol, "--limit", String(limit), "--json", "-p", rootPath]),
  );
  return parsed.callees ?? [];
}
