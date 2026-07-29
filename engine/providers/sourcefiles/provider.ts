/**
 * Source-file records from the walk that already visited them.
 *
 * The inventory has been to every one of these files: it applied the exclusion
 * rules, knows why anything was skipped, and its answer cannot disagree with
 * the file table in the same snapshot. An indexer supplying the same kind is a
 * second opinion about a fact nobody needs two of.
 *
 * The one thing inventory has no basis to know is the language, so that is all
 * this adds — and null where the extension does not say, rather than a guess.
 */

import { declared, lineRef } from "../../structural/provenance.js";
import { languageOf } from "../../text/ast.js";
import { emptyRecords } from "../../structural/kinds.js";
import { ANY_LANGUAGE, type StructuralProvider } from "../../structural/provider.js";
import type { SourceFileRecord } from "../../structural/code.js";

/** Language by extension, for the ones the AST layer does not name. */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  ".py": "python",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".cs": "csharp",
  ".php": "php",
  ".rs": "rust",
  ".swift": "swift",
  ".scala": "scala",
  ".dart": "dart",
  ".sql": "sql",
  ".sh": "shell",
  ".vue": "vue",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".md": "markdown",
};

export function languageFor(relPath: string): string | null {
  const parsed = languageOf(relPath);
  if (parsed !== null) return parsed;
  const dot = relPath.lastIndexOf(".");
  return dot === -1 ? null : (BY_EXTENSION[relPath.slice(dot).toLowerCase()] ?? null);
}

export function sourceFileRecords(
  rootName: string,
  analyzedFiles: readonly string[],
): readonly SourceFileRecord[] {
  return analyzedFiles.map((relPath) => ({
    rootName,
    relPath,
    language: languageFor(relPath),
    provenance: declared(lineRef(rootName, relPath, 1)),
  }));
}

export const PROVIDER_ID = "source-files";
export const PROVIDER_VERSION = "1.0.0";

export function createSourceFileProvider(): StructuralProvider {
  return {
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,
    capabilities: () => ["source-file"],
    preflight: () => ({ available: true, version: PROVIDER_VERSION }),

    structuralCapabilities: () => ({
      declarations: [
        {
          kind: "source-file",
          language: ANY_LANGUAGE,
          support: "full",
          limits: [
            "the language is named from the file extension, so a file whose extension does not state one is recorded with none rather than guessed at",
          ],
        },
      ],
    }),

    extract: (root) => ({
      providerId: PROVIDER_ID,
      providerVersion: PROVIDER_VERSION,
      rootName: root.name,
      records: { ...emptyRecords(), "source-file": sourceFileRecords(root.name, root.analyzedFiles) },
      gaps: [],
      failures: [],
    }),
  };
}
