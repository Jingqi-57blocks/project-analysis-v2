/**
 * Materialises a runnable copy of the demo fixture.
 *
 * The committed fixture source contains no `.git` anywhere — a nested `.git`
 * would make git treat the fixture root as a submodule of this repository.
 * Instead the source is copied to a gitignored directory and git roots are
 * initialised there.
 *
 *   fixtures/demo-workspace/            committed source, no git
 *   fixtures/.prepared/demo-workspace/  runnable copy, real git roots
 *
 * The copy is rebuilt only when the source changes, so re-running is a no-op.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Directories never copied into a prepared fixture. */
const IGNORED_ENTRIES = new Set([".git", "node_modules", ".DS_Store"]);

/** Appended to a tracked file to leave a working tree dirty. */
const DIRTY_MARKER = "\n<!-- uncommitted local edit (fixture dirty-tree marker) -->\n";

/** Created instead when a root has no README to modify. */
const DIRTY_FALLBACK_FILE = "LOCAL_SCRATCH.md";

export interface RootPlan {
  /** Directory name directly under the workspace root. */
  readonly name: string;
  /** Whether this root should be a git repository. */
  readonly git: boolean;
  /** Whether to leave uncommitted changes in the working tree. */
  readonly dirty?: boolean;
}

/**
 * The demo workspace deliberately mixes git and non-git roots so downstream
 * stages cannot quietly assume either.
 */
export const DEMO_WORKSPACE_ROOTS: readonly RootPlan[] = [
  { name: "frontend", git: true },
  { name: "gateway", git: true, dirty: true },
  { name: "auth", git: false },
  { name: "shared-lib", git: false },
];

export interface RootResult {
  readonly root: string;
  /** False when the directory does not exist in the source yet. */
  readonly present: boolean;
  /** Null when the root is absent. */
  readonly isGitRepo: boolean | null;
  /** Null when the root is absent or not a git repository. */
  readonly isDirty: boolean | null;
  /** What this run changed. Empty means nothing was done. */
  readonly actions: readonly string[];
}

export interface PrepareResult {
  readonly outputDir: string;
  /** False when the existing copy already matched the source. */
  readonly rebuilt: boolean;
  readonly sourceDigest: string;
  readonly roots: readonly RootResult[];
}

export interface PrepareOptions {
  readonly sourceDir: string;
  readonly outputDir: string;
  readonly roots?: readonly RootPlan[];
  /** Rebuild even when the source digest is unchanged. */
  readonly force?: boolean;
}

interface FixtureMeta {
  readonly sourceDigest: string;
}

const META_FILENAME = ".fixture-meta.json";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args as string[], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Recursively lists files under `dir`, relative and sorted for stable hashing. */
function listFiles(dir: string, base: string = dir): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_ENTRIES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFiles(full, base));
    } else if (entry.isFile()) {
      found.push(relative(base, full));
    }
  }
  return found.sort();
}

/**
 * Content digest over the source tree. Covers paths and bytes, so a rename or
 * an edit both change it; deliberately ignores mtimes so a fresh checkout of
 * unchanged content is still recognised as unchanged.
 */
export function digestDirectory(dir: string): string {
  const hash = createHash("sha256");
  for (const rel of listFiles(dir)) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(dir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readMeta(outputDir: string): FixtureMeta | null {
  const metaPath = join(outputDir, META_FILENAME);
  if (!existsSync(metaPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as FixtureMeta).sourceDigest === "string"
    ) {
      return parsed as FixtureMeta;
    }
  } catch {
    // A corrupt meta file just means "rebuild".
  }
  return null;
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

function isDirty(dir: string): boolean {
  return git(dir, ["status", "--porcelain"]).length > 0;
}

/** Initialises a git repository and commits everything currently present. */
function initGitRoot(dir: string, rootName: string): string[] {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-q",
    "-m",
    `Initial commit for ${rootName} fixture root`,
  ]);
  return [`initialised git repository`];
}

