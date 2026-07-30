/**
 * What the analysis concludes, over the whole workspace at once.
 *
 * Extraction reads one root at a time; nothing there can see that a call in
 * the browser app reaches a route in one service whose handler writes a table
 * a second service also writes. Every conclusion worth having crosses that
 * boundary, which is why this stage exists and why it runs after all of them.
 *
 * It produces records, never wording. A feature comes out with its endpoints,
 * flows, rules and findings attached; what a document says about that is a
 * template's business.
 */

import { isRealIntegration } from "./hosts.js";
import { inferBaseBindings, linkCallsScoped } from "../linking/binding.js";
import { resolveHandlers } from "../linking/handlers.js";
import { linkCalls, rootDependencies } from "../linking/link.js";
import { buildTraces } from "../modules/trace.js";
import { formModel, formModulesFromRoutes, qualifiedFile } from "../modules/form.js";
import { detectFeatures } from "../modules/features.js";
import { assembleFlows } from "../flows/assemble.js";
import { mapToMermaid } from "../flows/mermaid.js";
import { computeSignals } from "../health/signals.js";
import { computeStructuralFindings } from "../health/structure.js";
import { stateRule, type BusinessRule } from "../semantics/rules.js";
import type { StructuralProvider } from "../structural/provider.js";
import type { RouteRecord } from "../structural/boundaries.js";
import { codeIndexArtifact } from "./build.js";
import { coverageNotes, dataCoverageNotes } from "./coverage.js";
import { buildFeatureFacts } from "./features.js";
import { derivedKey, emptyDerived, type DerivedLink, type DerivedRecords } from "./kinds.js";
import { gatherRecords, type GatheredRecords } from "./gather.js";
import type { RootFacts } from "./extract.js";
import type { CoverageNote, MapEdge, ModuleFact, RunContext } from "./facts.js";

export interface DeriveInput {
  readonly roots: readonly RootFacts[];
  readonly providers: readonly StructuralProvider[];
  readonly runId: string;
  readonly generatedAt: string;
  readonly workspacePath: string;
  /** Where this run would build a code index, when it means to build one. */
  readonly codeIndexPath?: string | null | undefined;
  /**
   * Whether one is actually there, checked after extraction.
   *
   * Presence, not authorship — the distinction that produced a false note twice
   * on the way here. Absent leaves the note reading as a presence, so a caller
   * that does not check is not made to announce a missing index on no evidence.
   */
  readonly codeIndexPresent?: boolean | undefined;
}

export interface Derived {
  readonly records: DerivedRecords;
  readonly links: readonly DerivedLink[];
  /** The gathered structural records, so a caller need not walk models twice. */
  readonly gathered: GatheredRecords;
}

/**
 * The project map: our roots first, then what they reach outside.
 *
 * A reader needs the boundary of the system before anything inside it makes
 * sense, so an internal call and a call to Stripe are different kinds of edge
 * rather than two lines that happen to look alike.
 */
function projectMap(
  gathered: GatheredRecords,
  links: ReturnType<typeof linkCalls>,
  entitiesByRoot: ReadonlyMap<string, ReadonlySet<string>>,
): MapEdge[] {
  const map: MapEdge[] = rootDependencies(links).map((dependency) => ({
    from: dependency.from,
    to: dependency.to,
    kind: "internal" as const,
    detail: `${dependency.calls} calls`,
  }));

  const externalHosts = new Map<string, Set<string>>();
  for (const call of gathered.calls) {
    if (call.target === null) continue;
    const host = /^[a-zA-Z][\w+.-]*:\/\/([^/]+)/.exec(call.target)?.[1];
    if (host === undefined) continue;
    if (links.links.some((link) => link.target === call.target)) continue;
    const forRoot = externalHosts.get(call.rootName) ?? new Set<string>();
    forRoot.add(host);
    externalHosts.set(call.rootName, forRoot);
  }
  for (const [rootName, hosts] of externalHosts) {
    // A localhost port or an unfilled `xxxx.xxx.com` template is not a system
    // the platform talks to; drawing it in the topology reads as a real
    // dependency. The external-systems section states how many were dropped.
    for (const host of [...hosts].sort()) {
      if (!isRealIntegration(host)) continue;
      map.push({ from: rootName, to: host, kind: "external", detail: null });
    }
  }

  for (const [rootName, entities] of entitiesByRoot) {
    map.push({
      from: rootName,
      to: "datastore",
      kind: "datastore",
      detail: `${entities.size} entities`,
    });
  }

  return map;
}

