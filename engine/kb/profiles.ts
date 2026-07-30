/**
 * What each repository is, and how much of it this run actually read.
 *
 * The first questions a reader has about an analysis are "what was analyzed"
 * and "how completely" — and both were answerable only from prose until now.
 * These are computed from stored facts and nothing else: every number here can
 * be traced back to rows, which is what separates a coverage figure from a
 * reassurance.
 *
 * Pure functions over facts the knowledge base hands in, so they can be tested
 * without a database and so `query.ts` stays a place where questions are asked
 * rather than answered.
 */

import type { PackageDependencyRecord } from "../structural/dependencies.js";
import type { ImportRecord, SourceFileRecord } from "../structural/code.js";
import type { RouteRecord } from "../structural/boundaries.js";
import type { FeatureFlowFact, RootSummaryFact } from "./facts.js";

/**
 * An endpoint's key, in the one spelling flows and traces both use.
 *
 * Built by hand here once, and it matched — but two spellings of one identity
 * is how a join silently returns nothing, so it is written down once.
 */
function entryKeyOf(route: { rootName: string; method: string | null; path: string }): string {
  return `${route.rootName}:${route.method ?? "ANY"} ${route.path}`;
}

export interface LanguageCount {
  readonly name: string;
  readonly files: number;
}

export interface StackEntry {
  readonly name: string;
  /** The exact version where one was established, otherwise the declared range. */
  readonly version: string | null;
  /** True when `version` is what is installed rather than what is acceptable. */
  readonly resolved: boolean;
  /** How many files import it — the evidence that it is part of the stack. */
  readonly importedBy: number;
}

/**
 * What a repository holds, and what was got out of it.
 *
 * `roles` are tokens, not sentences: the render layer words them, so a report
 * in another language does not need this file translated.
 */
export interface RepositoryProfile {
  readonly rootName: string;
  readonly languages: readonly LanguageCount[];
  readonly roles: readonly string[];
  readonly analyzedFiles: number;
  readonly excludedFiles: number;
  /** Files whose behaviour a report describes: source and tests. */
  readonly codeFiles: number;
  readonly filesWithFacts: number;
  /**
   * Schema-migration scripts, counted apart from code.
   *
   * They declare a schema rather than behaviour, and one repository here has
   * 290 of them against 121 source files — folded together, its coverage read
   * as 63% when 81% of its actual code had been read. A denominator that
   * misleads is worse than two numbers.
   */
  readonly migrationFiles: number;
  readonly migrationsWithFacts: number;
  readonly endpointCount: number;
  /**
   * Endpoints whose walk through this repository's own code completed.
   *
   * From the traces, not from the capability flows. A flow's first step is the
   * *caller*, so an endpoint nothing in the workspace calls counted as untraced
   * however completely its handler was followed — and an endpoint belonging to
   * no capability has no flow at all, so it counted as untraced too. Together
   * those reported wcp-service as 21 of 90 where 82 of its 90 handler walks
   * completed, which reads as a failure of the analysis rather than as what it
   * is: an endpoint with no observed caller.
   */
  readonly tracedEndpointCount: number;
  /**
   * Endpoints whose capability flow found nothing in the workspace calling
   * them — the fact the traced count used to swallow.
   *
   * Counted only where a flow exists to say so: an endpoint belonging to no
   * capability has no flow, and nothing here claims to know whether it has a
   * caller.
   */
  readonly endpointsWithoutCaller: number;
  readonly screenCount: number;
  readonly entityCount: number;
  readonly testCount: number;
  /** The runtime the manifests declare — Node, Go, Python. */
  readonly platforms: readonly StackEntry[];
  readonly stack: readonly StackEntry[];
  readonly directDependencies: number;
  readonly dependenciesWithExactVersion: number;
}

/** Per-root file counts, which only the file table can answer. */
export interface FileFacts {
  readonly rootName: string;
  readonly codeFiles: number;
  readonly filesWithFacts: number;
  readonly migrationFiles: number;
  readonly migrationsWithFacts: number;
}

