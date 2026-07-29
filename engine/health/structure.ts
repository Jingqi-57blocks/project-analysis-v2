/**
 * What is worth a second look about the shape of the system.
 *
 * Distinct from the per-capability findings, which are about behaviour, and
 * from the signals, which are about the analysis. These are properties of the
 * architecture: two services writing one table, a capability served twice, a
 * schema two parts disagree about. None of them can be seen from inside a
 * single service, which is why nothing else in the pipeline reports them.
 *
 * Every one is derived from records already collected, and worded as what was
 * observed — the tool cannot know whether a shared table is a deliberate
 * integration or an accident, and says so by describing rather than judging.
 */

import type { DataAccessRecord, RouteRecord } from "../structural/boundaries.js";
import type { Severity } from "./signals.js";

export interface StructuralFinding {
  readonly id: string;
  readonly title: string;
  readonly finding: string;
  readonly severity: Severity;
  readonly evidence: readonly string[];
}

export interface StructureInput {
  readonly dataAccess: readonly DataAccessRecord[];
  readonly routes: readonly RouteRecord[];
  /** Entity name → the services declaring it, with the columns each declares. */
  readonly entityColumns: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  readonly rootNames: readonly string[];
}

export interface StructureLimits {
  readonly maxNamed: number;
}

export const DEFAULT_STRUCTURE_LIMITS: StructureLimits = { maxNamed: 8 };

const WRITE_OPERATIONS = new Set(["write", "delete"]);

function listOf(items: readonly string[], limit: number): string {
  const shown = items.slice(0, limit);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** A path with its parameters flattened, so `/users/:id` and `/users/{uid}` compare equal. */
export function normalizePath(path: string): string {
  return path
    .toLowerCase()
    .replaceAll(/[:{<][^/}>]*[}>]?/g, ":p")
    .replace(/\/+$/, "")
    .replace(/^\/(v\d+|api)(?=\/)/, "");
}

export function computeStructuralFindings(
  input: StructureInput,
  limits: StructureLimits = DEFAULT_STRUCTURE_LIMITS,
): readonly StructuralFinding[] {
  const findings: StructuralFinding[] = [];

  // Who writes what, and who only reads it.
  const writers = new Map<string, Set<string>>();
  const readers = new Map<string, Set<string>>();
  for (const access of input.dataAccess) {
    if (access.entity === null) continue;
    const target = WRITE_OPERATIONS.has(access.operation) ? writers : readers;
    const existing = target.get(access.entity) ?? new Set<string>();
    existing.add(access.rootName);
    target.set(access.entity, existing);
  }

  const shared = [...writers.entries()]
    .filter(([, roots]) => roots.size > 1)
    .map(([table, roots]) => ({ table, roots: [...roots].sort() }))
    .sort((a, b) => b.roots.length - a.roots.length || a.table.localeCompare(b.table));

  if (shared.length > 0) {
    findings.push({
      id: "tables-written-by-several-services",
      title: "Tables written by more than one part",
      finding: `${shared.length} tables are written by more than one part of the system, so the rules that guard them are enforced in more than one place. ${listOf(
        shared.map((entry) => `${entry.table} (${entry.roots.join(", ")})`),
        limits.maxNamed,
      )}.`,
      severity: "concern",
      evidence: shared.slice(0, limits.maxNamed).map((entry) => `${entry.table}: ${entry.roots.join(", ")}`),
    });
  }

  const crossRead = [...readers.entries()]
    .map(([table, readingRoots]) => {
      const writingRoots = writers.get(table) ?? new Set<string>();
      const foreign = [...readingRoots].filter((root) => !writingRoots.has(root));
      return { table, foreign: foreign.sort(), writers: [...writingRoots].sort() };
    })
    .filter((entry) => entry.foreign.length > 0 && entry.writers.length > 0)
    .sort((a, b) => a.table.localeCompare(b.table));

  if (crossRead.length > 0) {
    findings.push({
      id: "tables-read-across-a-boundary",
      title: "Tables one part reads and another owns",
      finding: `${crossRead.length} tables are read by a part that does not write them, so a change to how the owner stores the data reaches the reader without passing through an interface.`,
      severity: "notice",
      evidence: crossRead
        .slice(0, limits.maxNamed)
        .map((entry) => `${entry.table}: read by ${entry.foreign.join(", ")}, written by ${entry.writers.join(", ")}`),
    });
  }

  // Endpoints two parts both serve.
  const byPath = new Map<string, Set<string>>();
  for (const route of input.routes) {
    if (route.surface === "client") continue;
    const key = `${route.method ?? "ANY"} ${normalizePath(route.path)}`;
    const existing = byPath.get(key) ?? new Set<string>();
    existing.add(route.rootName);
    byPath.set(key, existing);
  }

  const duplicated = [...byPath.entries()]
    .filter(([, roots]) => roots.size > 1)
    .map(([key, roots]) => `${key} (${[...roots].sort().join(", ")})`)
    .sort();

  if (duplicated.length > 0) {
    findings.push({
      id: "endpoints-served-by-several-parts",
      title: "Endpoints more than one part answers",
      finding: `${duplicated.length} endpoints are declared by more than one part of the system, so which one answers depends on how requests are routed rather than on the code.`,
      severity: "notice",
      evidence: duplicated.slice(0, limits.maxNamed),
    });
  }

  // One table, two disagreeing declarations.
  const disagreeing: string[] = [];
  for (const [table, byRoot] of input.entityColumns) {
    if (byRoot.size < 2) continue;
    const shapes = [...byRoot.entries()].map(([root, columns]) => ({
      root,
      columns: [...columns].sort(),
    }));
    const first = shapes[0]!;
    const differs = shapes.some(
      (shape) => shape.columns.join(",") !== first.columns.join(","),
    );
    if (differs) {
      disagreeing.push(
        `${table}: ${shapes.map((shape) => `${shape.root} declares ${shape.columns.length}`).join(", ")}`,
      );
    }
  }

  if (disagreeing.length > 0) {
    findings.push({
      id: "tables-declared-differently",
      title: "Tables described differently by different parts",
      finding: `${disagreeing.length} tables are declared with different columns in different parts, so at least one of those descriptions is incomplete or out of date.`,
      severity: "notice",
      evidence: disagreeing.slice(0, limits.maxNamed).sort(),
    });
  }

  const rank: Record<Severity, number> = { concern: 0, notice: 1, info: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