export function derive(input: DeriveInput): Derived {
  const notes: CoverageNote[] = [
    ...coverageNotes({
      providers: input.providers,
      models: input.roots.map((root) => root.model),
      rootCount: input.roots.length,
    }),
  ];

  // The one thing this tool writes near the source it reads. Recorded here so
  // it reaches a reader, rather than living only in the terminal output of
  // whoever happened to run it.
  if (input.codeIndexPath !== undefined && input.codeIndexPath !== null) {
    // Whether an index is there, not whether one was planned. The path is
    // decided before the run starts and the indexer can still be missing, crash
    // or time out — reporting the plan as a write states something untrue about
    // the disk, in the one note whose whole job is to be true about it.
    notes.push({
      subject: "code-index",
      note:
        input.codeIndexPresent === false
          ? `no code index is present at ${codeIndexArtifact(input.codeIndexPath)}, which is where this run would have built one — so the symbols an index supplies are missing from this analysis. Any failure the indexer reported is in the extraction failures for this run`
          : `a code index is present at ${codeIndexArtifact(input.codeIndexPath)}, the directory holding the analyzed roots — the only thing this analysis writes anywhere near the project. Its location is not configurable: the indexer stores its database inside whatever it indexes, so an index of this code can only live in a directory containing it. --no-code-index skips it entirely`,
    });
  } else if (input.codeIndexPath === null) {
    // Refusing the write is supported, and on a project whose frameworks the
    // in-process readers do not cover it costs most of the analysis. Measured
    // on angels-pizza: 486 of 594 entry points came from the index, and
    // without them no capability forms at all.
    notes.push({
      subject: "code-index",
      note: "no code index was built for this run, so entry points and symbols came only from the in-process readers; on a project whose frameworks those readers do not cover, that is the difference between a described system and an empty one",
    });
  }

  const gathered = gatherRecords(input.roots);

  // Routes gain their handler symbols here: the framework reader knows the
  // handler's name, the structural provider owns symbol identity, and only
  // after every root is assembled do both sides exist.
  const handlers = resolveHandlers(gathered.routes, gathered.symbols);
  const routes: RouteRecord[] = [...handlers.routes];
  if (handlers.unresolved.length > 0) {
    // Counted against the routes that named a handler at all. Routes
    // registered with an inline function were never candidates, and including
    // them would report a failure rate for work never attempted.
    const named = routes.filter((route) => route.handlerCandidates.length > 0).length;
    notes.push({
      subject: "route-handlers",
      note: `${handlers.unresolved.length} of ${named} routes naming a handler could not be resolved to a unique symbol; their flows stop at the route`,
    });
  }

  // Which service a configured API base names is deployment configuration, so
  // it is inferred from how well each base's paths fit — and a bound call is
  // then matched only against the service it names, which is what separates
  // one backend's /v2/worklogs from another's.
  const bindings = inferBaseBindings(gathered.calls, routes);
  const links = linkCallsScoped(gathered.calls, routes, bindings, linkCalls);
  for (const binding of bindings) {
    if (binding.boundRoot !== null) continue;
    notes.push({
      subject: "api-base-binding",
      note: `${binding.reason}, so its calls were matched against every service`,
    });
  }

  const traced = buildTraces({
    routes,
    symbols: gathered.symbols,
    callEdges: gathered.callEdges,
  });
  const formation = formModel(
    traced.traces,
    {
      containment: gathered.containment,
      dependencies: gathered.dependencies,
      symbols: gathered.symbols,
    },
    input.roots.flatMap((root) =>
      root.analyzedFiles.map((relPath) => qualifiedFile(root.rootName, relPath)),
    ),
  );

  // Falling back to entry points keeps the knowledge base useful rather than
  // faithfully empty when no trace could be walked — and a coverage note
  // already says the call graph was not followed, so nothing is overstated.
  const grouped =
    formation.modules.length > 0
      ? { modules: formation.modules, withoutResource: formation.withoutResource }
      : formModulesFromRoutes(routes);
  const modules = grouped.modules;

  if (grouped.withoutResource.length > 0) {
    notes.push({
      subject: "modules",
      note: `${grouped.withoutResource.length} of ${routes.length} entry points are addressed only through a version or entry-point prefix — every segment of their path says how to reach the service rather than what it holds — so they belong to no module`,
    });
  }

  const detection = detectFeatures({
    entityNames: [...gathered.entityNames],
    routes,
    files: input.roots.flatMap((root) =>
      root.analyzedFiles.map((relPath) => ({ rootName: root.rootName, relPath })),
    ),
  });
  const flowSet = assembleFlows({
    features: detection.features,
    routes,
    symbols: gathered.symbols,
    links: links.links,
    calls: gathered.calls,
    dataAccess: gathered.dataAccess,
    validations: gathered.validations,
    handlerGaps: new Map(handlers.unresolved.map((gap) => [gap.entryKey, gap.reason])),
  });

  // Conditions become rules once the project's own names explain their values;
  // one stated in bare numbers is left as written and marked as unexplained.
  const valueSets = input.roots.flatMap((root) => root.valueSets);
  const rules: BusinessRule[] = gathered.conditions.map((condition) =>
    stateRule(condition, valueSets),
  );

  const featureFacts = buildFeatureFacts(detection.features, flowSet.flows, {
    rules,
    discarded: gathered.discarded,
    filesByFeature: new Map(
      detection.features.map((feature) => [feature.id, new Set(feature.filePaths)]),
    ),
  });

  // How a capability's files were chosen, because it bounds every file-scoped
  // question asked of it later — its rules, its states, its screens. Verified
  // on WCP: `third_party/itms/client.go` is an HTTP client, and it is
  // attributed to the Client capability, which is about customers.
  notes.push({
    subject: "features",
    note: "a file belongs to a capability when its own name, or a folder above it, names that capability; a file named for an unrelated sense of the same word is attributed too, so a capability's rules may include one that is not about it",
  });

  if (detection.setAside.length > 0) {
    notes.push({
      subject: "features",
      note: `${detection.setAside.length} further terms named something in two places but too little of it to head a feature: ${detection.setAside
        .slice(0, 12)
        .map((term) => term.term)
        .join(", ")}`,
    });
  }
  if (flowSet.skipped.length > 0) {
    notes.push({
      subject: "features",
      // Not "listed only under their service": which sections exist is the
      // template's business, and the recovered specification has no such listing —
      // so the note sent a reader looking for something that was not there.
      note: `${flowSet.skipped.length} of ${routes.length} endpoints name no detected feature, so no capability claims them`,
    });
  }

  notes.push(
    ...dataCoverageNotes({
      describedEntities: gathered.entityNames,
      touchedTables: gathered.touchedTables,
    }),
  );
  notes.push({
    subject: "conditions",
    note: `${gathered.transactions.length} transaction boundaries, ${gathered.errorHandling.length} error-handling sites and ${gathered.authAnnotations.length} authorization annotations were read from convention patterns; they are inferred from text, so a match inside a comment or a string is possible`,
  });
  if (gathered.screens.length > 0) {
    notes.push({
      subject: "screens",
      note: `${gathered.screens.length} client-side routes were read as the application's screens and are listed separately from the API`,
    });
  }

  const map = projectMap(gathered, links, gathered.entitiesByRoot);

  const moduleFacts: ModuleFact[] = modules.map((module) => {
    const entryKeys = new Set(module.entryKeys);
    return {
      id: module.id,
      name: module.name,
      rootNames: module.rootNames,
      entryKeys: module.entryKeys,
      endpoints: routes
        .filter((route) => entryKeys.has(`${route.rootName}:${route.method ?? "ANY"} ${route.path}`))
        .map((route) => ({ method: route.method, path: route.path, rootName: route.rootName })),
      symbolCount: module.symbolIds.length,
      dataEntities: [
        ...new Set(
          module.rootNames.flatMap((root) => [...(gathered.entitiesByRoot.get(root) ?? [])]),
        ),
      ].sort(),
      outboundTargets: [
        ...new Set(
          gathered.calls
            .filter((call) => module.rootNames.includes(call.rootName) && call.target !== null)
            .map((call) => call.target!),
        ),
      ].sort(),
      groupingSignal: module.groupingSignal,
      evidence: module.rootNames.flatMap((root) =>
        (gathered.descriptionsByRoot.get(root) ?? []).slice(0, 3),
      ),
    };
  });

  const context: RunContext = {
    runId: input.runId,
    generatedAt: input.generatedAt,
    workspacePath: input.workspacePath,
    projectName:
      input.roots.length === 1
        ? input.roots[0]!.rootName
        : (input.workspacePath.split("/").pop() ?? "project"),
    description: gathered.projectDescription,
    roots: input.roots.map((root) => root.summary),
    mapDiagram: mapToMermaid(map),
    dispositions: formation.counts,
    unassignedEndpointCount: flowSet.skipped.length,
  };

  const records: DerivedRecords = {
    ...emptyDerived(),
    "run-context": [context],
    feature: featureFacts.features,
    "feature-flow": featureFacts.flows,
    "feature-finding": featureFacts.findings,
    "business-rule": rules,
    "value-set": valueSets,
    module: moduleFacts,
    component: formation.components,
    trace: traced.traces,
    "cross-root-link": links.links,
    "unlinked-call": links.unlinked,
    "base-binding": bindings,
    "map-edge": map,
    "structural-finding": computeStructuralFindings({
      dataAccess: gathered.dataAccess,
      routes,
      entityColumns: gathered.entityColumns,
      rootNames: input.roots.map((root) => root.rootName),
    }),
    "health-signal": computeSignals({
      links,
      traces: traced.traces,
      untracedEntryPoints: traced.untraced.length,
      handlerLinkingAvailable: routes.some((route) => route.handlerSymbolId !== null),
      modules,
      components: formation.components,
      dispositions: formation.counts,
      dependencies: gathered.dependencies,
      rootNames: input.roots.map((root) => root.rootName),
    }),
    "coverage-note": notes,
  };

  return {
    records,
    links: featureLinks(featureFacts, moduleFacts),
    gathered: { ...gathered, routes },
  };
}

