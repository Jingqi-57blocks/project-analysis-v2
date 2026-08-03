/**
 * What a report request asks for: a set of `Scope × Audience` targets.
 *
 * V1 does not fix "the standard pipeline" to mean "always the project-level
 * product and developer reports". A caller chooses, per project or per named
 * module and per audience, any non-empty set of targets, and one analysis
 * serves them all. This module fixes that vocabulary and its legality; it does
 * not plan or render anything.
 */

export type Audience = "product" | "developer";

export const AUDIENCES: readonly Audience[] = ["product", "developer"];

/** Project-wide, or one canonical module. Never a path or a guess. */
export type Scope =
  | { readonly kind: "project" }
  | { readonly kind: "module"; readonly moduleId: string };

export interface ReportTarget {
  readonly scope: Scope;
  readonly audience: Audience;
}

/** A non-empty set of distinct targets, compiled together from one analysis. */
export type ReportRequest = readonly ReportTarget[];

export const PROJECT_SCOPE: Scope = { kind: "project" };

export function moduleScope(moduleId: string): Scope {
  return { kind: "module", moduleId };
}

export function projectTarget(audience: Audience): ReportTarget {
  return { scope: PROJECT_SCOPE, audience };
}

export function moduleTarget(moduleId: string, audience: Audience): ReportTarget {
  return { scope: moduleScope(moduleId), audience };
}

/** Canonical identity of a target — for de-duplication and duplicate detection. */
export function targetKey(target: ReportTarget): string {
  const scope = target.scope.kind === "project" ? "project" : `module:${target.scope.moduleId}`;
  return `${scope}|${target.audience}`;
}

export function isProjectTarget(target: ReportTarget): boolean {
  return target.scope.kind === "project";
}

/**
 * Module-only: every requested target is module-scoped, so no project-level
 * document is produced. This concerns documents only — it does not narrow the
 * workspace analysis, which still runs whole so cross-module facts survive (see
 * the dual-report content contract).
 */
export function isModuleOnly(request: ReportRequest): boolean {
  return request.length > 0 && request.every((target) => target.scope.kind === "module");
}

/** The project-level targets in a request — length 0 for a module-only request. */
export function projectLevelTargets(request: ReportRequest): readonly ReportTarget[] {
  return request.filter(isProjectTarget);
}

export type RequestValidation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function validateRequest(request: ReportRequest): RequestValidation {
  if (request.length === 0) return { ok: false, reason: "a ReportRequest must have at least one target" };
  const seen = new Set<string>();
  for (const target of request) {
    if (target.scope.kind === "module" && target.scope.moduleId.length === 0) {
      return { ok: false, reason: "a module target must name a module" };
    }
    const key = targetKey(target);
    if (seen.has(key)) return { ok: false, reason: `duplicate target: ${key}` };
    seen.add(key);
  }
  return { ok: true };
}

export class UnresolvedModuleError extends Error {
  constructor(readonly moduleId: string) {
    super(`module identity could not be resolved: ${moduleId}`);
    this.name = "UnresolvedModuleError";
  }
}

/**
 * Resolves a requested module id against the known canonical module ids. Fails
 * closed when the id is unknown — never widening to the whole project and never
 * guessing from a path, either of which would silently answer a different
 * question than the caller asked.
 */
export function resolveModuleScope(moduleId: string, knownModuleIds: ReadonlySet<string>): Scope {
  if (!knownModuleIds.has(moduleId)) throw new UnresolvedModuleError(moduleId);
  return moduleScope(moduleId);
}

/**
 * The combinations V1 must accept, as machine-checkable examples. Any non-empty
 * set of distinct targets is legal; these are the ones the contract names.
 */
export const LEGAL_COMBINATION_EXAMPLES: readonly { readonly name: string; readonly request: ReportRequest }[] = [
  { name: "project/product", request: [projectTarget("product")] },
  { name: "project/developer", request: [projectTarget("developer")] },
  { name: "project/both", request: [projectTarget("product"), projectTarget("developer")] },
  { name: "module/product", request: [moduleTarget("leave", "product")] },
  { name: "module/developer", request: [moduleTarget("leave", "developer")] },
  { name: "module/both", request: [moduleTarget("leave", "product"), moduleTarget("leave", "developer")] },
  {
    name: "project product + module developer",
    request: [projectTarget("product"), moduleTarget("leave", "developer")],
  },
  {
    name: "two modules × both",
    request: [
      moduleTarget("leave", "product"),
      moduleTarget("leave", "developer"),
      moduleTarget("payroll", "product"),
      moduleTarget("payroll", "developer"),
    ],
  },
];

export const ILLEGAL_REQUEST_EXAMPLES: readonly { readonly why: string; readonly request: ReportRequest }[] = [
  { why: "empty request", request: [] },
  { why: "duplicate target", request: [projectTarget("product"), projectTarget("product")] },
  { why: "module target with no module id", request: [moduleTarget("", "product")] },
];
