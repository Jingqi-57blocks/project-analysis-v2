/**
 * Copies the diagram renderer into the report directory.
 *
 * A report is read from a laptop, an attachment, or a share that has no
 * internet — so a CDN link is a diagram that renders for the author and not
 * for the reader. The library is a development dependency copied at generation
 * time, which keeps a 3MB file out of this repository's history while leaving
 * every generated report self-contained.
 *
 * When it cannot be found the pages still work: the diagram source stays
 * visible as text, which is worse to look at but not a lie.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const MERMAID_FILENAME = "mermaid.min.js";

/** Where the installed library's bundle lives, or null if it is not installed. */
export function findMermaidBundle(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("mermaid/package.json");
    const bundle = join(dirname(entry), "dist", MERMAID_FILENAME);
    return existsSync(bundle) ? bundle : null;
  } catch {
    return null;
  }
}

/** True when the renderer is now present in the output directory. */
export function copyReportAssets(outputDir: string): boolean {
  const bundle = findMermaidBundle();
  if (bundle === null) return false;

  mkdirSync(outputDir, { recursive: true });
  copyFileSync(bundle, join(outputDir, MERMAID_FILENAME));
  return true;
}