/**
 * A file this analysis read and drew nothing behavioural from.
 *
 * Named rather than counted, because the point is that a reader can open it. A
 * capability report once said nothing whatever about a file holding an entire
 * leave policy, and a reader reasonably concluded there was nothing in it —
 * omission does not announce itself.
 *
 * "Nothing behavioural" is not "nothing at all": these files usually yielded
 * symbols and imports. What they did not yield is any of the kinds that depend
 * on the project actually doing something — a route, a table access, a guard, a
 * decision, a validation rule, a scheduled task, an entity.
 */
export interface SilentFile {
  readonly rootName: string;
  readonly relPath: string;
  /** Largest first, since a large unread file is a larger silence. */
  readonly sizeBytes: number;
}

export interface ProfileInput {
  readonly roots: readonly RootSummaryFact[];
  readonly fileFacts: readonly FileFacts[];
  readonly sourceFiles: readonly SourceFileRecord[];
  readonly endpoints: readonly RouteRecord[];
  readonly screens: readonly RouteRecord[];
  readonly entities: readonly { readonly rootName: string }[];
  readonly tests: readonly { readonly rootName: string; readonly testCount: number }[];
  readonly dependencies: readonly PackageDependencyRecord[];
  readonly imports: readonly ImportRecord[];
  readonly flows: readonly FeatureFlowFact[];
  /** One per entry point whose walk through the code completed. */
  readonly completedTraces: readonly { readonly entryKey: string; readonly partial: boolean }[];
  readonly scheduledRoots: readonly string[];
  readonly notifyingRoots: readonly string[];
  readonly dataAccessRoots: readonly string[];
}

/** How many entries of the stack to name. The rest are counted, not listed. */
export const STACK_LIMIT = 12;

const STACK_SCOPES: ReadonlySet<string> = new Set(["runtime", "development", "peer"]);

/**
 * The tie-break when import evidence is absent or equal.
 *
 * What the product needs to run comes before what its authors need to build
 * it. Without this, a repository whose imports no reader could extract ranks
 * its stack alphabetically, and a list opening with three eslint plugins
 * describes the toolchain rather than the product.
 */
function scopeRank(scope: string): number {
  if (scope === "runtime") return 0;
  if (scope === "peer") return 1;
  return 2;
}

