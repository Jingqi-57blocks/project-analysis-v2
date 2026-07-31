/**
 * Import every CodeGraph node from a batch snapshot (PI-34).
 *
 * Maps the snapshot's nodes into an intermediate representation that classifies
 * each node's structural kind, preserves its metadata, and keeps CodeGraph's own
 * id as attribution — never a canonical id, which PI-57 assigns later. Unknown
 * node kinds are tracked rather than silently flattened into a plain symbol, and
 * the per-kind counts are reported so a real index's classification is
 * checkable. No node is dropped and no language is skipped wholesale.
 */

import type { CodeGraphSnapshot } from "./batch.js";

export type StructuralNodeKind = "source-file" | "import" | "route" | "symbol";

export interface ImportedNode {
  /** CodeGraph's own node id, kept as attribution — never the canonical id. */
  readonly nativeId: string;
  readonly structuralKind: StructuralNodeKind;
  /** The graph's raw kind, preserved for classification and unknown tracking. */
  readonly rawKind: string;
  readonly name: string;
  readonly qualifiedName: string | null;
  readonly filePath: string;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface NodeImport {
  readonly nodes: readonly ImportedNode[];
  readonly total: number;
  readonly byStructuralKind: Readonly<Record<StructuralNodeKind, number>>;
  readonly byRawKind: Readonly<Record<string, number>>;
  /** Raw kinds not in the known set — reported, never coerced to a plain symbol silently. */
  readonly unknownKinds: readonly string[];
  readonly truncated: boolean;
}

/** file/import/route are structure, not symbols; everything else is a symbol. */
function classify(kind: string): StructuralNodeKind {
  switch (kind) {
    case "file":
      return "source-file";
    case "import":
      return "import";
    case "route":
      return "route";
    default:
      return "symbol";
  }
}

/**
 * Kinds this build recognizes. A kind outside this set still becomes a symbol
 * (an honest label beats a dropped node), but it is also recorded in
 * `unknownKinds` so the coverage matrix sees it rather than a silent coercion.
 */
const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "file",
  "import",
  "route",
  "function",
  "method",
  "class",
  "struct",
  "interface",
  "type",
  "type_alias",
  "enum",
  "constant",
  "const",
  "variable",
  "field",
  "property",
  "module",
  "package",
  "namespace",
]);

export function importNodes(snapshot: CodeGraphSnapshot): NodeImport {
  const byStructuralKind: Record<StructuralNodeKind, number> = {
    "source-file": 0,
    import: 0,
    route: 0,
    symbol: 0,
  };
  const byRawKind: Record<string, number> = {};
  const unknown = new Set<string>();

  const nodes: ImportedNode[] = snapshot.nodes.map((node) => {
    const structuralKind = classify(node.kind);
    byStructuralKind[structuralKind] = (byStructuralKind[structuralKind] ?? 0) + 1;
    byRawKind[node.kind] = (byRawKind[node.kind] ?? 0) + 1;
    if (!KNOWN_KINDS.has(node.kind)) unknown.add(node.kind);
    return {
      nativeId: node.nativeId,
      structuralKind,
      rawKind: node.kind,
      name: node.name,
      qualifiedName: node.metadata.qualifiedName ?? null,
      filePath: node.filePath,
      startLine: node.startLine,
      endLine: node.endLine,
      metadata: node.metadata,
    };
  });

  return {
    nodes,
    total: nodes.length,
    byStructuralKind,
    byRawKind,
    unknownKinds: [...unknown].sort(),
    truncated: snapshot.truncation.truncated,
  };
}
