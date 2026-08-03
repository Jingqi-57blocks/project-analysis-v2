/**
 * The report command's request layer and orchestration plan.
 *
 * One request may name several targets — a project overview plus four module
 * details — and they share one analysis, one fact-pack cut per scope, and one
 * claim set. This module turns command-line arguments into a plan and decides
 * what stops the run; running the plan (calling the skill, auditing, rendering)
 * is the caller's job.
 *
 * `scope` and `audience` are read from the spec registry, never enumerated here.
 * Adding a report type is adding a spec file.
 */

import { authorableChapters } from "../contracts/report/chapters.js";
import { availableCombinations, specFor, type ReportSpec, type SpecRegistry } from "../contracts/report/specs.js";
import { resolveModuleRef, type ModuleDirectory, type ModuleIdentity } from "../contracts/module/index.js";
import { UnresolvedModuleError } from "../contracts/module/identity.js";

export interface TargetRequest {
  readonly scope: string;
  readonly audience: string;
  /** Required when scope is not "project". */
  readonly module?: string;
}

export interface ReportRequest {
  readonly targets: readonly TargetRequest[];
  readonly language: string;
  readonly format: string;
  /** Chapters to author again, by the number the spec gives them. */
  readonly rewriteChapters?: readonly string[];
}

export type RequestFailureCode =
  | "no-targets"
  | "spec-not-found"
  | "module-missing"
  | "module-unresolved"
  | "duplicate-target"
  | "chapter-not-found";

export interface RequestFailure {
  readonly code: RequestFailureCode;
  readonly detail: string;
  /** What the caller could have asked for instead. */
  readonly available?: readonly string[];
}

export interface PlannedTarget {
  readonly scope: string;
  readonly audience: string;
  readonly spec: ReportSpec;
  readonly module: ModuleIdentity | null;
  /** Directory name for this target inside the run. */
  readonly directory: string;
  /** Key of the fact pack this target reads; targets sharing it are cut once. */
  readonly packKey: string;
}

export interface ReportPlan {
  readonly targets: readonly PlannedTarget[];
  readonly language: string;
  readonly format: string;
  /** Distinct packs to cut — always fewer than or equal to the target count. */
  readonly packKeys: readonly string[];
  /** Label for the run directory, describing the request as a whole. */
  readonly runLabel: string;
}

export type PlanResult =
  | { readonly ok: true; readonly plan: ReportPlan }
  | { readonly ok: false; readonly failures: readonly RequestFailure[] };

function targetKey(target: TargetRequest): string {
  return `${target.scope}/${target.audience}/${target.module ?? ""}`;
}

/**
 * The fact pack a target reads.
 *
 * Keyed on scope and module only — not audience. Two audiences over one module
 * read the same facts and differ in what they write about them, so cutting twice
 * would double the work and, worse, allow the two documents to disagree about
 * what was in scope.
 */
function packKeyFor(scope: string, module: ModuleIdentity | null): string {
  return module === null ? scope : `${scope}:${module.id}`;
}

function directoryFor(scope: string, audience: string, module: ModuleIdentity | null): string {
  return module === null ? `${scope}-${audience}` : `${scope}-${module.structuralName}-${audience}`;
}

/**
 * Turns a request into a plan, or into the reasons it cannot be one.
 *
 * Every failure is closed: an unmatched combination lists what exists, an
 * unresolved module lists the known modules, and neither falls back to something
 * adjacent. Producing a report for a scope the caller did not ask for is worse
 * than producing none.
 */