function countBy<T>(items: readonly T[], key: (item: T) => string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/**
 * How many files import each package, per repository.
 *
 * Per repository rather than across the workspace: five services declaring
 * gorm would otherwise each be shown the workspace's whole gorm count, and a
 * package one of them never imports would rank at the top of its stack on the
 * strength of another's use of it.
 *
 * A Go import is a module path with a package below it —
 * `github.com/gin-gonic/gin/binding` is the gin dependency — so a specifier
 * counts for the longest declared name it starts a path with.
 */
function importsByPackage(
  imports: readonly ImportRecord[],
  names: readonly string[],
): Map<string, Map<string, number>> {
  const byLength = [...names].sort((a, b) => b.length - a.length);
  const byRoot = new Map<string, Map<string, number>>();

  for (const record of imports) {
    // A specifier resolving inside this workspace is our own code, not a package.
    if (record.resolvedPath !== null) continue;
    const match = byLength.find(
      (name) => record.specifier === name || record.specifier.startsWith(`${name}/`),
    );
    if (match === undefined) continue;
    const counts = byRoot.get(record.rootName) ?? new Map<string, number>();
    counts.set(match, (counts.get(match) ?? 0) + 1);
    byRoot.set(record.rootName, counts);
  }

  return byRoot;
}

function stackEntry(
  dependency: PackageDependencyRecord,
  importedBy: number,
): StackEntry {
  return {
    name: dependency.name,
    version: dependency.resolvedVersion ?? dependency.versionConstraint,
    resolved: dependency.resolvedVersion !== null,
    importedBy,
  };
}

/**
 * The stack of one repository: its runtime, then the packages its own code
 * leans on most.
 *
 * Ranked by how many files import each one, because that is evidence rather
 * than opinion — a curated list of "real" frameworks would be a dictionary
 * this tool has no business keeping, and would be wrong for the next language
 * it meets.
 *
 * A package named after a language the repository is written in is kept
 * regardless of rank: TypeScript is the stack of a TypeScript project and is
 * imported by nothing.
 */
function stackFor(
  dependencies: readonly PackageDependencyRecord[],
  importCounts: ReadonlyMap<string, number>,
  languages: readonly LanguageCount[],
): readonly StackEntry[] {
  const languageNames = new Set(languages.map((language) => language.name.toLowerCase()));
  const eligible = dependencies.filter(
    (dependency) => dependency.directness === "direct" && STACK_SCOPES.has(dependency.scope),
  );

  const named = eligible.filter((dependency) => languageNames.has(dependency.name.toLowerCase()));
  const rest = eligible
    .filter((dependency) => !languageNames.has(dependency.name.toLowerCase()))
    .sort((a, b) => {
      const byImports = (importCounts.get(b.name) ?? 0) - (importCounts.get(a.name) ?? 0);
      if (byImports !== 0) return byImports;
      const byScope = scopeRank(a.scope) - scopeRank(b.scope);
      return byScope !== 0 ? byScope : a.name.localeCompare(b.name);
    });

  return [...named, ...rest]
    .slice(0, STACK_LIMIT)
    .map((dependency) => stackEntry(dependency, importCounts.get(dependency.name) ?? 0));
}

/** One profile per analyzed repository, in the order the run recorded them. */
export function repositoryProfiles(input: ProfileInput): readonly RepositoryProfile[] {
  const importsByRoot = importsByPackage(
    input.imports,
    [...new Set(input.dependencies.map((dependency) => dependency.name))],
  );
  const tracedEntryKeys = new Set(
    input.completedTraces.filter((trace) => !trace.partial).map((trace) => trace.entryKey),
  );
  const withoutCaller = new Set(
    input.flows
      .filter((flow) =>
        flow.steps.some(
          (step) => step.kind === "frontend-call" && step.unresolvedReason !== null,
        ),
      )
      .map((flow) => flow.entryKey),
  );
  const scheduled = new Set(input.scheduledRoots);
  const notifying = new Set(input.notifyingRoots);
  const storing = new Set(input.dataAccessRoots);

  return input.roots.map((root) => {
    const importCounts = importsByRoot.get(root.name) ?? new Map<string, number>();
    const files = input.sourceFiles.filter((file) => file.rootName === root.name);
    const languages = [...countBy(files, (file) => file.language)]
      .map(([name, count]) => ({ name, files: count }))
      .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));

    const dependencies = input.dependencies.filter(
      (dependency) => dependency.rootName === root.name,
    );
    const packages = dependencies.filter((dependency) => dependency.scope !== "platform");
    const direct = packages.filter((dependency) => dependency.directness === "direct");
    const endpoints = input.endpoints.filter((route) => route.rootName === root.name);
    const facts = input.fileFacts.find((entry) => entry.rootName === root.name);

    const roles: string[] = [];
    if (endpoints.length > 0) roles.push("serves-http");
    if (input.screens.some((screen) => screen.rootName === root.name)) roles.push("shows-screens");
    if (storing.has(root.name)) roles.push("stores-data");
    if (scheduled.has(root.name)) roles.push("runs-scheduled");
    if (notifying.has(root.name)) roles.push("sends-notifications");

    return {
      rootName: root.name,
      languages,
      roles,
      analyzedFiles: root.analyzed,
      excludedFiles: root.excluded,
      codeFiles: facts?.codeFiles ?? 0,
      filesWithFacts: facts?.filesWithFacts ?? 0,
      migrationFiles: facts?.migrationFiles ?? 0,
      migrationsWithFacts: facts?.migrationsWithFacts ?? 0,
      endpointCount: endpoints.length,
      tracedEndpointCount: endpoints.filter((route) =>
        tracedEntryKeys.has(entryKeyOf(route)),
      ).length,
      endpointsWithoutCaller: endpoints.filter((route) =>
        withoutCaller.has(entryKeyOf(route)),
      ).length,
      screenCount: input.screens.filter((screen) => screen.rootName === root.name).length,
      entityCount: input.entities.filter((entity) => entity.rootName === root.name).length,
      testCount: input.tests.find((entry) => entry.rootName === root.name)?.testCount ?? 0,
      platforms: dependencies
        .filter((dependency) => dependency.scope === "platform")
        .map((dependency) => stackEntry(dependency, 0)),
      stack: stackFor(packages, importCounts, languages),
      directDependencies: direct.length,
      dependenciesWithExactVersion: direct.filter(
        (dependency) => dependency.resolvedVersion !== null,
      ).length,
    };
  });
}