/**
 * Ownership, written down rather than recomputed by whoever asks.
 *
 * A feature's endpoints are routes, which extraction produced — so a link
 * names the structural record rather than copying it into the derived table.
 */
function featureLinks(
  features: ReturnType<typeof buildFeatureFacts>,
  modules: readonly ModuleFact[],
): DerivedLink[] {
  const links: DerivedLink[] = [];

  for (const feature of features.features) {
    for (const flow of features.flows) {
      if (flow.featureId !== feature.id) continue;
      links.push({
        fromKind: "feature",
        fromKey: feature.id,
        role: "flow",
        toKind: "feature-flow",
        // Built through the same key function the record was stored under.
        // Two spellings of one identity is how a join silently returns
        // nothing while every row it needed is present.
        toKey: derivedKey("feature-flow", flow),
      });
    }
    for (const rule of features.rulesByFeature.get(feature.id) ?? []) {
      links.push({
        fromKind: "feature",
        fromKey: feature.id,
        role: "rule",
        toKind: "business-rule",
        toKey: derivedKey("business-rule", rule),
      });
    }
  }

  // A module and a feature are different groupings over the same code, and one
  // endpoint can belong to both — which is why this is a link table and not a
  // column on either side.
  const featureByEntry = new Map<string, string>();
  for (const feature of features.features) {
    for (const endpoint of feature.endpoints) {
      featureByEntry.set(
        `${endpoint.rootName}:${endpoint.method ?? "ANY"} ${endpoint.path}`,
        feature.id,
      );
    }
  }
  for (const module of modules) {
    const seen = new Set<string>();
    for (const entryKey of module.entryKeys) {
      const featureId = featureByEntry.get(entryKey);
      if (featureId === undefined || seen.has(featureId)) continue;
      seen.add(featureId);
      links.push({
        fromKind: "module",
        fromKey: module.id,
        role: "feature",
        toKind: "feature",
        toKey: featureId,
      });
    }
  }

  return links;
}
