/**
 * Observing library-standard outbound integration sinks generically (PI-87).
 *
 * A call that leaves the process through a well-known library primitive — an AWS
 * SDK client operation (`PutObject`, `PresignGetObject`, `SendEmail`), a
 * `net/smtp` mail send, a `net/http` request, an `axios`/`fetch` HTTP call — is an
 * outbound call whether it crosses a network boundary, a dependency boundary, or
 * both. The URL-literal outbound reader (`providers/outbound`) sees only a written
 * destination, so an SDK call whose endpoint is baked into the client is invisible
 * to it, and nothing produced an `ExternalCallRecord` at all. This lifts those
 * primitives into `ExternalCallRecord`s, which `sideeffect-derive` already unifies
 * under `outbound-call` (category `external-package`).
 *
 * It keys on library vocabulary only — an import path (`aws-sdk-go`, `net/smtp`,
 * `axios`) and the standard operation name — never on a project's own function or
 * variable names. Two generic signals keep a project wrapper that reuses an SDK
 * operation name (`wcpS3.PutObject`) apart from the SDK call it forwards to: the
 * file must import the SDK, and — since a v2 SDK operation is always
 * `Op(ctx, input, …)` — the call must pass a context first argument, which a domain
 * wrapper call (`wcpS3.GetObject(key)`) does not. The import gate alone is not
 * enough: a handler can both import the SDK (for a real call) and call a wrapper in
 * the same file, so the context-first-arg check is what actually separates them.
 * The wrapper is reached instead through the call graph, the same way PI-82
 * reverse-reaches a notification send to the handler that triggers it: a caller
 * within a shallow bound of a sink is attributed a low-confidence reached record,
 * so the fact lands where a reader looks (the handler) as well as at the SDK call
 * itself — without matching the wrapper by name. An interface method declaration
 * (a callable node with no body) reached through the graph's dispatch edge is not
 * attributed: it executes nothing.
 *
 * Determinism: roots are walked in name order, files in path order, patterns in a
 * fixed order and matches in source order; the graph is read into sorted indices,
 * the BFS frontier is drained sorted, reached records collapse per (function,
 * package), and the output is sorted by location and identity. A read that throws
 * or a degraded index becomes a note, never a thrown run.
 */

import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

import { positionAt, scanSource } from "../text/scan.js";
import { type Confidence, inferred, lineRef, type SourceRef } from "../structural/provenance.js";
import type { ExternalCallRecord } from "../structural/boundaries.js";
import { codeIndexDbPath, readBatchDb } from "../providers/codegraph/batchdb.js";
import type { CodeGraphSnapshot } from "../providers/codegraph/batch.js";
import { importEdges } from "../providers/codegraph/importedges.js";
import { importNodes, type ImportedNode } from "../providers/codegraph/importnodes.js";
import { scopeSnapshotToRoot } from "./notification-reachability.js";
import type { RootFacts } from "./extract.js";


const CALLS_EDGE_KIND = "calls";
const CALLABLE_RAW_KINDS: ReadonlySet<string> = new Set(["function", "method"]);

/**
 * Reverse-reachability bounds, matching PI-82's notification reader.
 *
 * A sink lives inside its own function (depth 0). The function that *calls* that
 * one (depth 1) is the handler a reader looks under — a leave handler calling a
 * storage wrapper that calls the SDK. Two hops keeps that handler and its
 * immediate caller without walking out to the app bootstrap; a hub with more
 * callers than `maxFanIn` is a shared utility, attributed but not expanded.
 */
export const DEFAULT_MAX_HOPS = 2;
export const DEFAULT_MAX_FAN_IN = 32;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const JS_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue"] as const;

interface SinkPattern {
  readonly extensions: readonly string[];
  /** Any of these substrings must appear in the file (an import gate). Empty = ungated. */
  readonly requiresImport: readonly string[];
  /** Global regex; when `member` is null, capture group 1 names the operation. */
  readonly pattern: RegExp;
  readonly packageName: string;
  readonly member: string | null;
  readonly confidence: Confidence;
}

