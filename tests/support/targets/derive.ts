import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { digestDirectory, isIgnoredEntry } from "../../../engine/targets/digest.js";
import { TARGETS } from "./registry.js";
import { expandPath } from "./resolve.js";

/**
 * Manifest filenames recognised across the ecosystems we target. Removing one
 * produces a root that must still be analyzable, with disclosed limitations.
 */
export const MANIFEST_FILENAMES: readonly string[] = [
  "package.json",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
  "Cargo.toml",
  "composer.json",
  "Gemfile",
];

const META_FILENAME = ".derived-meta.json";

export interface DeriveOptions {
  /** Absolute path to the root being copied. */
  readonly sourceRoot: string;
  /** Where to materialise the copy. Must be gitignored. */
  readonly outputDir: string;
  /** Remove manifests, leaving a root with no declared project metadata. */
  readonly withoutManifest?: boolean;
  /** Re-copy even when the source is unchanged. */
  readonly force?: boolean;
}

export interface DeriveResult {
  readonly outputDir: string;
  readonly rebuilt: boolean;
  readonly sourceDigest: string;
  /** Files removed after copying, relative to the output directory. */
  readonly removed: readonly string[];
}

interface DerivedMeta {
  readonly sourceDigest: string;
  readonly withoutManifest: boolean;
}

function readMeta(outputDir: string): DerivedMeta | null {
  const path = join(outputDir, META_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as DerivedMeta).sourceDigest === "string" &&
      typeof (parsed as DerivedMeta).withoutManifest === "boolean"
    ) {
      return parsed as DerivedMeta;
    }
  } catch {
    // A corrupt meta file just means "rebuild".
  }
  return null;
}

/** True when `child` is `parent` or lives underneath it. */
function isAtOrUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !rel.includes(`..${sep}`);
}

/**
 * Refuses to write anywhere that could destroy real source.
 *
 * `deriveVariant` recursively removes its output directory before copying, so
 * an output path pointing at a target — through a typo, a bad default, or a
 * future caller — would delete the user's own project. Targets are read-only to
 * this tool, and that is enforced here rather than assumed.
 */
function assertSafeOutputDir(outputDir: string, sourceRoot: string): void {
  if (isAtOrUnder(outputDir, sourceRoot) || isAtOrUnder(sourceRoot, outputDir)) {
    throw new Error(
      `Refusing to derive: output ${outputDir} overlaps the source root ${sourceRoot}.`,
    );
  }

  for (const target of TARGETS) {
    const targetPath = expandPath(target.defaultPath);
    if (isAtOrUnder(outputDir, targetPath)) {
      throw new Error(
        `Refusing to derive: output ${outputDir} is inside registered target "${target.id}" (${targetPath}). ` +
          "Targets are read-only.",
      );
    }
  }

  // Only ever delete a directory this function created. Anything else — a home
  // directory, a source tree, a typo — is left untouched.
  if (existsSync(outputDir)) {
    const hasMarker = existsSync(join(outputDir, META_FILENAME));
    const isEmpty = readdirSync(outputDir).length === 0;
    if (!hasMarker && !isEmpty) {
      throw new Error(
        `Refusing to derive: ${outputDir} already exists, is not empty, and was not created by ` +
          `this tool (no ${META_FILENAME}). Remove it manually if that is intended.`,
      );
    }
  }
}

/**
 * Materialises a modified copy of one target root.
 *
 * Copies never include `.git`, so a derived variant is always non-git as well
 * as whatever else was removed. That is deliberate — it produces the hardest
 * case (no version control *and* no manifest) rather than a convenient one.
 *
 * Target source is read-only: nothing here writes to `sourceRoot`, and
 * `assertSafeOutputDir` rejects any output path that could reach real source.
 */
export function deriveVariant(options: DeriveOptions): DeriveResult {
  const sourceRoot = resolve(options.sourceRoot);
  const outputDir = resolve(options.outputDir);
  const withoutManifest = options.withoutManifest === true;

  if (!existsSync(sourceRoot)) {
    throw new Error(`Source root not found: ${sourceRoot}`);
  }

  assertSafeOutputDir(outputDir, sourceRoot);

  const sourceDigest = digestDirectory(sourceRoot);
  const existing = readMeta(outputDir);
  const upToDate =
    existing?.sourceDigest === sourceDigest && existing.withoutManifest === withoutManifest;

  if (upToDate && options.force !== true) {
    return { outputDir, rebuilt: false, sourceDigest, removed: [] };
  }

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(dirname(outputDir), { recursive: true });
  cpSync(sourceRoot, outputDir, {
    recursive: true,
    filter: (src) => !isIgnoredEntry(basename(src)),
  });

  const removed: string[] = [];
  if (withoutManifest) {
    for (const name of MANIFEST_FILENAMES) {
      const path = join(outputDir, name);
      if (existsSync(path)) {
        rmSync(path);
        removed.push(name);
      }
    }
  }

  writeFileSync(
    join(outputDir, META_FILENAME),
    `${JSON.stringify({ sourceDigest, withoutManifest } satisfies DerivedMeta, null, 2)}\n`,
  );

  return { outputDir, rebuilt: true, sourceDigest, removed };
}
