/**
 * The entire CodeGraph surface this tool touches. If `grep -r codegraph engine/`
 * hits anything outside this directory, the boundary has leaked.
 *
 * Queries go through the documented CLI. The index database inside
 * `.codegraph/` is never read — that store is theirs to change between
 * versions.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The version this adapter was written and verified against. */
export const VERIFIED_VERSION = "1.5.0";

/** Where CodeGraph puts its index. Named here only to detect prior indexing — never opened. */
const INDEX_DIRECTORY = ".codegraph";

/** Declared as a capability limit, so hitting it reports truncation rather than a partial whole. */
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
 * The CLI mixes human-facing notices with `--json` output, so the payload is
 * located rather than assumed to start at byte zero.
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
 * Writes `.codegraph/` inside the analyzed root, which CodeGraph offers no flag
 * to relocate. An accepted, bounded exception: the directory is excluded from
 * content digests and recorded as excluded in inventory, so indexing cannot
 * masquerade as a source change or as project content.
 */
export function ensureIndexed(rootPath: string): void {
  run(isIndexed(rootPath) ? ["index", "-q", rootPath] : ["init", rootPath]);
}

/**
 * An empty search with no kind filter returns every kind, including ones this
 * adapter has never heard of. A per-kind enumeration would silently omit
 * whatever the next language introduces.
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

/** Callees rather than callers: one direction builds the same edge set at half the cost. */
export const CALLEE_LIMIT = 200;

export function calleesOf(
  rootPath: string,
  symbol: string,
  limit: number = CALLEE_LIMIT,
): readonly CodeGraphRelation[] {
  const parsed = parseJson<{ callees?: CodeGraphRelation[] }>(
    run(["callees", symbol, "--limit", String(limit), "--json", "-p", rootPath]),
  );
  return parsed.callees ?? [];
}
