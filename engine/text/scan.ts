/**
 * One-pass source scanning shared by every text-reading provider.
 *
 * Grew out of the outbound detector, where three separate comment heuristics
 * were each wrong (a `--` in SQL misread as a comment, a glob's `/*` blacking
 * out the rest of the file, O(n²) rescans). A single forward pass carrying
 * string state cannot mistake a delimiter inside a string for syntax, and
 * every later lookup is a constant-time read.
 */

export interface SourceMap {
  /** True where the character at that offset is inside a comment. */
  readonly comment: Uint8Array;
  /** Offset at which each line starts, for constant-time position lookup. */
  readonly lineStarts: readonly number[];
}

export interface ScanOptions {
  /**
   * Whether `#` starts a line comment. True fits Python/Ruby/shell/YAML;
   * false fits Go and JS/TS — where treating `#` as a comment would black out
   * the rest of any line using a private class field (`this.#x`).
   */
  readonly hashLineComments?: boolean;
}

export function scanSource(content: string, options: ScanOptions = {}): SourceMap {
  const hashComments = options.hashLineComments ?? true;
  const comment = new Uint8Array(content.length);
  const lineStarts: number[] = [0];

  type State = "code" | "line-comment" | "block-comment" | "single" | "double" | "backtick";
  let state: State = "code";

  for (let i = 0; i < content.length; i++) {
    const char = content[i]!;
    const next = content[i + 1];

    if (char === "\n") lineStarts.push(i + 1);

    switch (state) {
      case "code":
        if (char === "/" && next === "/") state = "line-comment";
        else if (char === "/" && next === "*") state = "block-comment";
        else if (char === "#" && hashComments) state = "line-comment";
        else if (char === "'") state = "single";
        else if (char === '"') state = "double";
        else if (char === "`") state = "backtick";
        break;
      case "line-comment":
        if (char === "\n") state = "code";
        break;
      case "block-comment":
        if (char === "*" && next === "/") {
          comment[i] = 1;
          comment[i + 1] = 1;
          i += 1;
          state = "code";
          continue;
        }
        break;
      case "single":
      case "double":
      case "backtick":
        if (char === "\\") {
          i += 1;
          continue;
        }
        if (
          (state === "single" && char === "'") ||
          (state === "double" && char === '"') ||
          (state === "backtick" && char === "`")
        ) {
          state = "code";
        }
        break;
    }

    if (state === "line-comment" || state === "block-comment") comment[i] = 1;
  }

  return { comment, lineStarts };
}

export function positionAt(map: SourceMap, index: number): { line: number; column: number } {
  let low = 0;
  let high = map.lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (map.lineStarts[mid]! <= index) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: index - map.lineStarts[low]! + 1 };
}

export interface ParsedCall {
  /** The receiver identifier — `leaveGrp`, `router`, `app`. */
  readonly receiver: string;
  readonly method: string;
  /** Top-level argument texts, trimmed, in order. */
  readonly args: readonly string[];
  /** Offset of the receiver's first character. */
  readonly index: number;
  readonly line: number;
}

/**
 * Finds `receiver.method(...)` call sites and extracts their arguments with
 * balanced-delimiter walking, so a multi-line registration whose middleware
 * spans several lines parses the same as a one-liner.
 *
 * `methodPattern` must be a global regex with two capture groups: receiver and
 * method, ending at the open paren (e.g. `/\b(\w+)\.(GET|POST)\s*\(/g`).
 * Matches inside comments are skipped; matches inside strings are not detected
 * here (a route path containing `x.get(` is possible but vanishingly rare, and
 * the cost of full string tracking at match time is not worth that case —
 * declared as a limit by callers).
 */
export function parseCalls(
  content: string,
  map: SourceMap,
  methodPattern: RegExp,
): readonly ParsedCall[] {
  const calls: ParsedCall[] = [];
  const pattern = new RegExp(methodPattern.source, methodPattern.flags);
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    if (map.comment[match.index] === 1) continue;

    const open = content.indexOf("(", match.index + match[0].length - 1);
    if (open === -1) continue;

    const extracted = extractArguments(content, map, open);
    if (extracted === null) continue;

    calls.push({
      receiver: match[1]!,
      method: match[2]!,
      args: extracted.args,
      index: match.index,
      line: positionAt(map, match.index).line,
    });

    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
  }

  return calls;
}

/**
 * Walks from an open paren to its balanced close, splitting top-level
 * arguments at commas. String-aware, so a comma inside `'a,b'` or a paren
 * inside a template literal never splits an argument.
 */
function extractArguments(
  content: string,
  map: SourceMap,
  open: number,
): { args: string[]; end: number } | null {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quote: string | null = null;

  for (let i = open; i < content.length; i++) {
    const char = content[i]!;

    if (quote !== null) {
      // Backslash escapes inside JS strings. In a Go raw string (backtick)
      // there are no escapes, so a backslash directly before the closing
      // backtick would misparse — accepted as a limit; it does not occur in
      // route registration code.
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (map.comment[i] === 1) continue;
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) {
        const text = content.slice(start, i).trim();
        if (text !== "") args.push(text);
        return { args, end: i };
      }
    } else if (char === "," && depth === 1) {
      const text = content.slice(start, i).trim();
      if (text !== "") args.push(text);
      start = i + 1;
    }
  }

  // Unbalanced to end of file — a parse failure, not a call.
  return null;
}

/** The unquoted text of a string-literal argument, or null if it is not one. */
export function stringLiteral(arg: string): string | null {
  const match = /^(['"`])([^]*)\1$/.exec(arg.trim());
  return match ? match[2]! : null;
}

/** The leading dotted identifier of an expression — `auth.Authentication()` → `auth.Authentication`. */
export function leadingName(arg: string): string | null {
  const match = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.exec(arg.trim());
  return match ? match[1]! : null;
}
