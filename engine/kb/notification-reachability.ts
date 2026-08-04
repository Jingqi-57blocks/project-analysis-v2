/**
 * Reverse-reachability attribution for notification send sinks (PI-82).
 *
 * A library-standard send call — `.sendMail`, `smtp.SendMail`, `.messaging().send`,
 * slack `PostMessage`, a low-confidence notify helper — is extracted at the line it
 * sits on, which is usually a small helper (`sendNotification`) rather than the
 * handler a reader looks under (`updateOrder`). This deriver walks the call graph
 * *backwards* from each such sink and attributes a `notification-call` to every
 * function that reaches it, so the fact lands where the behaviour is triggered.
 *
 * It is deliberately generic: the only names it keys on are the standard sinks the
 * structural conventions reader already patterns — never a project's own function
 * names. A path the graph cannot connect (a goroutine, an interface dispatch, a
 * channel hand-off severs it) simply yields only the sink's own function, which is
 * the honest answer, not a forced one.
 *
 * Every attributed record is `inferred` at `low` confidence: reverse reachability
 * is a real signal but a weaker one than the direct call-site match, and a reader
 * must be able to tell the two apart.
 *
 * Determinism: the graph is read into sorted indices (nodes and edges by nativeId,
 * reverse-adjacency values as sorted lists, per-file callables by start line),
 * sinks are processed in a sorted order, the BFS frontier is drained in a sorted
 * order, and the output is sorted by (relPath, startLine, mechanism). Nothing here
 * depends on the order the index happened to enumerate its rows.
 */

import { relative } from "node:path";

import type { CodeGraphSnapshot } from "../providers/codegraph/batch.js";
import { importEdges } from "../providers/codegraph/importedges.js";
import { importNodes, type ImportedNode } from "../providers/codegraph/importnodes.js";
import { codeIndexDbPath, readBatchDb } from "../providers/codegraph/batchdb.js";
import type { SnapshotOutcome } from "../providers/codegraph/batch.js";
import { joinKey } from "../contracts/shared-fact/serialization.js";
import { inferred, lineRef } from "../structural/provenance.js";
import type { NotificationCallRecord } from "../structural/rules.js";


/**
 * Reverse-reachability defaults.
 *
 * `maxHops` is deliberately shallow: a function that *directly* calls a send
 * helper (or is one hop above it) is a credible trigger of that notification;
 * beyond that the walk stops finding handlers and starts finding plumbing —
 * a `main`/`init` bootstrap or a channel-consumer goroutine that merely wires the
 * sender up. Two hops keeps the handler a reader looks under (verified: a
 * controller that calls a model that sends) without labelling the app bootstrap
 * a notification site.
 *
 * A hub with more callers than `maxFanIn` is a shared utility, not a notification
 * path — attributed but never expanded through.
 */
export const DEFAULT_MAX_HOPS = 2;
export const DEFAULT_MAX_FAN_IN = 32;

/** CodeGraph's edge kind for a call, and the callable raw kinds a function is. */
const CALLS_EDGE_KIND = "calls";
const CALLABLE_RAW_KINDS: ReadonlySet<string> = new Set(["function", "method"]);


export interface NotificationReachabilityInput {
  readonly rootName: string;
  /** The library-standard send sinks extracted for this root, at their call sites. */
  readonly sinks: readonly NotificationCallRecord[];
  /** The root-scoped code graph — filePaths already root-relative (see scopeSnapshotToRoot). */
  readonly snapshot: CodeGraphSnapshot;
  readonly maxHops?: number;
  readonly maxFanIn?: number;
}

