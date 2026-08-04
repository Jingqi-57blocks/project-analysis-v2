/**
 * The entire CodeGraph surface this tool touches. If `grep -r codegraph engine/`
 * hits anything outside this directory, the boundary has leaked.
 *
 * Queries go through the documented CLI. Its index database is read too, by
 * `batchdb.ts` beside this file — CodeGraph 1.5 has no batch edge export, and
 * the alternative was one subprocess per symbol. That store is theirs to change
 * between versions, so the read is pinned: `VERIFIED_VERSION` here and
 * `SUPPORTED_DB_SCHEMA` there, and a run against anything else refuses rather
 * than degrading. Silently falling back to the CLI produced a report with every
 * chapter present and no call relationships in any of them.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** The version this adapter was written and verified against. */
export const VERIFIED_VERSION = "1.5.0";

/** Where CodeGraph puts its index. Named here only to detect prior indexing — never opened here. */
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

/**
 * The directory that holds every root.
 *
 * Indexing there once is cheaper and tidier than an index inside each root:
 * the directory containing a set of repositories is usually not a repository
 * itself, so nothing is written into any of them and no ignore file needs
 * changing.
 *
 * Applies to a single root too, and that is the point rather than an edge
 * case. Requiring two roots looked harmless — with one root there is no
 * sharing to do — but the fallback was an index written inside the analyzed
 * repository, so the guarantee that analyzed source is never written to held
 * only for workspaces that happened to have more than one part. The cost is
 * that the index covers the root's siblings as well; every query is scoped by
 * path prefix afterwards, so what a run reports is unaffected.
 *
 * Returns null only when the answer would be a filesystem root, since indexing
 * from there would walk the whole disk.
 */
export function sharedIndexRoot(rootPaths: readonly string[]): string | null {
  if (rootPaths.length === 0) return null;
  if (rootPaths.length === 1) {
    const parent = dirname(resolve(rootPaths[0]!));
    return parent === sep || parent === resolve(rootPaths[0]!) ? null : parent;
  }

  const segments = rootPaths.map((path) => resolve(path).split(sep).filter((part) => part !== ""));
  const shortest = Math.min(...segments.map((parts) => parts.length));

  let common = 0;
  while (common < shortest && segments.every((parts) => parts[common] === segments[0]![common])) {
    common += 1;
  }

  // Every root must sit below the parent, not be the parent.
  if (common === 0 || segments.some((parts) => parts.length === common)) return null;
  const parent = `${sep}${segments[0]!.slice(0, common).join(sep)}`;
  return parent === sep ? null : parent;
}

export function isIndexed(rootPath: string): boolean {
  return existsSync(join(rootPath, INDEX_DIRECTORY));
}

/**
 * Writes `.codegraph/` inside the directory it is pointed at, which CodeGraph
 * offers no flag to relocate. Callers point it at the directory *containing*
 * the analyzed roots for exactly that reason — see `sharedIndexRoot`.
 */
export function ensureIndexed(rootPath: string): void {
  run(isIndexed(rootPath) ? ["index", "-q", rootPath] : ["init", rootPath]);
}

const LOCK_DIRECTORY = ".codegraph.lock";
const LOCK_POLL_MS = 200;
const LOCK_WAIT_MS = 180_000;
/** Long enough that no live run holds a lock this old; short enough to recover. */
const LOCK_STALE_MS = 900_000;

function lockAge(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Serializes indexing and querying of one directory across processes.
 *
 * Rebuilding an index is not atomic: while it runs, a query against the same
 * directory returns nothing. Nothing about that reads as an error — the caller
 * gets an empty result and reports a codebase with no symbols, which is the
 * most damaging shape a wrong answer can take here. Two analyses over the same
 * parent directory is an ordinary thing to do, so they have to take turns.
 *
 * `mkdir` is the lock because it is atomic on every filesystem this runs on.
 * A lock older than fifteen minutes is broken rather than waited on: a crashed
 * run must not make the directory permanently unusable.
 */
export function withIndexLock<T>(rootPath: string, work: () => T): T {
  const lockPath = join(rootPath, LOCK_DIRECTORY);
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      // Only an existing lock means someone else is working. A missing parent
      // or a read-only filesystem would otherwise spin for three minutes and
      // then blame a lock that was never there.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (lockAge(lockPath) > LOCK_STALE_MS) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Another run has been indexing ${rootPath} for over ${Math.round(LOCK_WAIT_MS / 1000)}s. ` +
            `Wait for it to finish, or remove ${lockPath} if nothing is running.`,
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }

  try {
    return work();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
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