/** Leaves an uncommitted edit so the root reads as a dirty working tree. */
function makeDirty(dir: string): string[] {
  const readme = join(dir, "README.md");
  if (existsSync(readme)) {
    appendFileSync(readme, DIRTY_MARKER);
    return ["left README.md modified (dirty working tree)"];
  }
  writeFileSync(
    join(dir, DIRTY_FALLBACK_FILE),
    "Uncommitted local scratch file (fixture dirty-tree marker).\n",
  );
  return [`created untracked ${DIRTY_FALLBACK_FILE} (dirty working tree)`];
}

function prepareRoot(workspaceDir: string, plan: RootPlan, freshCopy: boolean): RootResult {
  const dir = join(workspaceDir, plan.name);

  if (!existsSync(dir)) {
    return { root: plan.name, present: false, isGitRepo: null, isDirty: null, actions: [] };
  }

  const actions: string[] = [];

  if (plan.git) {
    if (!isGitRepo(dir)) actions.push(...initGitRoot(dir, plan.name));
    if (plan.dirty === true && !isDirty(dir)) actions.push(...makeDirty(dir));
  } else if (isGitRepo(dir) && freshCopy) {
    // Only possible if the source tree wrongly contains a .git; the copy
    // filter drops it, so reaching here means something else created one.
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    actions.push("removed unexpected .git (root must not be a git repository)");
  }

  const repo = isGitRepo(dir);
  return {
    root: plan.name,
    present: true,
    isGitRepo: repo,
    isDirty: repo ? isDirty(dir) : null,
    actions,
  };
}

export function prepareFixture(options: PrepareOptions): PrepareResult {
  const sourceDir = resolve(options.sourceDir);
  const outputDir = resolve(options.outputDir);
  const roots = options.roots ?? DEMO_WORKSPACE_ROOTS;

  if (!existsSync(sourceDir)) {
    throw new Error(`Fixture source not found: ${sourceDir}`);
  }

  const sourceDigest = digestDirectory(sourceDir);
  const existing = readMeta(outputDir);
  const rebuilt = options.force === true || existing?.sourceDigest !== sourceDigest;

  if (rebuilt) {
    rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(dirname(outputDir), { recursive: true });
    cpSync(sourceDir, outputDir, {
      recursive: true,
      filter: (src) => !IGNORED_ENTRIES.has(src.split("/").pop() ?? ""),
    });
    writeFileSync(
      join(outputDir, META_FILENAME),
      `${JSON.stringify({ sourceDigest } satisfies FixtureMeta, null, 2)}\n`,
    );
  }

  const results = roots.map((plan) => prepareRoot(outputDir, plan, rebuilt));

  return { outputDir, rebuilt, sourceDigest, roots: results };
}

function describe(result: PrepareResult): string {
  const lines: string[] = [];
  lines.push(result.rebuilt ? `Prepared ${result.outputDir}` : `Up to date: ${result.outputDir}`);

  for (const root of result.roots) {
    if (!root.present) {
      lines.push(`  ${root.root.padEnd(12)} not present in source yet`);
      continue;
    }
    const state = root.isGitRepo ? (root.isDirty ? "git (dirty)" : "git (clean)") : "no git";
    lines.push(`  ${root.root.padEnd(12)} ${state}`);
    for (const action of root.actions) lines.push(`  ${"".padEnd(12)}   ${action}`);
  }

  const changed = result.rebuilt || result.roots.some((r) => r.actions.length > 0);
  if (!changed) lines.push("  nothing to do");

  return lines.join("\n");
}

function main(argv: readonly string[]): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = prepareFixture({
    sourceDir: join(repoRoot, "fixtures", "demo-workspace"),
    outputDir: join(repoRoot, "fixtures", ".prepared", "demo-workspace"),
    force: argv.includes("--force"),
  });
  console.log(describe(result));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