export interface NotificationReachabilityResult {
  /** One synthesized record per attributed function — the sink's own and its reachers. */
  readonly notifications: readonly NotificationCallRecord[];
  /** What was bounded or could not be placed — disclosed, never silently capped. */
  readonly notes: readonly string[];
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A callable node's line range; a null end can only enclose its own start line. */
function endOf(node: ImportedNode): number {
  return node.endLine ?? (node.startLine ?? 0);
}

/**
 * The innermost callable at (relPath, line): among the functions/methods whose
 * range covers the line, the one with the latest start (and, tying, the tightest
 * end). That is the function the sink call literally sits inside, not an outer
 * one that merely spans it.
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
        (node.startLine === best.startLine && endOf(node) === endOf(best) && cmpStr(node.nativeId, best.nativeId) < 0)
      ) {
        best = node;
      }
    }
  }
  return best;
}

/**
 * Attribute a `notification-call` to every function that reverse-reaches a
 * standard send sink through the call graph. Pure: the snapshot is the only
 * source, and the same snapshot always yields the same records in the same order.
 */
export function deriveNotificationReachability(
  input: NotificationReachabilityInput,
): NotificationReachabilityResult {
  const maxHops = input.maxHops ?? DEFAULT_MAX_HOPS;
  const maxFanIn = input.maxFanIn ?? DEFAULT_MAX_FAN_IN;

  // 1. Nodes and edges into sorted indices — nothing below depends on row order.
  const nodes = [...importNodes(input.snapshot).nodes].sort((a, b) => cmpStr(a.nativeId, b.nativeId));
  const edges = [...importEdges(input.snapshot).edges].sort((a, b) => cmpStr(a.nativeId, b.nativeId));

  // (a) callables by id, and per file by start line — for enclosing lookup.
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
        (a, b) => (a.startLine! - b.startLine!) || (endOf(a) - endOf(b)) || cmpStr(a.nativeId, b.nativeId),
      ),
    );
  }

  // (b) reverse adjacency: for a resolved `calls` edge A→B, B's callers include A.
  const callersSet = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== CALLS_EDGE_KIND || edge.toNativeId === null) continue;
    const set = callersSet.get(edge.toNativeId) ?? new Set<string>();
    set.add(edge.fromNativeId);
    callersSet.set(edge.toNativeId, set);
  }
  const callersOf = new Map<string, readonly string[]>();
  for (const [target, set] of callersSet) callersOf.set(target, [...set].sort(cmpStr));

  const notes = new Set<string>();
  const records = new Map<string, NotificationCallRecord>();

  const attribute = (node: ImportedNode, isSinkNode: boolean, channel: string, sinkMechanism: string): void => {
    const start = node.startLine;
    if (start === null) return;
    const mechanism = isSinkNode ? sinkMechanism : `reaches:${sinkMechanism}`;
    // The function that literally contains the send call knows the channel; a
    // caller that merely reaches it does not — it may reach several sinks of
    // different channels, and copying the sink's channel onto it would read as a
    // claim the caller sends on that channel. Reached records carry "unknown".
    const recordChannel = isSinkNode ? channel : "unknown";
    const source = lineRef(input.rootName, node.filePath, start, node.endLine ?? start);
    records.set(joinKey([node.filePath, start, recordChannel, mechanism]), {
      rootName: input.rootName,
      channel: recordChannel,
      mechanism,
      source,
      provenance: inferred(source, "low"),
    });
  };

  // (c) process sinks in a sorted, stable order.
  const sinks = [...input.sinks].sort(
    (a, b) =>
      cmpStr(a.source.relPath, b.source.relPath) ||
      (a.source.startLine ?? 0) - (b.source.startLine ?? 0) ||
      cmpStr(a.mechanism, b.mechanism),
  );

  let attributedSinks = 0;
  for (const sink of sinks) {
    const line = sink.source.startLine;
    if (line === null) {
      notes.add(`sink '${sink.mechanism}' at ${sink.source.relPath} has no line — not attributed to a function`);
      continue;
    }
    const enclosing = innermostEnclosing(byFile, sink.source.relPath, line);
    if (enclosing === null) {
      notes.add(
        `sink '${sink.mechanism}' at ${sink.source.relPath}:${line} sits in no indexed callable — not attributed to a function`,
      );
      continue;
    }
    attributedSinks += 1;

    // (d) bounded, cycle-aware reverse BFS over callersOf. The sink's own
    // function is attributed at depth 0; every reacher within maxHops follows.
    const visited = new Set<string>([enclosing.nativeId]);
    attribute(enclosing, true, sink.channel, sink.mechanism);
    let frontier: string[] = [enclosing.nativeId];
    let depth = 0;
    while (frontier.length > 0 && depth < maxHops) {
      const next: string[] = [];
      for (const id of [...frontier].sort(cmpStr)) {
        const callers = callersOf.get(id) ?? [];
        // (STOP) a hub is a shared utility, not a notification path: attributed
        // already, but not expanded through.
        if (callers.length > maxFanIn) {
          const node = callableById.get(id);
          notes.add(
            `hub ${node?.name ?? id} at ${node?.filePath ?? "?"}:${node?.startLine ?? "?"} (fan-in ${callers.length} > maxFanIn ${maxFanIn}) not expanded`,
          );
          continue;
        }
        for (const caller of callers) {
          if (visited.has(caller)) continue;
          const node = callableById.get(caller);
          if (node === undefined) continue; // a caller with no locatable callable cannot be attributed
          visited.add(caller);
          attribute(node, false, sink.channel, sink.mechanism);
          next.push(caller);
        }
      }
      frontier = next;
      depth += 1;
    }
    // (STOP) the hop bound: callers beyond it exist but are not attributed.
    if (depth === maxHops && frontier.length > 0) {
      notes.add(
        `reverse reachability from sink '${sink.mechanism}' at ${sink.source.relPath}:${line} capped at maxHops ${maxHops} — deeper callers not attributed`,
      );
    }
  }

  // (e) sorted output — (relPath, startLine, mechanism).
  const notifications = [...records.values()].sort(
    (a, b) =>
      cmpStr(a.source.relPath, b.source.relPath) ||
      (a.source.startLine ?? 0) - (b.source.startLine ?? 0) ||
      cmpStr(a.mechanism, b.mechanism),
  );

  notes.add(
    `notification-reachability: ${notifications.length} record(s) from ${attributedSinks}/${sinks.length} sink(s); maxHops ${maxHops}, maxFanIn ${maxFanIn}`,
  );

  return { notifications, notes: [...notes] };
}

