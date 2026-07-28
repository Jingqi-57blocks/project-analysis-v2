/**
 * Collects human-meaningful text that sits inside code: doc comments, test
 * names, and UI labels.
 *
 * Test names are unusually valuable — a case reading "rejects an order with an
 * expired card" states a business rule no amount of structural analysis would
 * recover.
 *
 * Nothing here requires the structural model. Evidence attaches to a file and
 * range, which is what lets this run in parallel with extraction rather than
 * serialized behind it.
 */

import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { declared, inferred, lineRef } from "../structural/provenance.js";
import type {
  CollectionFailure,
  CollectorCapabilities,
  EvidenceGap,
  EvidenceItem,
  SemanticCollector,
  SemanticContribution,
  SemanticRootInput,
} from "../semantic/types.js";

export const COLLECTOR_ID = "code-text";
export const COLLECTOR_VERSION = "1.0.0";

const MAX_FILE_BYTES = 1_000_000;

/** Languages whose comment syntax this collector understands. */
const SLASH_COMMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".go", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".java", ".kt",
  ".swift", ".cs", ".rs", ".scala", ".dart", ".php", ".c", ".h", ".cpp", ".hpp",
]);
const HASH_COMMENT_EXTENSIONS: ReadonlySet<string> = new Set([".py", ".rb", ".sh", ".yaml", ".yml"]);

/**
 * Test declarations across the common frameworks.
 *
 * The leading `(?<![.\w])` is load-bearing. Without it, `.test("...")` matches
 * — and in a Yup or Joi schema that is a *validator*, not a test. Measured on
 * a real React codebase: every one of the nine "test names" found was a
 * validation rule, which would have told a reader the project has tests it
 * does not have.
 */
