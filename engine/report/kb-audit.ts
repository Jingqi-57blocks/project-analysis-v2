/**
 * Auditing a report back against the knowledge base.
 *
 * The three trial outputs were indistinguishable by appearance — the fabricated
 * one was just as well formatted, with just as many complete sections, and it was
 * the second longest. The only thing that separated them was pulling each
 * statement back to the store. Human review cannot do that at this volume, which
 * is why this step is not optional.
 *
 * This is the whole of the report layer's engine code, and it is deliberately the
 * only part. Reading the base, resolving a subject, choosing what to investigate
 * and writing the document are all the author's job — a second implementation of
 * any of them would only be a second thing to disagree with the first. What the
 * author cannot do is check itself: an agent grading its own report is exactly the
 * failure this module exists to catch.
 *
 * Every check here holds **whatever language the report is written in**: cited
 * paths, cited proportions, and whether the identities the report says it read are
 * real.
 */

import type { Store } from "../store/types.js";

export type FindingCode =
  | "cited-path-not-in-workspace"
  | "cited-extension-absent"
  | "proportion-denominator-unknown"
  | "proportion-mismatch"
  | "checklist-block-missing"
  | "checklist-item-missing"
  | "checklist-verdict-unknown"
  | "cited-id-not-in-base"
  | "verdict-without-evidence"
  | "no-open-finding"
  | "no-checkable-coverage-figure";

/**
 * Whether a finding stops delivery.
 *
 * A fabricated citation, an arithmetic error, or an identity that does not exist
 * means the report says something untrue, and it is not a deliverable. A missing
 * open-ended finding means the author executed the checklist without investigating
 * — worth knowing, and a reason to reject the run, but not itself untruth.
 */
export type FindingSeverity = "blocking" | "notice";

export interface AuditFinding {
  readonly code: FindingCode;
  readonly severity: FindingSeverity;
  readonly detail: string;
  /** What in the report triggered it. */
  readonly evidence: string;
}

export interface AuditResult {
  /** True when nothing blocking was found. Notices do not stop delivery. */
  readonly passed: boolean;
  readonly findings: readonly AuditFinding[];
  /** Each checklist item's verdict, and how many of its cited ids resolved. */
  readonly checklist: readonly ChecklistAudit[];
}

export interface ChecklistAudit {
  readonly id: string;
  readonly verdict: string;
  readonly cited: number;
  readonly resolved: number;
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
 * the real finding in noise. A qualified path is unambiguous and needs no filter.
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

/** Verdicts the closing block may carry. Anything else is a malformed report. */
const VERDICTS = new Set(["hit", "searched-not-found", "cannot-determine"]);

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

/**
 * Whether the report wrote any coverage figure the audit could check at all.
 *
 * The arithmetic check only runs on figures written as `N% (n/d)`. One report put a
 * noun between the sign and the bracket — "14% of outbound calls (66/474)" — and
 * every coverage number in it went unexamined while the audit reported no findings.
 * The machinery ran and found nothing to run on.
 *
 * This does not flag individual percentages. A percentage in a report may be a
 * coverage figure, which must carry its fraction, or a limit the code enforces —
 * "the ratio must not exceed 100%" — which must not be made to. Nothing in the
 * formatting separates them, so the audit reports the one thing it can stand
 * behind: this report used percentages, and not one of them was checkable.
 */
function hasUncheckableCoverageOnly(report: string): boolean {
  const body = report.replace(/<details>[\s\S]*?<\/details>/g, "").replace(/```[\s\S]*?```/g, "");
  return matches(body, /\d[\d.,]*\s*%/g).length > 0 && citedProportions(body).length === 0;
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

export interface ChecklistEntry {
  readonly id: string;
  readonly verdict: string;
  readonly evidence: readonly string[];
}

/**
 * The checklist's verdicts.
 *
 * Read from `checklist.json` beside the report. It used to be a fenced block at the
 * end of the report itself, which put a wall of machine identifiers in front of a
 * business reader — the audit needs them, and nobody else does.
 *
 * A fenced block is still accepted, so an older artefact still audits. Last one
 * wins there: a report may quote the shape while explaining itself, and the real one
 * is the one it finishes on.
 */
export function readChecklistBlock(source: string): readonly ChecklistEntry[] | null {
  const candidates = [...matches(source, /```json\s*([\s\S]*?)```/g).map((m) => m[1] ?? ""), source];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    let parsed: { checklist?: unknown };
    try {
      parsed = JSON.parse(candidates[index] ?? "") as typeof parsed;
    } catch {
      continue;
    }
    if (!Array.isArray(parsed.checklist)) continue;
    const entries: ChecklistEntry[] = [];
    for (const raw of parsed.checklist as readonly Record<string, unknown>[]) {
      if (typeof raw?.id !== "string" || typeof raw?.verdict !== "string") continue;
      const evidence = Array.isArray(raw.evidence)
        ? (raw.evidence as readonly unknown[]).filter((value): value is string => typeof value === "string")
        : [];
      entries.push({ id: raw.id, verdict: raw.verdict, evidence });
    }
    if (entries.length > 0) return entries;
  }
  return null;
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

function collectCardinalities(payload: string, into: Set<number>): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (Array.isArray(value) && value.length > 0) into.add(value.length);
    else if (typeof value === "number" && Number.isInteger(value) && value > 0) into.add(value);
  }
}

