/**
 * Run identity and the output layout.
 *
 * Reports are compared across runs — after a spec change, a language change, or a
 * model-tier change you want the before and after side by side. The previous
 * layout keyed on snapshot identity and language, so re-running the same analysis
 * overwrote in place and there was nothing to compare against.
 *
 * So every run gets its own directory and nothing ever overwrites. A run is
 * identified by the wall-clock minute it started, in a fixed zone, plus a label
 * for what it produced.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";

/**
 * The zone run ids are stamped in, fixed rather than read from the machine.
 *
 * Reading the local zone would make ids incomparable the moment the work moved to
 * another machine, or someone changed a system setting — and comparability is the
 * entire purpose.
 */
export const RUN_ID_TIME_ZONE = "Asia/Shanghai";

const FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: RUN_ID_TIME_ZONE,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function parts(instant: Date): { month: string; day: string; hour: string; minute: string } {
  const found = new Map(FORMATTER.formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    month: found.get("month") ?? "00",
    day: found.get("day") ?? "00",
    hour: found.get("hour") ?? "00",
    minute: found.get("minute") ?? "00",
  };
}

/** `MM-DD_HH-mm`, no year. Dashes on disk; a colon breaks archives and Windows. */
export function runStamp(instant: Date): string {
  const { month, day, hour, minute } = parts(instant);
  return `${month}-${day}_${hour}-${minute}`;
}

/** `MM-DD HH:mm` — the same moment as the reader sees it, in the manifest and page header. */
export function displayStamp(instant: Date): string {
  const { month, day, hour, minute } = parts(instant);
  return `${month}-${day} ${hour}:${minute}`;
}

/** Folds a label to something safe as a directory name, without losing its meaning. */
export function normalizeLabel(label: string): string {
  const cleaned = label
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned.length === 0 ? "run" : cleaned;
}

export class RunDirectoryExistsError extends Error {
  constructor(readonly path: string) {
    super(`run directory already exists and will not be overwritten: ${path}`);
    this.name = "RunDirectoryExistsError";
  }
}

/**
 * Allocates a fresh run directory.
 *
 * Two invocations inside one minute would otherwise collide; the second takes a
 * `-2` suffix rather than joining the first. An existing directory is never
 * written into — history is the point, so overwriting it is the one thing this
 * must not do.
 */
export function allocateRunDirectory(root: string, label: string, instant: Date): { runId: string; path: string } {
  const base = `${runStamp(instant)}_${normalizeLabel(label)}`;
  for (let attempt = 1; attempt <= 99; attempt += 1) {
    const runId = attempt === 1 ? base : `${base}-${attempt}`;
    const path = `${root}/${runId}`;
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
      return { runId, path };
    }
  }
  throw new RunDirectoryExistsError(`${root}/${base}`);
}

export interface TargetRecord {
  readonly scope: string;
  readonly audience: string;
  readonly module: string | null;
  readonly specId: string;
  readonly specVersion: string;
  readonly directory: string;
  readonly auditPassed: boolean | null;
}

export interface RunManifest {
  readonly runId: string;
  /** Wall clock in the fixed zone, as the reader sees it. */
  readonly startedAtLocal: string;
  readonly timeZone: string;
  /** The same instant in UTC. Sort on this, not on the local stamp. */
  readonly startedAtUtc: string;
  readonly snapshotIdentity: string;
  readonly language: string;
  /** Which model tier authored it — without this, a cross-run difference is unattributable. */
  readonly modelTier: string;
  readonly targets: readonly TargetRecord[];
  /** Overall verdict: false if any target failed its audit. */
  readonly auditPassed: boolean | null;
}

export function buildManifest(input: {
  readonly runId: string;
  readonly instant: Date;
  readonly snapshotIdentity: string;
  readonly language: string;
  readonly modelTier: string;
  readonly targets: readonly TargetRecord[];
}): RunManifest {
  const verdicts = input.targets.map((target) => target.auditPassed);
  return {
    runId: input.runId,
    startedAtLocal: displayStamp(input.instant),
    timeZone: RUN_ID_TIME_ZONE,
    startedAtUtc: input.instant.toISOString(),
    snapshotIdentity: input.snapshotIdentity,
    language: input.language,
    modelTier: input.modelTier,
    targets: input.targets,
    auditPassed: verdicts.some((verdict) => verdict === null) ? null : verdicts.every(Boolean),
  };
}

export function writeManifest(directory: string, manifest: RunManifest): void {
  writeFileSync(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
}

export type ManifestValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

/** Every field a cross-run comparison needs is present and self-consistent. */
export function validateManifest(manifest: RunManifest): ManifestValidation {
  const reasons: string[] = [];
  if (manifest.runId.length === 0) reasons.push("runId is empty");
  if (manifest.timeZone !== RUN_ID_TIME_ZONE) reasons.push(`time zone must be ${RUN_ID_TIME_ZONE}`);
  if (Number.isNaN(Date.parse(manifest.startedAtUtc))) reasons.push("startedAtUtc is not a timestamp");
  if (displayStamp(new Date(manifest.startedAtUtc)) !== manifest.startedAtLocal) {
    reasons.push("startedAtLocal is not the same instant as startedAtUtc");
  }
  if (manifest.snapshotIdentity.length === 0) reasons.push("snapshot identity is missing");
  if (manifest.language.length === 0) reasons.push("language is missing");
  if (manifest.modelTier.length === 0) {
    reasons.push("model tier is missing — a cross-run difference would be unattributable");
  }
  if (manifest.targets.length === 0) reasons.push("no targets recorded");
  for (const target of manifest.targets) {
    if (target.specId.length === 0) reasons.push("a target records no spec");
    if (target.specVersion.length === 0) reasons.push(`${target.specId}: no spec version`);
    if (target.scope !== "project" && target.module === null) {
      reasons.push(`${target.specId}: scoped target records no module`);
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
