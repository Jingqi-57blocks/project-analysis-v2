/**
 * Runs the whole pipeline for one workspace and writes a report.
 *
 * Every stage is already independently tested; this wires them in order and is
 * deliberately thin, so a failure here is a wiring bug rather than a hidden
 * behaviour nobody could test on its own.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { selectWorkspace } from "../workspace/select.js";
import { analyzedRoots } from "../workspace/types.js";
import { walkRoot } from "../inventory/walk.js";
import { newRunId } from "../run/runid.js";
import { createManifestProvider } from "../providers/manifests/provider.js";
import { createOutboundProvider } from "../providers/outbound/provider.js";
import { createConventionsProvider } from "../providers/conventions/provider.js";
import { createCodeGraphProvider } from "../providers/codegraph/provider.js";
import { createDocumentationCollector } from "../collectors/documentation.js";
import { createCodeTextCollector } from "../collectors/code.js";
import { assembleEvidence, collectAll } from "../semantic/assemble.js";
import { assemble, extractAll } from "../structural/assemble.js";
import { consolidateRoutes } from "../structural/routededupe.js";
import { createFrameworkRoutesProvider } from "../providers/frameworkroutes/provider.js";
import { createUiCallsProvider } from "../providers/uicalls/provider.js";
import { inferBaseBindings, linkCallsScoped } from "../linking/binding.js";
import { resolveHandlers } from "../linking/handlers.js";
import { linkCalls, rootDependencies } from "../linking/link.js";
import { buildTraces } from "../modules/trace.js";
import { formModel, formModulesFromRoutes, qualifiedFile } from "../modules/form.js";
import { createSqlSchemaProvider } from "../datamodel/sql.js";
import { createOrmMigrationProvider } from "../datamodel/orm.js";
import { createGoModelProvider } from "../datamodel/gostructs.js";
import { computeSignals } from "../health/signals.js";
import { createDataUsageProvider } from "../datamodel/usage.js";
import { detectFeatures } from "../modules/features.js";
import { assembleFlows } from "../flows/assemble.js";
import { buildReportFeatures, mapToMermaid } from "./features.js";
import {
  assembleReport,
  DEFAULT_LANGUAGE,
  type CoverageNote,
  type MapEdge,
  type ModuleEntryPoint,
  type OutputLanguage,
} from "./model.js";
import { buildJsonReport } from "./json.js";
import { writeRenderings } from "./render.js";
import type { DataModelRecords } from "../datamodel/types.js";
import type { StructuralProvider } from "../structural/provider.js";
import type { RouteRecord, OutboundCallRecord, DataAccessRecord } from "../structural/boundaries.js";
import type { ValidationRuleRecord } from "../structural/rules.js";
import type { SymbolRecord, CallEdgeRecord } from "../structural/code.js";
import type { ModuleContainmentRecord, PackageDependencyRecord } from "../structural/dependencies.js";

export interface GenerateOptions {
  readonly paths: readonly string[];
  readonly outputDir: string;
  readonly language?: OutputLanguage;
  /** Extra providers — the CodeGraph adapter, when its indexing cost is acceptable. */
  readonly extraProviders?: readonly StructuralProvider[];
  readonly runId?: string;
  readonly now?: string;
}

export interface GenerateResult {
  readonly runId: string;
  readonly outputDir: string;
  readonly files: readonly string[];
  readonly moduleCount: number;
  readonly featureCount: number;
  readonly componentCount: number;
}

