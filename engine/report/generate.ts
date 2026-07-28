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
import { linkCalls, rootDependencies } from "../linking/link.js";
import { buildTraces } from "../modules/trace.js";
import { formModel, formModulesFromRoutes } from "../modules/form.js";
import { createSqlSchemaProvider } from "../datamodel/sql.js";
import { createOrmMigrationProvider } from "../datamodel/orm.js";
import { computeSignals } from "../health/signals.js";
import {
  assembleReport,
  DEFAULT_LANGUAGE,
  type CoverageNote,
  type MapEdge,
  type ModuleEntryPoint,
  type OutputLanguage,
} from "./model.js";
import { renderHtmlReport } from "./html.js";
import type { StructuralProvider } from "../structural/provider.js";
import type { RouteRecord, OutboundCallRecord } from "../structural/boundaries.js";
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
    ...(options.extraProviders ?? [createCodeGraphProvider({ callEdges: false })]),
  ];
  const collectors = [createDocumentationCollector(), createCodeTextCollector()];

  const routes: RouteRecord[] = [];
  const calls: OutboundCallRecord[] = [];
  const symbols: SymbolRecord[] = [];
  const callEdges: CallEdgeRecord[] = [];
  const containment: ModuleContainmentRecord[] = [];
  const dependencies: PackageDependencyRecord[] = [];
  const allFiles: string[] = [];
  const coverageNotes: CoverageNote[] = [];
  const evidenceByRoot = new Map<string, string[]>();
  const dataProviders = [createSqlSchemaProvider(), createOrmMigrationProvider()];
  const entityNames = new Set<string>();
  const entitiesByRoot = new Map<string, Set<string>>();
  let projectDescription: string | null = null;

  const rootSummaries = roots.map((root) => {
    const walk = walkRoot(root.path);
    const analyzedFiles = walk.analyzed.map((file) => file.relPath);
    allFiles.push(...analyzedFiles);

    const input = { name: root.name, path: root.path, analyzedFiles };
    const model = assemble(root.name, extractAll(structuralProviders, input));

    for (const record of model.records) {
      if (record.kind === "route") routes.push(record.record as RouteRecord);
      else if (record.kind === "outbound-call") calls.push(record.record as OutboundCallRecord);
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
    for (const gap of model.gaps) {
      coverageNotes.push({ subject: `${root.name} · ${gap.kind}`, note: gap.reason });
    }

    for (const provider of dataProviders) {
      const contribution = provider.extract(input);
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

  const links = linkCalls(calls, routes);
  const traceResult = buildTraces({ routes, symbols, callEdges });
  const formation = formModel(traceResult.traces, { containment, dependencies, symbols }, allFiles);

  // Traces need routes linked to handler symbols, which no provider supplies
  // yet. Falling back to entry points keeps the report useful instead of
  // faithfully empty — and the coverage notes already say the call graph was
  // not followed, so nothing here is overstated.
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
    components: formation.components,
    integrations: rootDependencies(links),
    map,
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
  const files = renderHtmlReport(model).map((page) => {
    const path = join(options.outputDir, page.filename);
    writeFileSync(path, page.html, "utf8");
    return path;
  });

  return {
    runId,
    outputDir: options.outputDir,
    files,
    moduleCount: modules.length,
    componentCount: formation.components.length,
  };
}