export function planReport(
  request: ReportRequest,
  registry: SpecRegistry,
  directory: ModuleDirectory,
): PlanResult {
  const failures: RequestFailure[] = [];
  if (request.targets.length === 0) {
    return { ok: false, failures: [{ code: "no-targets", detail: "the request names no target" }] };
  }

  const seen = new Set<string>();
  const planned: PlannedTarget[] = [];
  for (const target of request.targets) {
    const key = targetKey(target);
    if (seen.has(key)) {
      failures.push({ code: "duplicate-target", detail: `target requested twice: ${key}` });
      continue;
    }
    seen.add(key);

    const spec = specFor(registry, target.scope, target.audience);
    if (spec === undefined) {
      failures.push({
        code: "spec-not-found",
        detail: `no spec serves ${target.scope}/${target.audience}`,
        available: availableCombinations(registry),
      });
      continue;
    }

    let module: ModuleIdentity | null = null;
    if (target.scope !== "project") {
      if (target.module === undefined || target.module.length === 0) {
        failures.push({ code: "module-missing", detail: `${target.scope} scope requires a module` });
        continue;
      }
      try {
        module = resolveModuleRef(directory, target.module);
      } catch (error) {
        if (!(error instanceof UnresolvedModuleError)) throw error;
        failures.push({
          code: "module-unresolved",
          detail: `module "${target.module}" did not resolve; the run stops rather than widening to the project`,
          available: error.known,
        });
        continue;
      }
    }

    // Checked here rather than mid-run: a mistyped chapter number should cost a
    // sentence, not an allocated run directory, a sliced fact pack and a manifest
    // recording a failure. Every spec is checked, since two targets may not have
    // the same chapters.
    const known = authorableChapters(spec).map((chapter) => chapter.number);
    for (const number of request.rewriteChapters ?? []) {
      if (known.includes(number)) continue;
      failures.push({
        code: "chapter-not-found",
        detail: `${spec.id} has no chapter ${number}`,
        available: known,
      });
    }

    planned.push({
      scope: target.scope,
      audience: target.audience,
      spec,
      module,
      directory: directoryFor(target.scope, target.audience, module),
      packKey: packKeyFor(target.scope, module),
    });
  }

  if (failures.length > 0) return { ok: false, failures };

  const packKeys = [...new Set(planned.map((target) => target.packKey))].sort();
  return {
    ok: true,
    plan: {
      targets: planned,
      language: request.language,
      format: request.format,
      packKeys,
      runLabel: runLabelFor(planned, request.language),
    },
  };
}

/** A label that says what the run produced, without becoming a path of its own. */
function runLabelFor(targets: readonly PlannedTarget[], language: string): string {
  const first = targets[0];
  if (first === undefined) return `run-${language}`;
  if (targets.length === 1) {
    return first.module === null
      ? `${first.scope}-${first.audience}-${language}`
      : `${first.scope}-${first.module.structuralName}-${first.audience}-${language}`;
  }
  const audiences = [...new Set(targets.map((target) => target.audience))];
  const audience = audiences.length === 1 ? audiences[0] : "mixed";
  return `${targets.length}-targets-${audience}-${language}`;
}

/** A one-screen account of why a request could not become a plan. */
export function explainFailures(failures: readonly RequestFailure[]): string {
  const lines = [`request refused; ${failures.length} problem(s):`];
  for (const failure of failures) {
    lines.push(`  - [${failure.code}] ${failure.detail}`);
    if (failure.available !== undefined && failure.available.length > 0) {
      const shown = failure.available.slice(0, 20).join(", ");
      lines.push(`      available: ${shown}${failure.available.length > 20 ? ", …" : ""}`);
    }
  }
  return lines.join("\n");
}

/** Command-line parsing. Deliberately dumb: legality is the planner's decision. */
export function parseArgs(argv: readonly string[]): ReportRequest {
  const scopes: string[] = [];
  const audiences: string[] = [];
  const modules: string[] = [];
  const rewriteChapters: string[] = [];
  let language = "zh-CN";
  let format = "markdown";
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) continue;
    if (flag === "--scope") scopes.push(value);
    else if (flag === "--audience") audiences.push(value);
    else if (flag === "--module") modules.push(value);
    else if (flag === "--rewrite-chapter") rewriteChapters.push(value);
    else if (flag === "--lang" || flag === "--language") language = value;
    else if (flag === "--format") format = value;
  }
  const targets: TargetRequest[] = [];
  for (const scope of scopes.length > 0 ? scopes : ["project"]) {
    for (const audience of audiences.length > 0 ? audiences : ["product"]) {
      if (scope === "project") targets.push({ scope, audience });
      else for (const module of modules) targets.push({ scope, audience, module });
    }
  }
  return { targets, language, format, ...(rewriteChapters.length === 0 ? {} : { rewriteChapters }) };
}
