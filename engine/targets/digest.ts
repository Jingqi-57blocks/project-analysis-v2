import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Entries never contributing to a content digest. Version-control internals and
 * installed dependencies are not the source we are identifying.
 */
export const IGNORED_ENTRIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
]);

/** Files under `dir`, relative to it, sorted so hashing is order-independent. */
export function listFiles(dir: string, base: string = dir): string[] {
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
 * Content digest over a directory tree.
 *
 * Covers relative paths and file bytes, so an edit, a rename, an addition and a
 * deletion all change it. Deliberately ignores mtimes and file order, so a
 * fresh checkout of identical content digests identically.
 *
 * This is the identity for roots with no version control, and the drift check
 * for roots that have one.
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