/**
 * What the workspace actually contains, as far as citations are concerned.
 *
 * Paths are matched on suffix rather than equality: a report may cite a path
 * while the store holds it under a root, and a citation that names a real file
 * should not be called fabricated over a prefix.
 *
 * Denominators include the cardinalities inside derived payloads — how many
 * endpoints a capability has, how many entities it touches. Without them a
 * correct subject-scoped report is rejected: "50% (13/26)" is about that
 * capability's 26 endpoints, and no workspace-wide count equals 26.
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
  // `paths` is deduplicated because it is a lookup set, and two roots holding a
  // README.md are one entry in it. The file *count* is not that number — on the
  // reference snapshot 2128 files collapse to 2046 distinct paths — so a report
  // correctly citing the file count was rejected for a denominator nothing
  // matched. Count the rows, and count them the ways a report legitimately
  // groups them.
  denominators.add(files.length);
  denominators.add(paths.size);
  for (const row of store.all(
    `select count(*) as n from files f
       join source_roots r on r.id = f.source_root_id
      where r.snapshot_id = ? group by f.disposition
     union all
     select count(*) as n from files f
       join source_roots r on r.id = f.source_root_id
      where r.snapshot_id = ? group by r.name
     union all
     select count(*) as n from files f
       join source_roots r on r.id = f.source_root_id
      where r.snapshot_id = ? group by r.name, f.disposition`,
    [snapshotId, snapshotId, snapshotId],
  ) as readonly { n: number }[]) {
    denominators.add(row.n);
  }
  // Per-kind counts from every table a report may cite, plus each table's total.
  // `evidence_items` was missing, so a chapter counting documentation comments or
  // interface strings had no denominator the audit would accept.
  const kindCounts = store.all(
    `select count(*) as n from structural_records where snapshot_id = ? group by kind
     union select count(*) as n from behavior_facts where snapshot_id = ? group by kind
     union select count(*) as n from derived_records where snapshot_id = ? group by kind
     union select count(*) as n from evidence_items where snapshot_id = ? group by kind
     union select count(*) as n from structural_records where snapshot_id = ?
     union select count(*) as n from behavior_facts where snapshot_id = ?
     union select count(*) as n from derived_records where snapshot_id = ?
     union select count(*) as n from evidence_items where snapshot_id = ?`,
    Array.from({ length: 8 }, () => snapshotId),
  ) as readonly { n: number }[];
  for (const row of kindCounts) denominators.add(row.n);

  const payloads = store.all(
    `select payload from derived_records
      where snapshot_id = ?
        and kind in ('health-signal','coverage-note','feature','module','component','structural-finding')`,
    [snapshotId],
  ) as readonly { payload: string }[];
  for (const row of payloads) {
    collectCardinalities(row.payload, denominators);
    for (const match of matches(row.payload, /(\d[\d,]*)\s*(?:\/|of)\s*(\d[\d,]*)/g)) {
      const denominator = Number((match[2] ?? "").replace(/,/g, ""));
      if (Number.isFinite(denominator) && denominator > 0) denominators.add(denominator);
    }
  }
  return { paths, extensions, denominators };
}

/**
 * Paths the analysis itself produced.
 *
 * A report may legitimately name the knowledge base it was written from, or its own
 * run directory. Those are artefacts of this tool, not files in the analysed
 * project, and checking them against the project's file list marks a correct report
 * as fabricated.
 */
const ANALYSIS_ARTIFACT = /(^|\/)\.analysis\//;

function pathIsKnown(inventory: WorkspaceInventory, cited: string): boolean {
  if (ANALYSIS_ARTIFACT.test(cited)) return true;
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

/**
 * Which of the given identities exist in the base.
 *
 * This is what replaced the persisted claim layer. The report names the rows it
 * read; every name is looked up. An identity that does not resolve was not read,
 * whatever the prose around it says.
 */
export function resolveIdentities(store: Store, snapshotId: number, ids: readonly string[]): Set<string> {
  const found = new Set<string>();
  if (ids.length === 0) return found;
  const columns: readonly [string, string][] = [
    ["structural_records", "record_key"],
    ["derived_records", "record_key"],
    ["behavior_facts", "fact_id"],
    ["evidence_items", "item_key"],
  ];
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += 400) {
    const batch = unique.slice(start, start + 400);
    const placeholders = batch.map(() => "?").join(",");
    for (const [table, column] of columns) {
      const rows = store.all(
        `select ${column} as id from ${table} where snapshot_id = ? and ${column} in (${placeholders})`,
        [snapshotId, ...batch],
      ) as readonly { id: string }[];
      for (const row of rows) found.add(row.id);
    }
  }
  return found;
}