export function generateReport(options: GenerateOptions): GenerateResult {
  const runId = options.runId ?? newRunId();
  const generatedAt = options.now ?? new Date().toISOString();
  const language = options.language ?? DEFAULT_LANGUAGE;

  const selection = selectWorkspace({ paths: options.paths });
  const roots = analyzedRoots(selection);

  // CodeGraph runs without call-edge extraction by default: that loop is one
  // subprocess per callable symbol and dominates cost, while entry points and
  // structure — what a reader's report actually needs — come from two cheap
  // queries. The omission is declared, so nothing reads it as a codebase
  // without calls.
  const structuralProviders: StructuralProvider[] = [
    createManifestProvider(),
    createOutboundProvider(),
    createConventionsProvider(),
    createFrameworkRoutesProvider(),
    createUiCallsProvider(),
    createDataUsageProvider(),
    ...(options.extraProviders ?? [createCodeGraphProvider({ callEdges: false })]),
  ];
  const collectors = [createDocumentationCollector(), createCodeTextCollector()];

  const routes: RouteRecord[] = [];
  const screens: RouteRecord[] = [];
  const calls: OutboundCallRecord[] = [];
  const symbols: SymbolRecord[] = [];
  const callEdges: CallEdgeRecord[] = [];
  const dataAccess: DataAccessRecord[] = [];
  const validations: ValidationRuleRecord[] = [];
  const containment: ModuleContainmentRecord[] = [];
  const dependencies: PackageDependencyRecord[] = [];
  const allFiles: string[] = [];
  // Kept unqualified alongside the qualified list: the qualified form is a
  // collision-proof key with its own escaping, and splitting it back apart
  // turns "wcp-ui" into "wcp-ui|src".
  const filesByRoot: { rootName: string; relPath: string }[] = [];
  const coverageNotes: CoverageNote[] = [];
  const evidenceByRoot = new Map<string, string[]>();
  const dataProviders = [
    createSqlSchemaProvider(),
    createOrmMigrationProvider(),
    createGoModelProvider(),
  ];
  const entityNames = new Set<string>();
  const dataModel: {
    entities: DataModelRecords["entities"][number][];
    fields: DataModelRecords["fields"][number][];
    relations: DataModelRecords["relations"][number][];
    constraints: DataModelRecords["constraints"][number][];
  } = { entities: [], fields: [], relations: [], constraints: [] };
  const entitiesByRoot = new Map<string, Set<string>>();
  let projectDescription: string | null = null;
  const gapRoots = new Map<string, Set<string>>();

  const rootSummaries = roots.map((root) => {
    const walk = walkRoot(root.path);
    const analyzedFiles = walk.analyzed.map((file) => file.relPath);
    // Qualified by root: two roots sharing a relative path must stay two files.
    allFiles.push(...analyzedFiles.map((relPath) => qualifiedFile(root.name, relPath)));
    filesByRoot.push(...analyzedFiles.map((relPath) => ({ rootName: root.name, relPath })));

    // Generated files hold example payloads and mock URLs that are not calls
    // the system makes. Inventory already classified them, so the provider
    // never has to guess.
    const generated = new Set(
      walk.analyzed.filter((file) => file.classification === "generated").map((f) => f.relPath),
    );
    const input = { name: root.name, path: root.path, analyzedFiles };
    // Consolidation folds CodeGraph's prefix-less route inferences into the
    // framework reader's full paths — different record keys, so the merge
    // contract alone cannot unify them.
    const model = consolidateRoutes(assemble(root.name, extractAll(structuralProviders, input)));

    for (const record of model.records) {
      if (record.kind === "route") {
        const route = record.record as RouteRecord;
        // A screen and an endpoint are both routes to an indexer, and listing
        // them together would have an agent rebuilding this project create an
        // HTTP endpoint for every React component. Kept, not discarded: the
        // screens are what the product looks like.
        if (route.surface === "client") screens.push(route);
        else routes.push(route);
      }
      else if (record.kind === "outbound-call") {
        const call = record.record as OutboundCallRecord;
        if (!generated.has(call.provenance.source.relPath)) calls.push(call);
      }
      else if (record.kind === "data-access") dataAccess.push(record.record as DataAccessRecord);
      else if (record.kind === "validation-rule") {
        validations.push(record.record as ValidationRuleRecord);
      }
      else if (record.kind === "symbol") symbols.push(record.record as SymbolRecord);
      else if (record.kind === "call-edge") callEdges.push(record.record as CallEdgeRecord);
      else if (record.kind === "module-containment") {
        containment.push(record.record as ModuleContainmentRecord);
      } else if (record.kind === "package-dependency") {
        dependencies.push(record.record as PackageDependencyRecord);
      }
    }

    // A declared gap becomes a sentence in the report rather than a row in a
    // table nobody queries. A reader deciding on this needs to know what was
    // not measured.
    // Deduplicated across roots. The same provider reports the same standing
    // gap for every root it runs on, so a ten-root workspace would repeat
    // eight identical sentences ten times and bury anything specific.
    for (const gap of model.gaps) {
      const key = `${gap.kind}:${gap.reason}`;
      const existing = gapRoots.get(key);
      if (existing) existing.add(root.name);
      else gapRoots.set(key, new Set([root.name]));
    }

    for (const provider of dataProviders) {
      const contribution = provider.extract(input);
      // Kept whole rather than reduced to names: a rebuild spec needs the
      // fields, their nullability and the relations between them, and the
      // pages that only show names can take what they need from here.
      dataModel.entities.push(...contribution.records.entities);
      dataModel.fields.push(...contribution.records.fields);
      dataModel.relations.push(...contribution.records.relations);
      dataModel.constraints.push(...contribution.records.constraints);
      for (const entity of contribution.records.entities) {
        entityNames.add(entity.name);
        const forRoot = entitiesByRoot.get(root.name) ?? new Set<string>();
        forRoot.add(entity.name);
        entitiesByRoot.set(root.name, forRoot);
      }
    }

    const evidence = assembleEvidence(root.name, collectAll(collectors, input));
    // Attributed to the root it came from. A multi-root workspace has no
    // single README, so quoting one part's description as the whole project's
    // would misrepresent it — saying where it came from keeps it honest.
    for (const item of evidence.items) {
      if (projectDescription !== null) break;
      const usable =
        item.item.kind === "project-description" ||
        (item.item.kind === "readme-section" && item.item.text.length > 40);
      if (!usable) continue;
      projectDescription = `${item.item.text.slice(0, 400)}\n\n— ${root.name}`;
    }
    // Only prose that describes the area itself — README sections and the
    // manifest description. A doc comment on one helper describes a helper,
    // and showing "GENERATED BY THE COMMAND ABOVE; DO NOT EDIT" under "what
    // this is" would be worse than admitting there is no description: it reads
    // as an answer while telling the reader nothing.
    evidenceByRoot.set(
      root.name,
      evidence.items
        .filter(
          (item) =>
            item.item.kind === "readme-section" || item.item.kind === "project-description",
        )
        .map((item) => item.item.text)
        .filter((text) => text.length > 40 && text.length < 400),
    );

    return {
      name: root.name,
      language: null,
      fileCount: walk.analyzed.length + walk.excluded.length,
      analyzed: walk.analyzed.length,
      excluded: walk.excluded.length,
    };
  });

  // A kind nobody claimed is not a kind the project lacks. Without this, a
  // report generated with no route-capable provider says "no entry points
  // were found", which reads as "this project serves nothing" rather than
  // "nobody looked" — the exact conflation the capability model exists to
  // prevent, arriving at the one place a reader actually sees.
  const claimed = new Set(
    structuralProviders.flatMap((provider) =>
      provider
        .structuralCapabilities()
        .declarations.filter((declaration) => declaration.support !== "none")
        .map((declaration) => declaration.kind),
    ),
  );
  const REPORT_CRITICAL_KINDS = [
    ["route", "entry points, so no features could be formed"],
    ["symbol", "code structure, so nothing could be traced"],
    ["call-edge", "call relationships, so traces could not be followed"],
  ] as const;

  for (const [kind, consequence] of REPORT_CRITICAL_KINDS) {
    if (!claimed.has(kind)) {
      coverageNotes.push({
        subject: kind,
        note: `No provider in this run supplies ${consequence}. This is a gap in the analysis, not a property of the project.`,
      });
    }
  }

  for (const [key, roots] of gapRoots) {
    const [kind, ...rest] = key.split(":");
    const where = roots.size === rootSummaries.length ? "all parts" : [...roots].sort().join(", ");
    coverageNotes.push({ subject: `${kind} · ${where}`, note: rest.join(":") });
  }

  // Partial support is where the report is most likely to mislead: a kind that
  // is *mostly* extracted looks complete. Only fully-unsupported kinds were
  // surfaced before, so the limits that actually distort what a reader sees —
  // route paths missing their framework prefix, routes registered through a
  // closure being missed entirely — never reached the page describing them.
  const seenLimits = new Set<string>();
  for (const provider of structuralProviders) {
    for (const declaration of provider.structuralCapabilities().declarations) {
      if (declaration.support !== "partial") continue;
      for (const limit of declaration.limits) {
        const key = `${declaration.kind}:${limit}`;
        if (seenLimits.has(key)) continue;
        seenLimits.add(key);
        coverageNotes.push({ subject: declaration.kind, note: limit });
      }
    }
  }

  // Routes gain their handler symbols here: the framework reader knows the
  // handler's name, the structural provider owns symbol identity, and only
  // after assembly do both sides exist.
  const handlerResolution = resolveHandlers(routes, symbols);
  const linkedRoutes = handlerResolution.routes;
  routes.length = 0;
  routes.push(...linkedRoutes);
  if (handlerResolution.unresolved.length > 0) {
    // Counted against the routes that named a handler at all. Routes
    // registered with an inline function were never candidates for
    // resolution, and including them would report a failure rate for work
    // that was never attempted.
    const named = routes.filter((route) => route.handlerCandidates.length > 0).length;
    coverageNotes.push({
      subject: "route-handlers",
      note: `${handlerResolution.unresolved.length} of ${named} routes naming a handler could not be resolved to a unique symbol; their flows stop at the route`,
    });
  }

  // Which service a configured API base names is deployment configuration, so
  // it is inferred from how well each base's paths fit, and a bound call is
  // then matched only against the service it names — which is what separates
  // one backend's /v2/worklogs from another's.
  const bindings = inferBaseBindings(calls, routes);
  const links = linkCallsScoped(calls, routes, bindings, linkCalls);
  for (const binding of bindings) {
    if (binding.boundRoot !== null) continue;
    coverageNotes.push({
      subject: "api-base-binding",
      note: `${binding.reason}, so its calls were matched against every service`,
    });
  }
  const traceResult = buildTraces({ routes, symbols, callEdges });
  const formation = formModel(traceResult.traces, { containment, dependencies, symbols }, allFiles);

  // Falling back to entry points keeps the report useful instead of
  // faithfully empty when no trace could be walked — and the coverage notes
  // already say the call graph was not followed, so nothing is overstated.
  const modules =
    formation.modules.length > 0 ? formation.modules : formModulesFromRoutes(routes);

  const routesByModule = new Map<string, ModuleEntryPoint[]>();
  const dataByModule = new Map<string, string[]>();
  const outboundByModule = new Map<string, string[]>();

  for (const module of modules) {
    const entryKeys = new Set(module.entryKeys);
    routesByModule.set(
      module.id,
      routes
        .filter((route) => entryKeys.has(`${route.rootName}:${route.method ?? "ANY"} ${route.path}`))
        .map((route) => ({ method: route.method, path: route.path, rootName: route.rootName })),
    );
    dataByModule.set(
      module.id,
      [...new Set(module.rootNames.flatMap((root) => [...(entitiesByRoot.get(root) ?? [])]))].sort(),
    );
    outboundByModule.set(
      module.id,
      [
        ...new Set(
          calls
            .filter((call) => module.rootNames.includes(call.rootName) && call.target !== null)
            .map((call) => call.target!),
        ),
      ].sort(),
    );
  }

  // The project map: our roots first, then what they reach outside. A reader
  // needs the boundary of the system before anything inside it makes sense.
  const map: MapEdge[] = rootDependencies(links).map((dependency) => ({
    from: dependency.from,
    to: dependency.to,
    kind: "internal" as const,
    detail: `${dependency.calls} calls`,
  }));

  const externalHosts = new Map<string, Set<string>>();
  for (const call of calls) {
    if (call.target === null) continue;
    const host = /^[a-zA-Z][\w+.-]*:\/\/([^/]+)/.exec(call.target)?.[1];
    if (!host) continue;
    if (links.links.some((link) => link.target === call.target)) continue;
    const forRoot = externalHosts.get(call.rootName) ?? new Set<string>();
    forRoot.add(host);
    externalHosts.set(call.rootName, forRoot);
  }
  for (const [rootName, hosts] of externalHosts) {
    for (const host of [...hosts].sort()) {
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

  const signals = computeSignals({
    links,
    traces: traceResult.traces,
    untracedEntryPoints: traceResult.untraced.length,
    handlerLinkingAvailable: routes.some((route) => route.handlerSymbolId !== null),
    modules,
    components: formation.components,
    dispositions: formation.counts,
    dependencies,
    rootNames: roots.map((root) => root.name),
  });

  const evidenceByModule = new Map<string, readonly string[]>(
    modules.map((module) => [
      module.id,
      module.rootNames.flatMap((root) => (evidenceByRoot.get(root) ?? []).slice(0, 3)),
    ]),
  );

  // Features are the product's capabilities, which is what a reader came for;
  // modules stay alongside them because a unit of code and a capability are
  // different groupings and each answers questions the other cannot.
  const detection = detectFeatures({
    entityNames: [...entityNames],
    routes,
    files: filesByRoot,
  });
  const flowSet = assembleFlows({
    features: detection.features,
    routes,
    symbols,
    links: links.links,
    calls,
    dataAccess,
    validations,
    handlerGaps: new Map(handlerResolution.unresolved.map((gap) => [gap.entryKey, gap.reason])),
  });
  const features = buildReportFeatures(detection.features, flowSet.flows);

  if (detection.setAside.length > 0) {
    coverageNotes.push({
      subject: "features",
      note: `${detection.setAside.length} further terms named something in two places but too little of it to head a feature: ${detection.setAside
        .slice(0, 12)
        .map((term) => term.term)
        .join(", ")}`,
    });
  }
  if (flowSet.skipped.length > 0) {
    coverageNotes.push({
      subject: "features",
      note: `${flowSet.skipped.length} of ${routes.length} endpoints name no detected feature and are listed only under their service`,
    });
  }

  // A schema the report shows fields for, against the tables it says are
  // touched. Silence here reads as "these 45 tables are the data model",
  // when two thirds of what the code uses has no entity at all — the schema
  // providers read SQL and ORM migrations, and a service that declares its
  // tables in Go contributes none.
  const describedEntities = new Set(entityNames);
  const touchedTables = new Set<string>();
  for (const access of dataAccess) {
    if (access.entity !== null) touchedTables.add(access.entity);
  }
  const undescribed = [...touchedTables].filter((table) => !describedEntities.has(table));
  if (undescribed.length > 0) {
    coverageNotes.push({
      subject: "data-model",
      note: `fields and constraints are described for ${describedEntities.size} entities, but ${undescribed.length} further tables are used by code without a schema declaration this run could read; their columns are not in this report`,
    });
  }

  if (screens.length > 0) {
    coverageNotes.push({
      subject: "screens",
      note: `${screens.length} client-side routes were read as the application's screens and are listed separately from the API`,
    });
  }

  const projectName = roots.length === 1 ? roots[0]!.name : selection.workspacePath.split("/").pop() ?? "project";

  const model = assembleReport({
    runId,
    generatedAt,
    workspacePath: selection.workspacePath,
    projectName,
    description: projectDescription,
    language,
    roots: rootSummaries,
    modules,
    features,
    components: formation.components,
    integrations: rootDependencies(links),
    map,
    mapDiagram: mapToMermaid(map),
    screens: screens
      .map((screen) => ({
        rootName: screen.rootName,
        path: screen.path,
        // A screen declared inside a subtree whose parent is mounted from
        // another file has a real path fragment, not the address a user
        // visits — saying which is which keeps a list of "/add" honest.
        pathComplete: screen.provenance.resolutionClass !== "inferred",
      }))
      .sort((a, b) => a.rootName.localeCompare(b.rootName) || a.path.localeCompare(b.path)),
    unassignedEndpointCount: flowSet.skipped.length,
    dataEntities: [...entityNames].sort(),
    signals,
    dispositions: formation.counts,
    evidenceByModule,
    routesByModule,
    dataByModule,
    outboundByModule,
    coverageNotes,
  });

  mkdirSync(options.outputDir, { recursive: true });

  // The specification is the artifact; every format is rendered from it. That
  // is what lets a wording change, a restyle, or a new exporter run without
  // touching the project again — and it keeps the formats agreeing, since a
  // page can only show what the spec contains.
  const spec = buildJsonReport({ model, dataModel, limitations: [] });
  const jsonPath = join(options.outputDir, "report.json");
  writeFileSync(jsonPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");

  const files = [jsonPath, ...writeRenderings(spec, options.outputDir)];

  return {
    runId,
    outputDir: options.outputDir,
    files,
    moduleCount: modules.length,
    featureCount: features.length,
    componentCount: formation.components.length,
  };
}
