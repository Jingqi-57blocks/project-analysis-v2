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
import type { SgNode } from "@ast-grep/napi";

import { declared, inferred, offsetRef } from "../structural/provenance.js";
import { languageOf, parseSource } from "../text/ast.js";
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
export const COLLECTOR_VERSION = "2.0.0";

const MAX_FILE_BYTES = 1_000_000;
const SOURCE_EXCERPT_LINES = 90;
const SOURCE_EXCERPT_CHARS = 7_000;
const MAX_SOURCE_EXCERPTS_PER_FILE = 120;

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
  // Go requires the exported `Test` prefix; Swift's XCTest uses lowercase
  // `test`. One pattern covering both would match any function starting with
  // "test" in every language, so they stay separate and explicit.
  /\bfunc\s+(Test[A-Za-z0-9_]{2,120})\s*\(/g,
  /\bfunc\s+(test[A-Za-z0-9_]{2,120})\s*\(/g,
  /\bdef\s+(test_[A-Za-z0-9_]{2,120})\s*\(/g,
  // JUnit and friends annotate rather than name-prefix, so the following
  // method name is the test's identity.
  /@Test\b[\s\S]{0,200}?\b(?:void|fun)\s+([A-Za-z_][A-Za-z0-9_]{2,120})\s*\(/g,
  /#\[test\][\s\S]{0,200}?\bfn\s+([A-Za-z_][A-Za-z0-9_]{2,120})\s*\(/g,
];

/**
 * Languages whose test conventions the patterns above cover.
 *
 * A file in a comment-supported language absent from this list gets a declared
 * gap rather than silence: `doc-comment` support is not `test-name` support,
 * and letting the second ride on the first would report a project as untested
 * when nobody looked.
 */
const TEST_CONVENTION_EXTENSIONS: ReadonlySet<string> = new Set([
  ".go", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py",
  ".swift", ".java", ".kt", ".rs",
]);

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

export interface SourceExcerpt {
  readonly text: string;
  readonly label: string;
  readonly index: number;
  readonly startLine: number;
  readonly endLine: number;
}

function nodeKind(node: SgNode): string {
  return node.kind() as string;
}

function positionOffset(content: string, line: number, column: number): number {
  let offset = 0;
  let current = 0;
  while (current < line && offset < content.length) {
    const next = content.indexOf("\n", offset);
    if (next === -1) return content.length;
    offset = next + 1;
    current += 1;
  }
  return Math.min(content.length, offset + column);
}

function functionLabel(node: SgNode): string {
  const direct = node.field("name")?.text().trim() ?? "";
  if (direct !== "") return direct;
  const parent = node.parent();
  if (parent !== null && nodeKind(parent) === "variable_declarator") {
    return parent.field("name")?.text().trim() || "anonymous function";
  }
  return "anonymous function";
}

function functionNodes(root: SgNode): readonly SgNode[] {
  const nodes: SgNode[] = [];
  const declarationKinds = [
    "function_declaration",
    "generator_function_declaration",
    "method_declaration",
    "method_definition",
  ];
  for (const kind of declarationKinds) {
    try {
      nodes.push(...root.findAll({ rule: { kind: kind as never } }));
    } catch {
      // Grammar-specific kind: unsupported kinds are absent, not a parse failure.
    }
  }
  try {
    for (const node of root.findAll({ rule: { kind: "variable_declarator" as never } })) {
      const value = node.field("value");
      const kind = value === undefined || value === null ? "" : nodeKind(value);
      if (kind === "arrow_function" || kind === "function_expression" || kind === "generator_function") {
        nodes.push(node);
      }
    }
  } catch {
    // The grammar has no variable declarator kind.
  }
  return nodes;
}

/**
 * Verbatim, bounded function chunks kept for later semantic review.
 *
 * Source is still read only during analysis. Report generation receives these
 * excerpts from the frozen knowledge base, which lets several report sections
 * share one read and makes a cached rerun independent of the working tree.
 */
export function sourceExcerpts(content: string, relPath: string): readonly SourceExcerpt[] {
  const language = languageOf(relPath);
  if (language === null) return [];
  const parsed = parseSource(language, content);
  if (parsed.root === null) return [];

  const excerpts: SourceExcerpt[] = [];
  const seen = new Set<string>();
  const ordered = [...functionNodes(parsed.root)].sort((a, b) => {
    const ar = a.range();
    const br = b.range();
    return ar.start.line - br.start.line || ar.start.column - br.start.column;
  });
  for (const node of ordered) {
    if (excerpts.length >= MAX_SOURCE_EXCERPTS_PER_FILE) break;
    const range = node.range();
    const label = functionLabel(node);
    const key = `${range.start.line}:${range.start.column}:${range.end.line}:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const lines = node.text().split("\n");
    let start = 0;
    let part = 1;
    while (start < lines.length && excerpts.length < MAX_SOURCE_EXCERPTS_PER_FILE) {
      let end = start;
      let chars = 0;
      while (end < lines.length && end - start < SOURCE_EXCERPT_LINES) {
        const added = lines[end]!.length + (end === start ? 0 : 1);
        if (end > start && chars + added > SOURCE_EXCERPT_CHARS) break;
        chars += added;
        end += 1;
      }
      if (end === start) end += 1;
      const text = lines.slice(start, end).join("\n").trimEnd();
      if (text.trim().length >= 20) {
        const startLine = range.start.line + start + 1;
        const endLine = range.start.line + end;
        const index = positionOffset(
          content,
          startLine - 1,
          start === 0 ? range.start.column : 0,
        );
        excerpts.push({
          text,
          label: lines.length > end || start > 0 ? `${label} (part ${part})` : label,
          index,
          startLine,
          endLine,
        });
      }
      start = end;
      part += 1;
    }
  }
  return excerpts;
}

/**
 * Block and consecutive line comments, with markup stripped.
 *
 * Consecutive `//` lines are joined into one item: a five-line comment is one
 * thought, and splitting it into five fragments would lose the thought while
 * keeping the words.
 */
export function docComments(
  content: string,
  extension: string,
): readonly { text: string; line: number; index: number }[] {
  const found: { text: string; line: number; index: number }[] = [];

  if (SLASH_COMMENT_EXTENSIONS.has(extension)) {
    for (const match of content.matchAll(/\/\*\*?([\s\S]*?)\*\//g)) {
      const text = match[1]!
        .split("\n")
        .map((line) => line.replace(/^\s*\*?\s?/, "").trimEnd())
        .join("\n")
        .trim();
      if (text.length >= 3) found.push({ text, line: lineAt(content, match.index), index: match.index });
    }

    const lines = content.split("\n");
    let buffer: string[] = [];
    let start = 0;
    let startOffset = 0;
    let offset = 0;
    lines.forEach((line, index) => {
      const lineOffset = offset;
      offset += line.length + 1;
      const match = /^\s*\/\/\s?(.*)$/.exec(line);
      if (match) {
        if (buffer.length === 0) {
          start = index + 1;
          startOffset = lineOffset;
        }
        buffer.push(match[1]!.trim());
        return;
      }
      if (buffer.length > 0) {
        const text = buffer.join(" ").trim();
        if (text.length >= 3) found.push({ text, line: start, index: startOffset });
        buffer = [];
      }
    });
    if (buffer.length > 0) {
      const text = buffer.join(" ").trim();
      if (text.length >= 3) found.push({ text, line: start, index: startOffset });
    }
  }

  if (HASH_COMMENT_EXTENSIONS.has(extension)) {
    let offset = 0;
    content.split("\n").forEach((line, index) => {
      const lineOffset = offset;
      offset += line.length + 1;
      const match = /^\s*#\s?(.+)$/.exec(line);
      if (match && match[1]!.trim().length >= 3) {
        found.push({ text: match[1]!.trim(), line: index + 1, index: lineOffset });
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
      {
        kind: "source-excerpt",
        language: "*",
        support: "partial",
        limits: [
          "verbatim function and method chunks for Go, TypeScript, JavaScript and TSX only",
          `each chunk is bounded to ${SOURCE_EXCERPT_LINES} lines and ${SOURCE_EXCERPT_CHARS} characters`,
          "the excerpts support code review but do not prove runtime configuration or production behaviour",
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
      const noTestConvention = new Set<string>();

      for (const relPath of root.analyzedFiles) {
        const extension = extname(relPath).toLowerCase();
        const known =
          SLASH_COMMENT_EXTENSIONS.has(extension) || HASH_COMMENT_EXTENSIONS.has(extension);
        if (!known && !UI_EXTENSIONS.has(extension)) {
          if (extension !== "") unknownExtensions.add(extension);
          continue;
        }
        if (known && !TEST_CONVENTION_EXTENSIONS.has(extension)) {
          noTestConvention.add(extension);
        }

        const full = join(root.path, relPath);
        try {
          if (statSync(full).size > MAX_FILE_BYTES) {
            failures.push({ scope: relPath, reason: "file exceeds the read size limit" });
            continue;
          }
          const content = readFileSync(full, "utf8");

          for (const excerpt of sourceExcerpts(content, relPath)) {
            const located = offsetRef(root.name, relPath, content, excerpt.index);
            const source = { ...located, endLine: excerpt.endLine };
            items.push({
              rootName: root.name,
              kind: "source-excerpt",
              text: excerpt.text,
              label: excerpt.label,
              symbolId: null,
              source,
              provenance: declared(source),
            });
          }

          for (const comment of docComments(content, extension)) {
            const source = offsetRef(root.name, relPath, content, comment.index);
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
              const source = offsetRef(root.name, relPath, content, match.index);
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
                const source = offsetRef(root.name, relPath, content, match.index);
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

      // Comment support is not test support. Without this, a project in one of
      // these languages would report no tests rather than reporting that
      // nobody looked for them.
      for (const extension of [...noTestConvention].sort()) {
        gaps.push({
          kind: "test-name",
          language: extension,
          reason: `no test-naming convention is recognized for ${extension} files, so their tests were not identified`,
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
