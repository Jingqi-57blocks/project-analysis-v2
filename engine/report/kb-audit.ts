/**
 * Auditing a report back against the knowledge base.
 *
 * The three trial outputs were indistinguishable by appearance — the fabricated
 * one was just as well formatted, with just as many complete sections. The only
 * thing that separated them was pulling each statement back to the store. Human
 * review cannot do that at this volume, which is why this step is not optional.
 *
 * This module performs the checks that hold **whatever language the report is
 * written in**: cited paths, cited proportions, and whether a fact kind was used
 * at all. Comparing what a report *asserts* against what the store concluded is a
 * claim-level check — claims are language-independent, prose is not — and belongs
 * with the claim layer, not here.
 */

import type { Store } from "../store/types.js";
import type { FactPack } from "../kb/fact-pack.js";

export type FindingCode =
  | "cited-path-not-in-workspace"
  | "cited-extension-absent"
  | "proportion-denominator-unknown"
  | "proportion-mismatch"
  | "kind-never-used"
  | "chapter-without-its-kind";

export interface AuditFinding {
  readonly code: FindingCode;
  readonly detail: string;
  /** What in the report triggered it. */
  readonly evidence: string;
}

export interface AuditResult {
  readonly passed: boolean;
  readonly findings: readonly AuditFinding[];
  /** Kinds in the pack, and how many of their rows the report cited. */
  readonly kindUsage: readonly { readonly kind: string; readonly available: number; readonly cited: number }[];
}

/**
 * Citations as they appear in prose.
 *
 * Both a qualified path and a bare filename count: a fabricated citation is often
 * a bare name, and requiring a directory would miss it entirely. The extension
 * must be alphabetic so that version numbers and decimals are not read as files.
 */
const PATH_PATTERN = /(?:^|[^\w./-])((?:[\w.-]+\/)*[\w-]+\.[A-Za-z]{1,6})(?::\d+)?/g;

/**
 * Extensions that name a source file in some programming language.
 *
 * This is knowledge about languages, not about any project. A bare filename is
 * only treated as a citation when its extension is one of these: prose is full of
 * `example.com`, `Node.js` and `req.user`, and treating those as citations buries
 * the real finding in noise. A qualified path is unambiguous and needs no such
 * filter.
 */
const SOURCE_EXTENSIONS = new Set([
  "c", "cc", "cjs", "clj", "cpp", "cs", "css", "cts", "dart", "ex", "exs", "go",
  "groovy", "h", "hpp", "hs", "java", "js", "json", "jsx", "kt", "lua", "m", "md",
  "mjs", "mts", "php", "pl", "proto", "py", "r", "rb", "rs", "scala", "sh", "sql",
  "swift", "toml", "ts", "tsx", "vue", "yaml", "yml",
]);

/**
 * Coverage proportions, in the one form that is unambiguous across languages: a
 * percentage immediately followed by its fraction, as the coverage chapter is
 * required to write them. A bare `a/b` in prose is a ratio, not a citation, and
 * checking those produces false positives on correct reports.
 */
const PROPORTION_PATTERN = /(\d+)\s*%\s*[（(]\s*(\d[\d,]*)\s*(?:\/|of)\s*(\d[\d,]*)\s*[)）]/g;

function matches(text: string, pattern: RegExp): readonly RegExpExecArray[] {
  const found: RegExpExecArray[] = [];
  const local = new RegExp(pattern.source, pattern.flags);
  let match = local.exec(text);
  while (match !== null) {
    found.push(match);
    match = local.exec(text);
  }
  return found;
}

export function citedPaths(report: string): readonly string[] {
  return [...new Set(matches(report, PATH_PATTERN).map((match) => match[1] ?? "").filter((path) => path.length > 0))];
}

export interface CitedProportion {
  readonly percent: number;
  readonly numerator: number;
  readonly denominator: number;
}

export function citedProportions(report: string): readonly CitedProportion[] {
  return matches(report, PROPORTION_PATTERN)
    .map((match) => ({
      percent: Number(match[1] ?? ""),
      numerator: Number((match[2] ?? "").replace(/,/g, "")),
      denominator: Number((match[3] ?? "").replace(/,/g, "")),
    }))
    .filter((pair) => Number.isFinite(pair.numerator) && Number.isFinite(pair.denominator) && pair.denominator > 0);
}