/**
 * The root-relative prefix to strip from index-root-relative file paths.
 *
 * A snapshot's node paths are relative to the *index* root, which for a shared
 * index is the parent of the analyzed root — so a node reads `angels-pizza/src/x`
 * while the structural gate cites `src/x`. This computes the `angels-pizza/`
 * prefix to remove. Empty when the index root is the root itself (already
 * root-relative) or when the root is not under the index root.
 */
export function rootRelativePrefix(indexRoot: string, rootPath: string): string {
  const rel = relative(indexRoot, rootPath).replaceAll("\\", "/");
  if (rel === "" || rel === ".") return "";
  if (rel.startsWith("..")) return "";
  return rel.endsWith("/") ? rel : `${rel}/`;
}

/**
 * Scope a whole-index snapshot to one root, stripping the per-root prefix so its
 * file paths are root-relative — the coordinate space the structural gate and the
 * extracted sinks use. Nodes and edges outside the root are dropped, not renamed.
 */
export function scopeSnapshotToRoot(
  snapshot: CodeGraphSnapshot,
  indexRoot: string,
  rootPath: string,
): CodeGraphSnapshot {
  const prefix = rootRelativePrefix(indexRoot, rootPath);
  if (prefix === "") return snapshot;

  const norm = (fp: string): string => fp.replaceAll("\\", "/");
  const under = (fp: string): boolean => norm(fp).startsWith(prefix);
  const strip = (fp: string): string => norm(fp).slice(prefix.length);

  const nodes = snapshot.nodes.filter((n) => under(n.filePath)).map((n) => ({ ...n, filePath: strip(n.filePath) }));
  const edges = snapshot.edges.filter((e) => under(e.filePath)).map((e) => ({ ...e, filePath: strip(e.filePath) }));
  const unresolvedReferences = snapshot.unresolvedReferences
    .filter((u) => under(u.filePath))
    .map((u) => ({ ...u, filePath: strip(u.filePath) }));

  return {
    nodes,
    edges,
    unresolvedReferences,
    metadata: { ...snapshot.metadata, nodeCount: nodes.length, edgeCount: edges.length },
    truncation: snapshot.truncation,
  };
}

/**
 * Read the batch index DB under `<codeIndexPath>/` and scope
 * it to one root. A missing or degraded index surfaces as the outcome's
 * degradation — the caller fails open, never inventing a graph it does not have.
 */
export function loadRootSnapshot(codeIndexPath: string, rootPath: string): SnapshotOutcome {
  const dbPath = codeIndexDbPath(codeIndexPath);
  const outcome = readBatchDb(dbPath, codeIndexPath);
  if (!outcome.ok) return outcome;
  return { ok: true, snapshot: scopeSnapshotToRoot(outcome.snapshot, codeIndexPath, rootPath) };
}

export interface RootsReachabilityInput {
  /** The index root — the batch DB lives under `<codeIndexPath>/` in CodeGraph's index directory. */
  readonly codeIndexPath?: string | null;
  /** rootName → absolute root path, so a shared index can be scoped per root. */
  readonly rootPaths?: ReadonlyMap<string, string>;
  /** Every standard send sink extracted across the roots, keyed to a root by rootName. */
  readonly sinks: readonly NotificationCallRecord[];
  readonly maxHops?: number;
  readonly maxFanIn?: number;
}

/**
 * Run reverse-reachability across every root against one shared index read once,
 * scoping the snapshot per root. Fails open: no index, or a degraded one, yields
 * no records and a disclosing note rather than an error — the structural
 * knowledge base is already complete without this attribution.
 */
export function deriveNotificationsForRoots(input: RootsReachabilityInput): NotificationReachabilityResult {
  const { codeIndexPath, rootPaths } = input;
  if (codeIndexPath == null || rootPaths === undefined || rootPaths.size === 0) {
    return { notifications: [], notes: ["notification-reachability: no code index available — no reverse-reachability attributed"] };
  }
  const outcome = readBatchDb(codeIndexDbPath(codeIndexPath), codeIndexPath);
  if (!outcome.ok) {
    return {
      notifications: [],
      notes: [`notification-reachability: code index degraded (${outcome.degradation.kind}) — no reverse-reachability attributed`],
    };
  }

  const notifications: NotificationCallRecord[] = [];
  const notes: string[] = [];
  // Roots in a sorted, stable order — the concatenated output must not depend on
  // the map's insertion order.
  const sortedRoots = [...rootPaths].sort((a, b) => cmpStr(a[0], b[0]));
  for (const [rootName, rootPath] of sortedRoots) {
    const rootSinks = input.sinks.filter((n) => n.rootName === rootName);
    if (rootSinks.length === 0) continue;
    const snapshot = scopeSnapshotToRoot(outcome.snapshot, codeIndexPath, rootPath);
    const result = deriveNotificationReachability({
      rootName,
      sinks: rootSinks,
      snapshot,
      ...(input.maxHops === undefined ? {} : { maxHops: input.maxHops }),
      ...(input.maxFanIn === undefined ? {} : { maxFanIn: input.maxFanIn }),
    });
    notifications.push(...result.notifications);
    notes.push(...result.notes);
  }
  return { notifications, notes };
}