/**
 * The library-standard outbound primitives.
 *
 * The AWS operation set is curated to names that are distinctive to the SDK
 * (object/item/message/email operations, presigners, the transfer manager) and
 * import-gated on `aws-sdk-go` (which prefixes both the v1 and v2 module paths).
 * Generic English verbs an ORM or RPC layer also uses (`Query`, `Scan`, `Invoke`,
 * `Publish`) are deliberately left out — even inside an SDK-importing file they
 * collide, and an outbound sink must stay a network call, not every method call.
 */
const SINK_PATTERNS: readonly SinkPattern[] = [
  // ---- Go: net/smtp ----
  {
    extensions: [".go"],
    requiresImport: ["net/smtp"],
    pattern: /\bsmtp\.SendMail\s*\(/g,
    packageName: "net/smtp",
    member: "SendMail",
    confidence: "high",
  },
  // ---- Go: AWS SDK client operations ----
  // The trailing `(ctx, …)` requirement is what distinguishes a real SDK v2 call
  // (`client.GetObject(ctx, input)`) from a domain wrapper that reuses the operation
  // name (`wcpS3.GetObject(key)`), which the import gate alone cannot when the same
  // file both imports the SDK and calls the wrapper. The context first argument is
  // matched by the SDK's own convention (`ctx`/`c`, `context.TODO()`, `x.Context()`),
  // not by any project variable name.
  {
    extensions: [".go"],
    requiresImport: ["aws-sdk-go"],
    pattern:
      /\.(PutObject|GetObject|DeleteObject|HeadObject|CopyObject|PresignGetObject|PresignPutObject|PresignHeadObject|ListObjectsV2|SendEmail|SendRawEmail|SendTemplatedEmail|SendBulkTemplatedEmail|PutItem|GetItem|UpdateItem|DeleteItem|BatchWriteItem|BatchGetItem|SendMessage|SendMessageBatch|ReceiveMessage|Upload|Download)\s*\(\s*(?:\w*[Cc]tx\w*|c|context\s*\.\s*(?:TODO|Background)\s*\(\s*\)|\w+\s*\.\s*Context\s*\(\s*\))\s*,/g,
    packageName: "aws-sdk-go",
    member: null,
    confidence: "medium",
  },
  // ---- Go: net/http one-shot client calls ----
  {
    extensions: [".go"],
    requiresImport: ["net/http"],
    pattern: /\bhttp\.(Get|Post|PostForm|Head)\s*\(/g,
    packageName: "net/http",
    member: null,
    confidence: "medium",
  },
  // ---- JS/TS: axios ----
  {
    extensions: JS_EXTENSIONS,
    requiresImport: ["axios"],
    pattern: /\baxios\s*\.\s*(get|post|put|patch|delete|head|request)\s*\(/g,
    packageName: "axios",
    member: null,
    confidence: "medium",
  },
  {
    extensions: JS_EXTENSIONS,
    requiresImport: ["axios"],
    pattern: /\baxios\s*\(/g,
    packageName: "axios",
    member: "request",
    confidence: "medium",
  },
  // ---- JS/TS: fetch (global; not a `.fetch(` member access) ----
  {
    extensions: JS_EXTENSIONS,
    requiresImport: [],
    pattern: /(?<![.\w])fetch\s*\(/g,
    packageName: "fetch",
    member: "fetch",
    confidence: "low",
  },
];

function byLocation(a: ExternalCallRecord, b: ExternalCallRecord): number {
  return (
    cmp(a.provenance.source.relPath, b.provenance.source.relPath) ||
    (a.provenance.source.startLine ?? 0) - (b.provenance.source.startLine ?? 0) ||
    (a.provenance.source.startColumn ?? 0) - (b.provenance.source.startColumn ?? 0) ||
    cmp(a.packageName, b.packageName) ||
    cmp(a.memberName ?? "", b.memberName ?? "")
  );
}

/**
 * Direct outbound-integration sinks in one file. Pure over the file's text — no
 * filesystem, no graph — so it is unit-testable on a synthetic string. A match in
 * a comment is skipped, and a pattern whose import gate the file does not satisfy
 * never runs.
 */
export function detectOutboundSinks(
  rootName: string,
  relPath: string,
  content: string,
): ExternalCallRecord[] {
  const ext = extname(relPath).toLowerCase();
  const applicable = SINK_PATTERNS.filter((p) => p.extensions.includes(ext));
  if (applicable.length === 0) return [];

  const map = scanSource(content);
  const out: ExternalCallRecord[] = [];
  for (const sp of applicable) {
    const gated =
      sp.requiresImport.length === 0 || sp.requiresImport.some((s) => content.includes(s));
    if (!gated) continue;

    const regex = new RegExp(sp.pattern.source, sp.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      const index = m.index;
      if (map.comment[index] !== 1) {
        const { line, column } = positionAt(map, index);
        const source: SourceRef = {
          rootName,
          relPath,
          startLine: line,
          endLine: line,
          startColumn: column,
          endColumn: null,
        };
        out.push({
          rootName,
          callerSymbolId: null,
          packageName: sp.packageName,
          memberName: sp.member ?? m[1] ?? null,
          provenance: inferred(source, sp.confidence),
        });
      }
      // A zero-width match would loop forever otherwise.
      if (m.index === regex.lastIndex) regex.lastIndex += 1;
    }
  }
  return out.sort(byLocation);
}

/** A callable node's line range; a null end can only enclose its own start line. */
function endOf(node: ImportedNode): number {
  return node.endLine ?? (node.startLine ?? 0);
}

/**
 * A callable whose whole range is one line has no body — an interface method
 * declaration or an empty stub. A function with a body always spans the brace on a
 * later line, so this never excludes real code.
 */
function isDeclarationOnly(node: ImportedNode): boolean {
  return node.startLine !== null && endOf(node) <= node.startLine;
}

/**
 * The innermost callable at (relPath, line): among functions/methods whose range
 * covers the line, the one with the latest start (tightest end, then id, to break
 * ties deterministically). That is the function the call literally sits inside.
 */
function innermostEnclosing(
  byFile: ReadonlyMap<string, readonly ImportedNode[]>,
  relPath: string,
  line: number,
): ImportedNode | null {
  const list = byFile.get(relPath);
  if (list === undefined) return null;
  let best: ImportedNode | null = null;
  for (const node of list) {
    if (node.startLine === null) continue;
    if (node.startLine <= line && line <= endOf(node)) {
      if (
        best === null ||
        node.startLine > best.startLine! ||
        (node.startLine === best.startLine && endOf(node) < endOf(best)) ||
        (node.startLine === best.startLine && endOf(node) === endOf(best) && cmp(node.nativeId, best.nativeId) < 0)
      ) {
        best = node;
      }
    }
  }
  return best;
}

export interface OutboundReachabilityInput {
  readonly rootName: string;
  /** The direct sinks extracted for this root, at their call sites. */
  readonly sinks: readonly ExternalCallRecord[];
  /** The root-scoped code graph — filePaths already root-relative. */
  readonly snapshot: CodeGraphSnapshot;
  readonly maxHops?: number;
  readonly maxFanIn?: number;
}

export interface OutboundReachabilityResult {
  readonly external: readonly ExternalCallRecord[];
  readonly notes: readonly string[];
}

/**
 * Attribute a reached outbound record to every function that reverse-reaches a
 * direct sink through the call graph. The sink's own function (depth 0) is left to
 * the direct record; its callers (depth 1..maxHops) each get one low-confidence
 * record per package they reach, with no member — a caller reaches the SDK, it does
 * not itself name the operation. Pure: the same snapshot always yields the same
 * records in the same order.
 */
export function deriveOutboundReachability(
  input: OutboundReachabilityInput,
): OutboundReachabilityResult {
  const maxHops = input.maxHops ?? DEFAULT_MAX_HOPS;
  const maxFanIn = input.maxFanIn ?? DEFAULT_MAX_FAN_IN;

  const nodes = [...importNodes(input.snapshot).nodes].sort((a, b) => cmp(a.nativeId, b.nativeId));
  const edges = [...importEdges(input.snapshot).edges].sort((a, b) => cmp(a.nativeId, b.nativeId));

  const callableById = new Map<string, ImportedNode>();
  const byFileMut = new Map<string, ImportedNode[]>();
  for (const node of nodes) {
    if (!CALLABLE_RAW_KINDS.has(node.rawKind) || node.startLine === null) continue;
    callableById.set(node.nativeId, node);
    const list = byFileMut.get(node.filePath) ?? [];
    list.push(node);
    byFileMut.set(node.filePath, list);
  }
  const byFile = new Map<string, readonly ImportedNode[]>();
  for (const [file, list] of byFileMut) {
    byFile.set(
      file,
      [...list].sort(
        (a, b) => (a.startLine! - b.startLine!) || (endOf(a) - endOf(b)) || cmp(a.nativeId, b.nativeId),
      ),
    );
  }

  // Reverse adjacency: for a resolved `calls` edge A→B, B's callers include A.
  const callersSet = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== CALLS_EDGE_KIND || edge.toNativeId === null) continue;
    const set = callersSet.get(edge.toNativeId) ?? new Set<string>();
    set.add(edge.fromNativeId);
    callersSet.set(edge.toNativeId, set);
  }
  const callersOf = new Map<string, readonly string[]>();
  for (const [target, set] of callersSet) callersOf.set(target, [...set].sort(cmp));

  const notes = new Set<string>();
  // Collapsed per (reacher function start, package): a caller reaches a package,
  // not a specific member, and one record per package keeps the fan-out bounded.
  const records = new Map<string, ExternalCallRecord>();
  const attribute = (node: ImportedNode, packageName: string): void => {
    const start = node.startLine;
    if (start === null) return;
    const key = `${node.filePath}\0${start}\0${packageName}`;
    if (records.has(key)) return;
    const source = lineRef(input.rootName, node.filePath, start, node.endLine ?? start);
    records.set(key, {
      rootName: input.rootName,
      callerSymbolId: null,
      packageName,
      memberName: null,
      provenance: inferred(source, "low"),
    });
  };

  const sinks = [...input.sinks].sort(byLocation);
  let attributedSinks = 0;
  for (const sink of sinks) {
    const line = sink.provenance.source.startLine;
    if (line === null) continue;
    const enclosing = innermostEnclosing(byFile, sink.provenance.source.relPath, line);
    if (enclosing === null) {
      notes.add(
        `outbound-reachability: sink '${sink.packageName}.${sink.memberName ?? ""}' at ${sink.provenance.source.relPath}:${line} sits in no indexed callable`,
      );
      continue;
    }
    attributedSinks += 1;

    // Bounded, cycle-aware reverse BFS. Depth 0 (the sink's own function) is left
    // to the direct record; callers from depth 1 up to maxHops are attributed. A
    // bodyless declaration (an interface method the graph reaches through its
    // interface→impl dispatch edge) is traversed to its real callers but never
    // attributed — it runs nothing.
    const visited = new Set<string>([enclosing.nativeId]);
    let frontier: string[] = [enclosing.nativeId];
    let depth = 0;
    while (frontier.length > 0 && depth < maxHops) {
      const next: string[] = [];
      for (const id of [...frontier].sort(cmp)) {
        const callers = callersOf.get(id) ?? [];
        if (callers.length > maxFanIn) {
          const node = callableById.get(id);
          notes.add(
            `outbound-reachability: hub ${node?.name ?? id} at ${node?.filePath ?? "?"}:${node?.startLine ?? "?"} (fan-in ${callers.length} > ${maxFanIn}) not expanded`,
          );
          continue;
        }
        for (const caller of callers) {
          if (visited.has(caller)) continue;
          const node = callableById.get(caller);
          if (node === undefined) continue;
          visited.add(caller);
          if (!isDeclarationOnly(node)) attribute(node, sink.packageName);
          next.push(caller);
        }
      }
      frontier = next;
      depth += 1;
    }
  }

  const external = [...records.values()].sort(byLocation);
  notes.add(
    `outbound-reachability: ${external.length} reached record(s) from ${attributedSinks}/${sinks.length} sink(s); maxHops ${maxHops}, maxFanIn ${maxFanIn}`,
  );
  return { external, notes: [...notes] };
}

export interface OutboundIntegrationInput {
  readonly roots: readonly RootFacts[];
  /** rootName → absolute path, so a root's own files can be read. */
  readonly rootPaths?: ReadonlyMap<string, string>;
  /** The index root — the batch DB lives under `<codeIndexPath>/` in CodeGraph's index directory. */
  readonly codeIndexPath?: string | null;
  readonly maxHops?: number;
  readonly maxFanIn?: number;
}

export interface OutboundIntegrationResult {
  readonly external: readonly ExternalCallRecord[];
  /** What was bounded, unreadable or absent — disclosed, never silently dropped. */
  readonly notes: readonly string[];
}

/**
 * Observe library-standard outbound sinks across every root and reverse-reach them
 * to the handlers that trigger them. Fails open: without root paths nothing is
 * scanned, without an index nothing is reached — the direct sinks still stand, and
 * a note records what was skipped.
 */
export function observeOutboundIntegration(input: OutboundIntegrationInput): OutboundIntegrationResult {
  const { rootPaths, codeIndexPath } = input;
  const notes: string[] = [];

  const directByRoot = new Map<string, ExternalCallRecord[]>();
  const allDirect: ExternalCallRecord[] = [];
  for (const root of [...input.roots].sort((a, b) => cmp(a.rootName, b.rootName))) {
    const rootPath = rootPaths?.get(root.rootName);
    if (rootPath === undefined) {
      notes.push(`outbound-integration: no path for root ${root.rootName} — sinks not scanned`);
      continue;
    }
    const found: ExternalCallRecord[] = [];
    for (const relPath of [...root.analyzedFiles].sort(cmp)) {
      try {
        found.push(...detectOutboundSinks(root.rootName, relPath, readFileSync(join(rootPath, relPath), "utf8")));
      } catch (error) {
        // Only the error's syscall code, never its message: the message embeds the
        // absolute path `join` built, which would put a per-machine string into the
        // persisted note. The root-relative path is enough to locate the file.
        const code = (error as NodeJS.ErrnoException)?.code;
        notes.push(`outbound-integration: ${relPath} unreadable — ${code ?? "read-error"}`);
      }
    }
    directByRoot.set(root.rootName, found);
    allDirect.push(...found);
  }

  const reached: ExternalCallRecord[] = [];
  if (codeIndexPath == null || rootPaths === undefined || rootPaths.size === 0) {
    notes.push("outbound-integration: no code index available — no reverse-reachability attributed");
  } else {
    const outcome = readBatchDb(codeIndexDbPath(codeIndexPath), codeIndexPath);
    if (!outcome.ok) {
      notes.push(
        `outbound-integration: code index degraded (${outcome.degradation.kind}) — no reverse-reachability attributed`,
      );
    } else {
      for (const [rootName, rootPath] of [...rootPaths].sort((a, b) => cmp(a[0], b[0]))) {
        const sinks = directByRoot.get(rootName) ?? [];
        if (sinks.length === 0) continue;
        const snapshot = scopeSnapshotToRoot(outcome.snapshot, codeIndexPath, rootPath);
        const result = deriveOutboundReachability({
          rootName,
          sinks,
          snapshot,
          ...(input.maxHops === undefined ? {} : { maxHops: input.maxHops }),
          ...(input.maxFanIn === undefined ? {} : { maxFanIn: input.maxFanIn }),
        });
        reached.push(...result.external);
        notes.push(...result.notes);
      }
    }
  }

  const external = [...allDirect, ...reached].sort(byLocation);
  notes.push(`outbound-integration: ${allDirect.length} direct sink(s), ${reached.length} reached record(s)`);
  return { external, notes };
}