const TEST_NAME_PATTERNS: readonly RegExp[] = [
  /(?<![.\w])(?:it|test|describe|context)\s*\(\s*["'`]([^"'`]{3,200})["'`]/g,
  /\bfunc\s+(Test[A-Za-z0-9_]{2,120})\s*\(/g,
  /\bdef\s+(test_[A-Za-z0-9_]{2,120})\s*\(/g,
];

/** Markup attributes and elements that carry text a user actually sees. */
const UI_LABEL_PATTERNS: readonly RegExp[] = [
  /(?:label|title|placeholder|aria-label)\s*=\s*["']([^"'{}<>]{2,120})["']/g,
  />\s*([A-Z][A-Za-z0-9 ,.'’!?-]{3,80})\s*</g,
];

const UI_EXTENSIONS: ReadonlySet<string> = new Set([".vue", ".jsx", ".tsx", ".html", ".svelte"]);

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === "\n") line += 1;
  return line;
}

/**
 * Block and consecutive line comments, with markup stripped.
 *
 * Consecutive `//` lines are joined into one item: a five-line comment is one
 * thought, and splitting it into five fragments would lose the thought while
 * keeping the words.
 */
export function docComments(content: string, extension: string): readonly { text: string; line: number }[] {
  const found: { text: string; line: number }[] = [];

  if (SLASH_COMMENT_EXTENSIONS.has(extension)) {
    for (const match of content.matchAll(/\/\*\*?([\s\S]*?)\*\//g)) {
      const text = match[1]!
        .split("\n")
        .map((line) => line.replace(/^\s*\*?\s?/, "").trimEnd())
        .join("\n")
        .trim();
      if (text.length >= 3) found.push({ text, line: lineAt(content, match.index) });
    }

    const lines = content.split("\n");
    let buffer: string[] = [];
    let start = 0;
    lines.forEach((line, index) => {
      const match = /^\s*\/\/\s?(.*)$/.exec(line);
      if (match) {
        if (buffer.length === 0) start = index + 1;
        buffer.push(match[1]!.trim());
        return;
      }
      if (buffer.length > 0) {
        const text = buffer.join(" ").trim();
        if (text.length >= 3) found.push({ text, line: start });
        buffer = [];
      }
    });
    if (buffer.length > 0) {
      const text = buffer.join(" ").trim();
      if (text.length >= 3) found.push({ text, line: start });
    }
  }

  if (HASH_COMMENT_EXTENSIONS.has(extension)) {
    content.split("\n").forEach((line, index) => {
      const match = /^\s*#\s?(.+)$/.exec(line);
      if (match && match[1]!.trim().length >= 3) {
        found.push({ text: match[1]!.trim(), line: index + 1 });
      }
    });
  }

  return found;
}

function capabilities(): CollectorCapabilities {
  const commentLanguages = [...SLASH_COMMENT_EXTENSIONS, ...HASH_COMMENT_EXTENSIONS].join(", ");
  return {
    declarations: [
      {
        kind: "doc-comment",
        language: "*",
        support: "partial",
        limits: [
          `comment syntax understood for: ${commentLanguages}`,
          "a language with other comment syntax yields a declared gap rather than silence",
          "comments are not attached to the symbol they document unless a structural model is present",
        ],
      },
      {
        kind: "test-name",
        language: "*",
        support: "partial",
        limits: [
          "common framework conventions only; a bespoke test harness is not recognized",
          "method-call forms such as schema.test(...) are excluded, since those are validators rather than tests",
        ],
      },
      {
        kind: "ui-label",
        language: "*",
        support: "partial",
        limits: [
          "matched from markup attributes and text nodes, so the set includes strings a user never sees",
          "recorded as inferred rather than as a definitive list of visible text",
        ],
      },
    ],
  };
}

export function createCodeTextCollector(): SemanticCollector {
  return {
    id: COLLECTOR_ID,
    version: COLLECTOR_VERSION,
    capabilities,

    collect(root: SemanticRootInput): SemanticContribution {
      const items: EvidenceItem[] = [];
      const failures: CollectionFailure[] = [];
      const gaps: EvidenceGap[] = [];
      const unknownExtensions = new Set<string>();

      for (const relPath of root.analyzedFiles) {
        const extension = extname(relPath).toLowerCase();
        const known =
          SLASH_COMMENT_EXTENSIONS.has(extension) || HASH_COMMENT_EXTENSIONS.has(extension);
        if (!known && !UI_EXTENSIONS.has(extension)) {
          if (extension !== "") unknownExtensions.add(extension);
          continue;
        }

        const full = join(root.path, relPath);
        try {
          if (statSync(full).size > MAX_FILE_BYTES) {
            failures.push({ scope: relPath, reason: "file exceeds the read size limit" });
            continue;
          }
          const content = readFileSync(full, "utf8");

          for (const comment of docComments(content, extension)) {
            const source = lineRef(root.name, relPath, comment.line);
            items.push({
              rootName: root.name,
              kind: "doc-comment",
              text: comment.text,
              label: null,
              symbolId: null,
              source,
              provenance: declared(source),
            });
          }

          for (const pattern of TEST_NAME_PATTERNS) {
            const regex = new RegExp(pattern.source, pattern.flags);
            let match: RegExpExecArray | null;
            while ((match = regex.exec(content)) !== null) {
              const source = lineRef(root.name, relPath, lineAt(content, match.index));
              items.push({
                rootName: root.name,
                kind: "test-name",
                text: match[1]!,
                label: null,
                symbolId: null,
                source,
                // The string is verbatim, but calling it a *test name* is a
                // judgement about the surrounding call — so inferred, not
                // declared.
                provenance: inferred(source, "high"),
              });
              if (match.index === regex.lastIndex) regex.lastIndex += 1;
            }
          }

          if (UI_EXTENSIONS.has(extension)) {
            for (const pattern of UI_LABEL_PATTERNS) {
              const regex = new RegExp(pattern.source, pattern.flags);
              let match: RegExpExecArray | null;
              while ((match = regex.exec(content)) !== null) {
                const text = match[1]!.trim();
                if (text === "") continue;
                const source = lineRef(root.name, relPath, lineAt(content, match.index));
                items.push({
                  rootName: root.name,
                  kind: "ui-label",
                  text,
                  label: null,
                  symbolId: null,
                  // Markup text includes strings a user never sees, so this is
                  // evidence of a label rather than proof of one.
                  source,
                  provenance: inferred(source, "low"),
                });
                if (match.index === regex.lastIndex) regex.lastIndex += 1;
              }
            }
          }
        } catch (error) {
          failures.push({
            scope: relPath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      for (const extension of [...unknownExtensions].sort()) {
        gaps.push({
          kind: "doc-comment",
          language: extension,
          reason: `comment syntax for ${extension} files is not recognized, so their comments were not read`,
        });
      }

      return {
        collectorId: COLLECTOR_ID,
        collectorVersion: COLLECTOR_VERSION,
        rootName: root.name,
        items,
        gaps,
        failures,
      };
    },
  };
}