export interface WorkspaceInventory {
  readonly paths: ReadonlySet<string>;
  readonly extensions: ReadonlySet<string>;
  /** Every quantity the store can justify as a denominator. */
  readonly denominators: ReadonlySet<number>;
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

/**
 * What the workspace actually contains, as far as citations are concerned.
 *
 * Paths are matched on suffix rather than equality: a report may cite
 * `internal/handlers/leave/service.go` while the store holds it under a root, and
 * a citation that names a real file should not be called fabricated over a prefix.
 */
export function readInventory(store: Store, snapshotId: number): WorkspaceInventory {
  const files = store.all(
    `select f.rel_path as rel_path from files f
       join source_roots r on r.id = f.source_root_id
      where r.snapshot_id = ?`,
    [snapshotId],
  ) as readonly { rel_path: string }[];
  const paths = new Set(files.map((row) => row.rel_path));
  const extensions = new Set([...paths].map(extensionOf).filter((ext) => ext.length > 0));

  const denominators = new Set<number>();
  denominators.add(paths.size);
  const kindCounts = store.all(
    `select count(*) as n from structural_records where snapshot_id = ? group by kind
     union select count(*) as n from behavior_facts where snapshot_id = ? group by kind
     union select count(*) as n from derived_records where snapshot_id = ? group by kind`,
    [snapshotId, snapshotId, snapshotId],
  ) as readonly { n: number }[];
  for (const row of kindCounts) denominators.add(row.n);
  const signals = store.all(
    `select payload from derived_records where snapshot_id = ? and kind in ('health-signal','coverage-note')`,
    [snapshotId],
  ) as readonly { payload: string }[];
  for (const row of signals) {
    for (const match of matches(row.payload, /(\d[\d,]*)\s*(?:\/|of)\s*(\d[\d,]*)/g)) {
      const denominator = Number((match[2] ?? "").replace(/,/g, ""));
      if (Number.isFinite(denominator) && denominator > 0) denominators.add(denominator);
    }
  }
  return { paths, extensions, denominators };
}

function pathIsKnown(inventory: WorkspaceInventory, cited: string): boolean {
  if (inventory.paths.has(cited)) return true;
  for (const known of inventory.paths) {
    if (known.endsWith(`/${cited}`) || cited.endsWith(`/${known}`)) return true;
  }
  return false;
}

/** Rebuilds an inventory from a committed fixture, for tests and replays. */
export function inventoryFrom(data: {
  readonly paths: readonly string[];
  readonly extensions: readonly string[];
  readonly denominators: readonly number[];
}): WorkspaceInventory {
  return {
    paths: new Set(data.paths),
    extensions: new Set(data.extensions),
    denominators: new Set(data.denominators),
  };
}

export interface AuditInput {
  readonly report: string;
  readonly inventory: WorkspaceInventory;
  /** The pack the report was written from, when there is one. */
  readonly pack?: FactPack;
  /**
   * Kinds whose chapter the report demonstrably wrote — supplied by the caller,
   * since which chapter exists is a property of the spec, not of this module.
   */
  readonly chaptersWritten?: readonly string[];
}

/**
 * Runs the language-independent checks and returns a pass/fail verdict.
 *
 * A failing audit means the report **MUST NOT** be exported as a deliverable. It
 * may still be written out as a diagnostic artefact.
 */
export function auditReport(input: AuditInput): AuditResult {
  const findings: AuditFinding[] = [];
  const { report, inventory, pack } = input;

  for (const cited of citedPaths(report)) {
    if (pathIsKnown(inventory, cited)) continue;
    const extension = extensionOf(cited);
    if (extension.length > 0 && SOURCE_EXTENSIONS.has(extension) && !inventory.extensions.has(extension)) {
      findings.push({
        code: "cited-extension-absent",
        detail: `cites a .${extension} file, but the workspace contains no .${extension} file at all`,
        evidence: cited,
      });
      continue;
    }
    // A bare name is only a citation when its extension proves it is one; an
    // unqualified token that reaches here is prose, not a claim about a file.
    if (!cited.includes("/")) continue;
    findings.push({
      code: "cited-path-not-in-workspace",
      detail: "cited path is not among the files that were read",
      evidence: cited,
    });
  }

  for (const pair of citedProportions(report)) {
    if (!inventory.denominators.has(pair.denominator)) {
      findings.push({
        code: "proportion-denominator-unknown",
        detail: `cites ${pair.numerator}/${pair.denominator}, but no quantity in the store equals ${pair.denominator}`,
        evidence: `${pair.percent}% (${pair.numerator}/${pair.denominator})`,
      });
      continue;
    }
    const actual = Math.round((pair.numerator / pair.denominator) * 100);
    if (Math.abs(actual - pair.percent) > 1) {
      findings.push({
        code: "proportion-mismatch",
        detail: `states ${pair.percent}% but ${pair.numerator}/${pair.denominator} is ${actual}%`,
        evidence: `${pair.percent}% (${pair.numerator}/${pair.denominator})`,
      });
    }
  }

  const kindUsage: { kind: string; available: number; cited: number }[] = [];
  if (pack !== undefined) {
    const citedKeys = new Set(citedPaths(report));
    for (const kind of [...new Set(pack.rows.map((row) => row.kind))].sort()) {
      const rows = pack.rows.filter((row) => row.kind === kind);
      const cited = rows.filter((row) => row.relPath !== null && citedKeys.has(row.relPath)).length;
      kindUsage.push({ kind, available: rows.length, cited });
    }
    for (const kind of pack.requires) {
      const usage = kindUsage.find((entry) => entry.kind === kind);
      if (usage === undefined || usage.available === 0) continue;
      if (usage.cited > 0) continue;
      findings.push({
        code: "kind-never-used",
        detail: `${usage.available} "${kind}" rows were available and none is cited`,
        evidence: kind,
      });
      if ((input.chaptersWritten ?? []).includes(kind)) {
        findings.push({
          code: "chapter-without-its-kind",
          detail: `the chapter fed by "${kind}" was written without citing any of its ${usage.available} rows`,
          evidence: kind,
        });
      }
    }
  }

  return { passed: findings.length === 0, findings, kindUsage };
}

/** A short, ordered account of why an audit failed. */
export function explainAudit(result: AuditResult): string {
  if (result.passed) return "audit passed";
  const byCode = new Map<FindingCode, AuditFinding[]>();
  for (const finding of result.findings) {
    byCode.set(finding.code, [...(byCode.get(finding.code) ?? []), finding]);
  }
  const lines: string[] = [`audit failed; ${result.findings.length} finding(s):`];
  for (const [code, group] of [...byCode].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`  ${code} (${group.length}):`);
    for (const finding of group.slice(0, 5)) lines.push(`    - ${finding.evidence}: ${finding.detail}`);
    if (group.length > 5) lines.push(`    - … and ${group.length - 5} more`);
  }
  return lines.join("\n");
}
