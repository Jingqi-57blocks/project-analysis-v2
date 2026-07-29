/**
 * Real parsing, from tree-sitter grammars via ast-grep.
 *
 * The readers began as regular expressions and a hand-written brace counter,
 * and a review found seven defects in them — an identifier matching inside a
 * longer one, `"/api" + v + "/x"` accepted as a string literal, function scope
 * tracked by counting braces. Every one of those is a mistake a parser cannot
 * make, and the tool's ambit is *any* language, which is the case where
 * per-language hand-written scanners scale worst.
 *
 * Grammars are loaded on demand: the web languages ship with the core, and
 * others come from their own packages, so a language nobody analyzes costs
 * nothing.
 */

import { createRequire } from "node:module";

import { parse, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";

export type ParsedLanguage = "go" | "javascript" | "typescript" | "tsx";

const BUILT_IN: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  tsx: "Tsx",
};

const registered = new Set<string>();
let dynamicFailure: string | null = null;

/**
 * Registers a grammar that does not ship with the core.
 *
 * A missing grammar is a declared gap, not a crash: the caller falls back to
 * reporting that the language could not be read.
 */
function ensureRegistered(language: ParsedLanguage): boolean {
  if (BUILT_IN[language] !== undefined) return true;
  if (registered.has(language)) return true;
  if (dynamicFailure !== null) return false;

  try {
    // Resolved at call time so a grammar for a language this workspace does
    // not contain is never loaded.
    const requireGrammar = createRequire(import.meta.url);
    const grammar: unknown = requireGrammar(`@ast-grep/lang-${language}`);
    const module = (grammar as { default?: unknown }).default ?? grammar;
    registerDynamicLanguage({ [language]: module } as never);
    registered.add(language);
    return true;
  } catch (error) {
    dynamicFailure = error instanceof Error ? error.message : String(error);
    return false;
  }
}

export interface ParseResult {
  readonly root: SgNode | null;
  /** Why nothing could be parsed, when root is null. */
  readonly reason: string | null;
}

export function parseSource(language: ParsedLanguage, content: string): ParseResult {
  if (!ensureRegistered(language)) {
    return {
      root: null,
      reason: `no grammar is available for ${language}${dynamicFailure ? `: ${dynamicFailure}` : ""}`,
    };
  }

  try {
    const languageId = BUILT_IN[language] ?? language;
    return { root: parse(languageId as never, content).root(), reason: null };
  } catch (error) {
    return { root: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The language a file is written in, or null when this tool cannot parse it. */
export function languageOf(relPath: string): ParsedLanguage | null {
  if (relPath.endsWith(".go")) return "go";
  if (relPath.endsWith(".tsx") || relPath.endsWith(".jsx")) return "tsx";
  if (relPath.endsWith(".ts") || relPath.endsWith(".mts")) return "typescript";
  if (relPath.endsWith(".js") || relPath.endsWith(".cjs") || relPath.endsWith(".mjs")) {
    return "javascript";
  }
  return null;
}

export interface AstCall {
  readonly node: SgNode;
  /** The callee as written — `leaveGrp.POST`, `require`. */
  readonly callee: string;
  /** The part before the final dot, empty when the callee is a bare name. */
  readonly receiver: string;
  /** The final segment of the callee. */
  readonly method: string;
  readonly args: readonly SgNode[];
  /** 1-based, matching every other location in the knowledge base. */
  readonly line: number;
  readonly column: number;
}

const CALL_KINDS = new Set<string>(["call_expression", "call"]);
const ARGUMENT_KINDS = new Set<string>(["argument_list", "arguments"]);
/** Node kinds are typed against a grammar map; ours are plain strings. */
function kindOf(node: SgNode): string {
  return node.kind() as string;
}

/** Punctuation and comments inside an argument list are not arguments. */
const NOT_AN_ARGUMENT = new Set<string>(["(", ")", ",", "comment", "line_comment", "block_comment"]);

function argumentsOf(call: SgNode): SgNode[] {
  const list =
    call.field("arguments") ??
    call.children().find((child) => ARGUMENT_KINDS.has(kindOf(child)));
  if (list === undefined || list === null) return [];
  return list.children().filter((child) => !NOT_AN_ARGUMENT.has(kindOf(child)));
}

/**
 * Every call in a parsed file, with its callee split at the final dot.
 *
 * Comments and strings need no special handling — a comment is not a call
 * node, and a `.get(` inside a string literal is text, which is the whole
 * reason this replaced a scanner that had to reason about both.
 */
export function findCalls(root: SgNode): AstCall[] {
  const calls: AstCall[] = [];

  // Kind names belong to a grammar, so a name valid in one language is an
  // error in another — asking for all of them at once fails outright rather
  // than matching what it can. Each is tried on its own and an unknown one is
  // simply a kind this language does not have.
  const nodes: SgNode[] = [];
  for (const kind of CALL_KINDS) {
    try {
      nodes.push(...root.findAll({ rule: { kind: kind as never } }));
    } catch {
      continue;
    }
  }

  for (const node of nodes) {
    const callee = node.field("function")?.text() ?? "";
    if (callee === "") continue;

    const dot = callee.lastIndexOf(".");
    const range = node.range();
    calls.push({
      node,
      callee,
      receiver: dot === -1 ? "" : callee.slice(0, dot),
      method: dot === -1 ? callee : callee.slice(dot + 1),
      args: argumentsOf(node),
      line: range.start.line + 1,
      column: range.start.column + 1,
    });
  }

  return calls;
}

const STRING_KINDS = new Set<string>([
  "interpreted_string_literal",
  "raw_string_literal",
  "string",
  "string_literal",
]);

/**
 * The text of a node that is a string literal, or null for anything else.
 *
 * A concatenation is not a literal, and here that needs no checking: the node
 * would be a binary expression, so it simply is not one of these kinds.
 */
export function literalText(node: SgNode | undefined): string | null {
  if (node === undefined) return null;
  if (!STRING_KINDS.has(kindOf(node))) return null;

  const text = node.text();
  const quote = text[0];
  if (quote === undefined || !["'", '"', "`"].includes(quote)) return text;
  return text.slice(1, text.endsWith(quote) && text.length > 1 ? -1 : undefined);
}

/** The name of the function a node sits inside, or null at file scope. */
export function enclosingFunctionName(node: SgNode): string | null {
  const FUNCTION_KINDS = new Set<string>([
    "function_declaration",
    "method_declaration",
    "function_definition",
  ]);

  let current: SgNode | null = node.parent();
  while (current !== null) {
    if (FUNCTION_KINDS.has(kindOf(current))) return current.field("name")?.text() ?? null;
    current = current.parent();
  }
  return null;
}

/** The nearest enclosing function node, which bounds a local variable's scope. */
export function enclosingFunction(node: SgNode): SgNode | null {
  const FUNCTION_KINDS = new Set<string>([
    "function_declaration",
    "method_declaration",
    "function_definition",
    "func_literal",
    "function_expression",
    "arrow_function",
  ]);

  let current: SgNode | null = node.parent();
  while (current !== null) {
    if (FUNCTION_KINDS.has(kindOf(current))) return current;
    current = current.parent();
  }
  return null;
}