export interface AuditInput {
  readonly report: string;
  readonly inventory: WorkspaceInventory;
  /** Checklist ids the governing rules require. Empty skips the completeness check. */
  readonly requiredChecklistIds?: readonly string[];
  /** Contents of `checklist.json`; falls back to a fenced block in the report. */
  readonly checklist?: string;
  /** Resolves cited identities against the base. Omitted in fixture replays. */
  readonly resolveIds?: (ids: readonly string[]) => ReadonlySet<string>;
}

/**
 * Runs the language-independent checks and returns a pass/fail verdict.
 *
 * A failing audit means the report **MUST NOT** be exported as a deliverable. It
 * may still be written out as a diagnostic artefact.
 */
export function auditReport(input: AuditInput): AuditResult {
  const findings: AuditFinding[] = [];
  const { report, inventory } = input;

  for (const cited of citedPaths(report)) {
    if (pathIsKnown(inventory, cited)) continue;
    const extension = extensionOf(cited);
    if (extension.length > 0 && SOURCE_EXTENSIONS.has(extension) && !inventory.extensions.has(extension)) {
      findings.push({
        code: "cited-extension-absent",
        severity: "blocking",
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
      severity: "blocking",
      detail: "cited path is not among the files that were read",
      evidence: cited,
    });
  }

  if (hasUncheckableCoverageOnly(report)) {
    findings.push({
      code: "no-checkable-coverage-figure",
      severity: "notice",
      detail: "the report uses percentages but none is written as N% (n/d), so no coverage figure could be checked",
      evidence: "coverage figures",
    });
  }

  for (const pair of citedProportions(report)) {
    if (!inventory.denominators.has(pair.denominator)) {
      findings.push({
        code: "proportion-denominator-unknown",
        severity: "blocking",
        detail: `cites ${pair.numerator}/${pair.denominator}, but no quantity in the store equals ${pair.denominator}`,
        evidence: `${pair.percent}% (${pair.numerator}/${pair.denominator})`,
      });
      continue;
    }
    const actual = Math.round((pair.numerator / pair.denominator) * 100);
    if (Math.abs(actual - pair.percent) > 1) {
      findings.push({
        code: "proportion-mismatch",
        severity: "blocking",
        detail: `states ${pair.percent}% but ${pair.numerator}/${pair.denominator} is ${actual}%`,
        evidence: `${pair.percent}% (${pair.numerator}/${pair.denominator})`,
      });
    }
  }

  const required = input.requiredChecklistIds ?? [];
  const entries = readChecklistBlock(input.checklist ?? report);
  const checklist: ChecklistAudit[] = [];

  if (entries === null) {
    if (required.length > 0) {
      findings.push({
        code: "checklist-block-missing",
        severity: "blocking",
        detail: "no checklist.json beside the report, so nothing it claims to have read can be checked",
        evidence: "checklist.json",
      });
    }
    return { passed: findings.every((f) => f.severity !== "blocking"), findings, checklist };
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const id of required) {
    if (byId.has(id)) continue;
    findings.push({
      code: "checklist-item-missing",
      severity: "blocking",
      detail: `checklist item "${id}" has no verdict; every item is reportable, including the ones that found nothing`,
      evidence: id,
    });
  }

  const resolved = input.resolveIds?.(entries.flatMap((entry) => entry.evidence)) ?? null;

  for (const entry of entries) {
    if (!VERDICTS.has(entry.verdict)) {
      findings.push({
        code: "checklist-verdict-unknown",
        severity: "blocking",
        detail: `verdict "${entry.verdict}" is not one of hit, searched-not-found, cannot-determine`,
        evidence: entry.id,
      });
    }
    if (entry.verdict !== "cannot-determine" && entry.evidence.length === 0) {
      findings.push({
        code: "verdict-without-evidence",
        severity: "blocking",
        detail: `"${entry.id}" reports "${entry.verdict}" while naming no row it read; only cannot-determine may cite nothing`,
        evidence: entry.id,
      });
    }
    let resolvedCount = entry.evidence.length;
    if (resolved !== null) {
      resolvedCount = entry.evidence.filter((id) => resolved.has(id)).length;
      for (const id of entry.evidence) {
        if (resolved.has(id)) continue;
        findings.push({
          code: "cited-id-not-in-base",
          severity: "blocking",
          detail: `"${entry.id}" cites an identity the knowledge base does not contain`,
          evidence: id,
        });
      }
    }
    checklist.push({ id: entry.id, verdict: entry.verdict, cited: entry.evidence.length, resolved: resolvedCount });
  }

  // The open-ended item is the only one that tests whether the author
  // investigated rather than executed a list. A run that closes it without a
  // finding is worth accepting only deliberately.
  const open = byId.get("open");
  if (required.includes("open") && (open === undefined || open.verdict !== "hit")) {
    findings.push({
      code: "no-open-finding",
      severity: "notice",
      detail: "no finding came from a hypothesis the checklist did not name; the author executed the list rather than investigating",
      evidence: "open",
    });
  }

  return { passed: findings.every((finding) => finding.severity !== "blocking"), findings, checklist };
}

/** A short, ordered account of why an audit failed. */
export function explainAudit(result: AuditResult): string {
  if (result.passed && result.findings.length === 0) return "audit passed";
  if (result.passed) return `audit passed with ${result.findings.length} notice(s)`;
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
