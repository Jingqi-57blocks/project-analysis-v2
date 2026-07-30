/**
 * The entire CodeGraph surface this tool touches. If `grep -r codegraph engine/`
 * hits anything outside this directory, the boundary has leaked.
 *
 * Queries go through the documented CLI. The index database inside
 * `.codegraph/` is never read — that store is theirs to change between
 * versions.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

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
 * Refuses with a reason rather than a bare null, because the reason is
 * persisted as the gap for every kind this provider would have supplied — and a
 * gap that misdescribes itself sends a reader looking in the wrong place.
 */
export type IndexRootChoice =
  | { readonly path: string; readonly refusal?: undefined }
  | { readonly path?: undefined; readonly refusal: string };

export function sharedIndexRoot(rootPaths: readonly string[]): IndexRootChoice {
  if (rootPaths.length === 0) {
    return { refusal: "no roots were named, so there is no directory to index" };
  }

  if (rootPaths.length === 1) {
    const only = resolve(rootPaths[0]!);
    const parent = dirname(only);
    if (parent === only) {
      return { refusal: `"${only}" has no parent directory, so nothing outside it can hold an index` };
    }
    return admit(parent);
  }

  const segments = rootPaths.map((path) => resolve(path).split(sep).filter((part) => part !== ""));
  const shortest = Math.min(...segments.map((parts) => parts.length));

  let common = 0;
  while (common < shortest && segments.every((parts) => parts[common] === segments[0]![common])) {
    common += 1;
  }

  // Roots on different top-level directories do share one: the filesystem root.
  // Saying they share none would be false, and `admit` already has the right
  // words for why that particular directory cannot be indexed.
  if (common === 0) return admit(sep);
  // A root that *is* the shared parent would be indexed from inside itself.
  if (segments.some((parts) => parts.length === common)) {
    return {
      refusal:
        "one of the roots is the directory holding the others, so an index there would be written inside analyzed source",
    };
  }

  return admit(`${sep}${segments[0]!.slice(0, common).join(sep)}`);
}

/**
 * Accepts a candidate parent, or says why it is too broad to index.
 *
 * A filesystem root walks the whole disk. A home directory, or anything above
 * one, is worse in kind rather than degree: it reads every unrelated project,
 * download and cache the user owns, and on a shared machine every other
 * account's too. Both arise from ordinary inputs — a repository sitting directly
 * in `~` puts its nearest parent at `~`, and `~` itself as the only root puts it
 * at `/Users`.
 *
 * Compared on canonical paths, because a symlinked `HOME` is common and a
 * lexical comparison would wave it straight through. CodeGraph refuses these
 * itself without `--force`, so the run would fail anyway; refusing here turns a
 * subprocess error into a declared gap that says what happened.
 */
function admit(parent: string): IndexRootChoice {
  if (parent === sep) {
    return { refusal: "the only directory holding every root is the filesystem root, and indexing from there would walk the whole disk" };
  }

  const home = canonical(homedir());
  const candidate = canonical(parent);
  if (home !== "" && (candidate === home || isAncestor(candidate, home))) {
    return {
      refusal: `the only directory holding every root is ${parent === candidate ? parent : `${parent} (${candidate})`}, which is your home directory or above it — indexing there would read every unrelated project on the machine`,
    };
  }

  return { path: parent };
}

/** Whether `directory` contains `descendant`, by path rather than by prefix. */
function isAncestor(directory: string, descendant: string): boolean {
  const base = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return descendant.startsWith(base);
}

/**
 * A path as the filesystem spells it.
 *
 * Canonicalized as far as it exists, then the missing tail put back. Resolving
 * only paths that exist compares one canonical path against one lexical path,
 * and on a machine where `/tmp` is a symlink to `/private/tmp` those never
 * match — the mistake that made an earlier version of this guard useless, and
 * that reappears the moment `HOME` names a directory nobody has created.
 */
function canonical(path: string): string {
  if (path === "") return "";
  const resolved = resolve(path);

  let existing = resolved;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolved;
    // `basename`, not a slice: the filesystem root already ends in a separator,
    // so subtracting its length drops a character and turns "/w" into "/".
    missing.unshift(basename(existing));
    existing = parent;
  }

  try {
    return join(realpathSync.native(existing), ...missing);
  } catch {
    return resolved;
  }
}

export function isIndexed(rootPath: string): boolean {
  return existsSync(join(rootPath, INDEX_DIRECTORY));
}

/**
 * Creates `.codegraph/` inside the directory it is pointed at, which CodeGraph
 * offers no flag to relocate: `index [path]` both reads and stores at `path`.
 * Callers point it at the directory *containing* the analyzed roots for exactly
 * that reason — see `sharedIndexRoot`.
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