export interface FlowCoverage {
  readonly entryKey: string;
  readonly method: string | null;
  readonly path: string;
  readonly steps: number;
  readonly resolvedSteps: number;
  /** Why the trace stopped, once per distinct reason. */
  readonly unresolvedReasons: readonly string[];
}

export interface FeatureFlowCoverage {
  readonly featureId: string;
  readonly featureName: string;
  readonly flowCount: number;
  readonly fullyTracedFlows: number;
  readonly steps: number;
  readonly resolvedSteps: number;
  readonly flows: readonly FlowCoverage[];
}

/**
 * How much of each business flow was followed.
 *
 * A flow already records every hop it could not establish, with the reason, so
 * this counts what is there rather than judging it. A truncated step is not an
 * unresolved one — the tool knew what was there and showed less of it — and
 * counting the two together would report a complete trace as partial.
 */
export function flowCoverage(flows: readonly FeatureFlowFact[]): readonly FeatureFlowCoverage[] {
  const byFeature = new Map<string, FeatureFlowFact[]>();
  for (const flow of flows) {
    const existing = byFeature.get(flow.featureId) ?? [];
    existing.push(flow);
    byFeature.set(flow.featureId, existing);
  }

  return [...byFeature.values()]
    .map((featureFlows) => {
      const covered = featureFlows.map((flow) => {
        // A truncated step carries a reason too — "only the first 12 tables are
        // shown" — and it is not a stop: the tool knew what was there and
        // showed less of it. Counted as unresolved, a complete trace that
        // displayed fewer tables read as 94% followed, and the reason column
        // told a reader the trace stopped where it had not.
        const unresolved = flow.steps.filter(
          (step) => step.unresolvedReason !== null && step.truncated !== true,
        );
        return {
          entryKey: flow.entryKey,
          method: flow.method,
          path: flow.path,
          steps: flow.steps.length,
          resolvedSteps: flow.steps.length - unresolved.length,
          unresolvedReasons: [
            ...new Set(unresolved.map((step) => step.unresolvedReason!)),
          ],
        };
      });

      return {
        featureId: featureFlows[0]!.featureId,
        featureName: featureFlows[0]!.featureName,
        flowCount: covered.length,
        fullyTracedFlows: covered.filter((flow) => flow.resolvedSteps === flow.steps).length,
        steps: covered.reduce((total, flow) => total + flow.steps, 0),
        resolvedSteps: covered.reduce((total, flow) => total + flow.resolvedSteps, 0),
        // A flow with no steps would make a ratio NaN, and NaN in a comparator
        // is not an ordering — it silently leaves the list however it arrived.
        flows: covered.sort((a, b) => {
          const share = (flow: FlowCoverage): number =>
            flow.steps === 0 ? 1 : flow.resolvedSteps / flow.steps;
          return share(a) - share(b) || a.path.localeCompare(b.path);
        }),
      };
    })
    .sort((a, b) => b.flowCount - a.flowCount || a.featureName.localeCompare(b.featureName));
}
