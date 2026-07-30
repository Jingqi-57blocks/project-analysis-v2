/**
 * The questions a document can ask of a knowledge base.
 *
 * One function per question, deliberately. A query language would let a
 * template ask something nobody had thought about how to answer honestly;
 * every function here is a place where "the project has none" and "nobody
 * looked" can be kept apart, which is the property this whole tool rests on.
 *
 * Nothing here composes prose or counts things a caller could count. It hands
 * back the facts as they were stored, so a claim in a document can be traced
 * to a row and checked.
 */

import type { Store } from "../store/types.js";
import { readDerived, readDerivedFor, readDerivedOne, readLinks, readLinksTo } from "./persist.js";
import { derivedKey, type DerivedKind, type DerivedRecords } from "./kinds.js";
import { readRecords } from "../structural/persist.js";
import type { StructuralKind } from "../structural/kinds.js";
import type {
  AuthAnnotationRecord,
  DataAccessRecord,
  OutboundCallRecord,
  RouteRecord,
} from "../structural/boundaries.js";
import type { PackageDependencyRecord } from "../structural/dependencies.js";
import type {
  DiscardedErrorRecord,
  ErrorHandlingRecord,
  TransactionBoundaryRecord,
} from "../structural/rules.js";
import type {
  ConstraintRecord,
  DataRelationRecord,
  EntityRecord,
  FieldRecord,
} from "../datamodel/types.js";
import type { BusinessRule } from "../semantics/rules.js";
import type { DecisionRecord, GuardRecord } from "../structural/rules.js";
import { bestSetFor, type ValueSet } from "../semantics/enums.js";
import { singular, words } from "../modules/features.js";
import type {
  CoverageNote,
  FeatureFact,
  FeatureFindingFact,
  FeatureFlowFact,
  MapEdge,
  ModuleFact,
  RunContext,
} from "./facts.js";

export class SnapshotNotFoundError extends Error {
  constructor(
    readonly runId: string | null,
    workspacePath?: string,
  ) {
    const where = workspacePath === undefined ? "" : ` for ${workspacePath}`;
    super(
      runId === null
        ? `No published analysis exists in this knowledge base${where}. Run \`analyze\` first.`
        : `No published analysis with run id ${runId}${where}. It may have failed before publishing.`,
    );
    this.name = "SnapshotNotFoundError";
  }
}

export class AmbiguousWorkspaceError extends Error {
  constructor(readonly workspacePaths: readonly string[]) {
    super(
      `This knowledge base holds analyses of ${workspacePaths.length} workspaces:\n` +
        workspacePaths.map((path) => `  ${path}`).join("\n") +
        "\nName one with --workspace, or a run with --run.",
    );
    this.name = "AmbiguousWorkspaceError";
  }
}

export interface Snapshot {
  readonly id: number;
  readonly runId: string | null;
  readonly identity: string;
  readonly publishedAt: string;
  readonly workspacePath: string;
}

interface SnapshotRow {
  readonly id: number;
  readonly run_id: string | null;
  readonly identity: string;
  readonly published_at: string;
  readonly path: string;
}

/**
 * The snapshot a query reads: the one named, or the latest published.
 *
 * Never an unpublished one. A run that failed partway leaves its snapshot
 * inert, and reading it would present half an analysis as the answer.
 *
 * With no run id and more than one workspace in the database, this refuses
 * rather than picking the most recent — one file can hold analyses of several
 * projects, and answering about the wrong one looks exactly like answering
 * about the right one.
 *
 * `id DESC` is the tie-break because `published_at` has millisecond resolution
 * and two runs in quick succession can share one.
 */
export function resolveSnapshot(store: Store, runId?: string, workspacePath?: string): Snapshot {
  if (runId === undefined && workspacePath === undefined) {
    const workspaces = store.all<{ path: string }>(
      `SELECT DISTINCT w.path FROM workspaces w
       JOIN snapshots s ON s.workspace_id = w.id
       WHERE s.published_at IS NOT NULL ORDER BY w.path`,
    );
    if (workspaces.length > 1) {
      throw new AmbiguousWorkspaceError(workspaces.map((row) => row.path));
    }
  }

  const clause = runId !== undefined ? "s.run_id = ?" : workspacePath !== undefined ? "w.path = ?" : "1 = 1";
  const params = runId ?? workspacePath;

  const row = store.get<SnapshotRow>(
    `SELECT s.id, s.run_id, s.identity, s.published_at, w.path
     FROM snapshots s JOIN workspaces w ON w.id = s.workspace_id
     WHERE ${clause} AND s.published_at IS NOT NULL
     ORDER BY s.published_at DESC, s.id DESC LIMIT 1`,
    params === undefined ? [] : [params],
  );

  if (row === undefined) throw new SnapshotNotFoundError(runId ?? null, workspacePath);
  return {
    id: row.id,
    runId: row.run_id,
    identity: row.identity,
    publishedAt: row.published_at,
    workspacePath: row.path,
  };
}

/**
 * What a capability produced, so an empty answer can be read correctly.
 *
 * A query returning nothing means one of two things, and the difference is the
 * whole point: this project has none, or nothing in this run could look. Every
 * selector that can come back empty is paired with one of these.
 */
export interface Coverage {
  readonly attempted: boolean;
  readonly outcomes: readonly {
    readonly providerId: string;
    readonly rootName: string;
    readonly language: string;
    readonly outcome: string;
    readonly reason: string | null;
    readonly recordCount: number;
  }[];
}

export interface EntityModel {
  readonly entity: EntityRecord;
  readonly fields: readonly FieldRecord[];
  readonly relations: readonly DataRelationRecord[];
  readonly constraints: readonly ConstraintRecord[];
}

export interface DataOwnership {
  readonly table: string;
  readonly writers: readonly string[];
  /** Roots that read but were not seen to write — reading across a boundary. */
  readonly readers: readonly string[];
  readonly sharing: "single-owner" | "read-across-a-boundary" | "written-by-several";
}

export interface ReliabilitySignal {
  readonly rootName: string;
  readonly errorHandlingSites: number;
  readonly transactionBoundaries: number;
  readonly discardedErrors: number;
}

export interface TestPresence {
  readonly rootName: string;
  readonly testCount: number;
  readonly sample: readonly string[];
}

export interface EndpointPermission {
  readonly rootName: string;
  readonly method: string | null;
  readonly path: string;
  /** The middleware declared on the route — auth checks, validation, and more. */
  readonly middleware: readonly string[];
}

export interface FeatureDetail {
  readonly feature: FeatureFact;
  readonly flows: readonly FeatureFlowFact[];
  readonly rules: readonly BusinessRule[];
  readonly findings: readonly FeatureFindingFact[];
}

export interface ModuleDetail {
  readonly module: ModuleFact;
  /** The capabilities this unit of code serves. Often more than one. */
  readonly features: readonly FeatureFact[];
}

/**
 * A knowledge base, opened at one snapshot.
 *
 * The store stays the caller's to close. Every method reads; nothing here
 * writes, so two documents drawn from one handle cannot disagree.
 */
export class KnowledgeBase {
  constructor(
    private readonly store: Store,
    readonly snapshot: Snapshot,
  ) {}

  private derived<K extends DerivedKind>(kind: K): readonly DerivedRecords[K][number][] {
    return readDerived(this.store, this.snapshot.id, kind).map((stored) => stored.record);
  }

  private structural<K extends StructuralKind>(kind: K): readonly unknown[] {
    return readRecords(this.store, this.snapshot.id, kind).map((stored) => stored.record);
  }

  /** What this run was. Null only for a snapshot written before facts were kept. */
  runContext(): RunContext | null {
    return readDerivedOne(this.store, this.snapshot.id, "run-context");
  }

  features(): readonly FeatureFact[] {
    return this.derived("feature");
  }

  featureDetail(featureId: string): FeatureDetail | null {
    const feature = this.features().find((entry) => entry.id === featureId);
    if (feature === undefined) return null;

    return {
      feature,
      flows: this.flowsForFeature(featureId),
      rules: this.rulesForFeature(featureId),
      findings: readDerivedFor(this.store, this.snapshot.id, "feature-finding", featureId),
    };
  }

  flowsForFeature(featureId: string): readonly FeatureFlowFact[] {
    return readDerivedFor(this.store, this.snapshot.id, "feature-flow", featureId);
  }

  /**
   * The rules published for a capability — the ones worth a reader's
   * attention, not every comparison in its files.
   *
   * Read through the links rather than by filtering on file paths: which rules
   * a capability owns is a decision the derivation made, and re-deciding it
   * here would let a document disagree with the knowledge base.
   */
  rulesForFeature(featureId: string): readonly BusinessRule[] {
    const keys = new Set(
      readLinks(this.store, this.snapshot.id, "feature", featureId, "rule").map(
        (link) => link.toKey,
      ),
    );
    return this.derived("business-rule").filter((rule) =>
      keys.has(derivedKey("business-rule", rule)),
    );
  }

  modules(): readonly ModuleFact[] {
    return this.derived("module");
  }

  moduleDetail(moduleId: string): ModuleDetail | null {
    const module = this.modules().find((entry) => entry.id === moduleId);
    if (module === undefined) return null;

    const featureIds = new Set(
      readLinks(this.store, this.snapshot.id, "module", moduleId, "feature").map(
        (link) => link.toKey,
      ),
    );
    return {
      module,
      features: this.features().filter((feature) => featureIds.has(feature.id)),
    };
  }





  /** Which modules serve a capability. A capability can span several. */
  modulesForFeature(featureId: string): readonly ModuleFact[] {
    const ids = new Set(
      readLinksTo(this.store, this.snapshot.id, "feature", featureId, "feature").map(
        (link) => link.fromKey,
      ),
    );
    return this.modules().filter((module) => ids.has(module.id));
  }

  components() {
    return this.derived("component");
  }

  traces() {
    return this.derived("trace");
  }

  /** Every decision the code makes, as trees. */
  decisions(): readonly DecisionRecord[] {
    return this.structural("decision") as readonly DecisionRecord[];
  }

  /** Every gate — an `if` that rejects with a message — the code enforces. */
  guards(): readonly GuardRecord[] {
    return this.structural("guard") as readonly GuardRecord[];
  }

  /**
   * The gates enforced in a capability's own files.
   *
   * The business rules that are not literal comparisons — an office check, a
   * balance test, an attachment requirement — each stated by the message it
   * rejects with. Scoped by file, the same way decisions are.
   */
  guardsForFeature(featureId: string): readonly GuardRecord[] {
    const feature = this.features().find((entry) => entry.id === featureId);
    if (feature === undefined) return [];
    const owned = new Set(feature.filePaths);
    return this.guards().filter((guard) => owned.has(`${guard.rootName}/${guard.source.relPath}`));
  }

  /**
   * The status sets a capability's records move through.
   *
   * A value set counts when its name says it is one — status, state, flow,
   * stage — and it is named for this capability: the capability's term in the
   * set's own name (`LeaveRequestStatus`) or in the file that declares it
   * (`constant/leave.go`). Matching on shared member names was tried and
   * over-matched badly — `Approved` and `Rejected` belong to every approval
   * set in the project — so a status set named for something else that this
   * capability nonetheless uses is missed, and that limit is stated to the
   * section that reads this rather than papered over with a looser match.
   */
  statusSetsForFeature(featureId: string): readonly ValueSet[] {
    const feature = this.features().find((entry) => entry.id === featureId);
    if (feature === undefined) return [];
    const term = singular(feature.term.toLowerCase());

    const LOOKS_LIKE_STATUS = /status|state|flow|stage|phase/i;
    return this.valueSets().filter(
      (set) =>
        LOOKS_LIKE_STATUS.test(set.name) &&
        set.members.length > 1 &&
        (words(set.name).map(singular).includes(term) ||
          words(set.relPath).map(singular).includes(term)),
    );
  }

  /**
   * Each of a capability's endpoints, with the access checks declared on it.
   *
   * The declared authorisation only — the middleware named on the route. A
   * check written inside a handler is out of reach, so an endpoint with nothing
   * here is one where no check was *declared*, not one that is provably open;
   * and a capability whose endpoints show only a bare "signed in" enforces any
   * finer permission (who may approve, say) inside the handler, not at the
   * boundary. Stated so a reader draws the honest conclusion.
   */
  permissionsForFeature(featureId: string): readonly EndpointPermission[] {
    const feature = this.features().find((entry) => entry.id === featureId);
    if (feature === undefined) return [];
    const key = (route: { rootName: string; method: string | null; path: string }): string =>
      `${route.rootName} ${route.method ?? "ANY"} ${route.path}`;
    const routes = new Map(this.endpoints().map((route) => [key(route), route] as const));
    return feature.endpoints.map((endpoint) => ({
      rootName: endpoint.rootName,
      method: endpoint.method,
      path: endpoint.path,
      middleware: routes.get(key(endpoint))?.middleware ?? [],
    }));
  }

  /**
   * The decisions made in a capability's own files.
   *
   * Scoped by file because that is how a capability owns code: a decision is
   * in `leave/service.go`, and Leave owns that file. Nothing finer is
   * available, and claiming otherwise would attribute a branch to a
   * capability that never runs it.
   */
  decisionsForFeature(featureId: string): readonly DecisionRecord[] {
    const feature = this.features().find((entry) => entry.id === featureId);
    if (feature === undefined) return [];

    const owned = new Set(feature.filePaths);
    return this.decisions()
      .filter((decision) => owned.has(`${decision.rootName}/${decision.source.relPath}`))
      .map((decision) => this.withEffects(decision));
  }

  /**
   * What each branch of a decision was observed to do.
   *
   * The reader records where a branch is, not what happens inside it, so that
   * one fact keeps one source. Joining by line is where the two meet: a data
   * access recorded at line 88 of the same file belongs to the branch that
   * spans lines 84 to 92.
   *
   * Without this a diagram shows three branches and nothing about where they
   * lead, which invites a reader to assume the branches do not matter.
   */
  private withEffects(decision: DecisionRecord): DecisionRecord {
    const file = `${decision.rootName}/${decision.source.relPath}`;
    const accesses = this.dataAccessByFile().get(file) ?? [];

    const attach = (branch: DecisionRecord["branches"][number]): DecisionRecord["branches"][number] => ({
      ...branch,
      touches: [
        ...new Set(
          accesses
            .filter(
              (access) =>
                access.line >= branch.startLine &&
                access.line <= branch.endLine &&
                access.entity !== null,
            )
            .map((access) => access.entity!),
        ),
      ].sort(),
      decisions: branch.decisions.map((inner) => this.withEffects(inner)),
    });

    return { ...decision, branches: decision.branches.map(attach) };
  }

  private accessCache: Map<string, { line: number; entity: string | null }[]> | null = null;

  private dataAccessByFile(): ReadonlyMap<string, { line: number; entity: string | null }[]> {
    if (this.accessCache !== null) return this.accessCache;

    const byFile = new Map<string, { line: number; entity: string | null }[]>();
    for (const record of this.structural("data-access") as readonly DataAccessRecord[]) {
      const source = record.provenance.source;
      const key = `${record.rootName}/${source.relPath}`;
      const list = byFile.get(key) ?? [];
      list.push({ line: source.startLine ?? 0, entity: record.entity });
      byFile.set(key, list);
    }
    this.accessCache = byFile;
    return byFile;
  }

  /** Findings about the architecture rather than about one capability. */
  structuralFindings(severity?: string) {
    const findings = this.derived("structural-finding");
    return severity === undefined
      ? findings
      : findings.filter((finding) => finding.severity === severity);
  }

  /** Findings about capabilities, across all of them. */
  featureFindings(severity?: string): readonly FeatureFindingFact[] {
    const findings = this.derived("feature-finding");
    return severity === undefined
      ? findings
      : findings.filter((finding) => finding.severity === severity);
  }

  /** Measurements of the analysis itself, not of the product. */
  signals() {
    return this.derived("health-signal");
  }

  mapEdges(): readonly MapEdge[] {
    return this.derived("map-edge");
  }

  integrations(): readonly MapEdge[] {
    return this.mapEdges().filter((edge) => edge.kind === "internal");
  }

  crossRootLinks() {
    return this.derived("cross-root-link");
  }

  unlinkedCalls() {
    return this.derived("unlinked-call");
  }

  baseBindings() {
    return this.derived("base-binding");
  }

  coverageNotes(): readonly CoverageNote[] {
    return this.derived("coverage-note");
  }

  valueSets(): readonly ValueSet[] {
    return this.derived("value-set");
  }

  /** The vocabulary that explains a subject's values, where the project has one. */
  valueSetExplaining(subject: string, preferRoot: string | null = null): ValueSet | null {
    return bestSetFor(subject, this.valueSets(), preferRoot);
  }

  businessRules(): readonly BusinessRule[] {
    return this.derived("business-rule");
  }

  /** Endpoints the project serves. */
  endpoints(): readonly RouteRecord[] {
    return (this.structural("route") as readonly RouteRecord[]).filter(
      (route) => route.surface !== "client",
    );
  }

  /**
   * Screens the application shows.
   *
   * The same records as endpoints, told apart by surface. An indexer reports
   * both as routes, and listing them together turns a React component into an
   * HTTP endpoint.
   */
  screens(): readonly RouteRecord[] {
    return (this.structural("route") as readonly RouteRecord[]).filter(
      (route) => route.surface === "client",
    );
  }

  /**
   * The screens where a person meets this capability.
   *
   * Matched by the capability's own term appearing as a word of the screen's
   * path — `/my/leave/create` names leave the same way the feature detector
   * found it. That is how the applications here name their screens; a screen
   * reached only through state or a modal carries no such path, so this is
   * where the capability *can be found*, never a census of every surface that
   * touches it.
   */
  screensForFeature(featureId: string): readonly RouteRecord[] {
    const feature = this.features().find((entry) => entry.id === featureId);
    if (feature === undefined) return [];
    const term = singular(feature.term.toLowerCase());
    return this.screens().filter((screen) =>
      screen.path
        .split("/")
        .some((segment) => words(segment).map(singular).includes(term)),
    );
  }

  entities(): readonly EntityRecord[] {
    return this.structural("entity") as readonly EntityRecord[];
  }

  entityModel(name: string, rootName?: string): EntityModel | null {
    const entity = (this.entities() as readonly EntityRecord[]).find(
      (candidate) =>
        candidate.name === name && (rootName === undefined || candidate.rootName === rootName),
    );
    if (entity === undefined) return null;

    const owns = (recordRoot: string, entityName: string): boolean =>
      recordRoot === entity.rootName && entityName === entity.name;

    return {
      entity,
      fields: (this.structural("entity-field") as readonly FieldRecord[]).filter((field) =>
        owns(field.rootName, field.entityName),
      ),
      relations: (this.structural("entity-relation") as readonly DataRelationRecord[]).filter(
        (relation) => owns(relation.rootName, relation.fromEntity),
      ),
      constraints: (this.structural("entity-constraint") as readonly ConstraintRecord[]).filter(
        (constraint) => owns(constraint.rootName, constraint.entityName),
      ),
    };
  }

  /** Prose the developers wrote, quoted as written. */
  evidence(kind?: string): readonly { text: string; kind: string; rootName: string; relPath: string }[] {
    const rows = this.store.all<{
      kind: string;
      text: string;
      rel_path: string;
      root_name: string;
    }>(
      `SELECT e.kind, e.text, e.rel_path, r.name AS root_name
       FROM evidence_items e JOIN source_roots r ON r.id = e.source_root_id
       WHERE e.snapshot_id = ?${kind === undefined ? "" : " AND e.kind = ?"}
       ORDER BY e.id`,
      kind === undefined ? [this.snapshot.id] : [this.snapshot.id, kind],
    );
    return rows.map((row) => ({
      kind: row.kind,
      text: row.text,
      rootName: row.root_name,
      relPath: row.rel_path,
    }));
  }

  /**
   * Whether anything looked for a kind of fact, and what it found.
   *
   * The answer to "is this list empty because the project has none". A caller
   * showing an empty list without asking this has published a claim it cannot
   * support.
   */
  coverageFor(kind: StructuralKind): Coverage {
    const rows = this.store.all<{
      provider_id: string;
      root_name: string;
      language: string;
      outcome: string;
      reason: string | null;
      record_count: number;
    }>(
      `SELECT c.provider_id, r.name AS root_name, c.language, c.outcome, c.reason, c.record_count
       FROM capability_results c JOIN source_roots r ON r.id = c.source_root_id
       WHERE c.snapshot_id = ? AND c.kind = ?
       ORDER BY r.name, c.provider_id, c.language`,
      [this.snapshot.id, kind],
    );
    return {
      attempted: rows.length > 0,
      outcomes: rows.map((row) => ({
        providerId: row.provider_id,
        rootName: row.root_name,
        language: row.language,
        outcome: row.outcome,
        reason: row.reason,
        recordCount: row.record_count,
      })),
    };
  }

  /** Every observed read or write of a store, as recorded. */
  dataAccess(): readonly DataAccessRecord[] {
    return this.structural("data-access") as readonly DataAccessRecord[];
  }

  /**
   * Who writes and who reads each table, and how strong the sharing evidence is.
   *
   * A table one service writes and another only reads is a boundary crossed
   * without an interface; a table two services both write is a rule enforced in
   * two places. The distinction a reader needs is which of those it is, so it
   * is computed here rather than left for prose to re-derive and get wrong.
   *
   * `entity` is null for a query built at runtime; those cannot be attributed
   * to a table and are left out rather than bundled under a made-up name.
   */
  dataOwnership(): readonly DataOwnership[] {
    const WRITES = new Set(["write", "update", "delete", "schema-change"]);
    const byTable = new Map<string, { writers: Set<string>; readers: Set<string> }>();
    for (const access of this.dataAccess()) {
      if (access.entity === null || access.entity === "") continue;
      const entry = byTable.get(access.entity) ?? { writers: new Set(), readers: new Set() };
      if (WRITES.has(access.operation)) entry.writers.add(access.rootName);
      else if (access.operation === "read") entry.readers.add(access.rootName);
      else entry.readers.add(access.rootName);
      byTable.set(access.entity, entry);
    }

    return [...byTable.entries()]
      .map(([table, { writers, readers }]) => {
        const readOnly = [...readers].filter((root) => !writers.has(root));
        const sharing: DataOwnership["sharing"] =
          writers.size > 1
            ? "written-by-several"
            : readOnly.length > 0 && writers.size >= 1
              ? "read-across-a-boundary"
              : "single-owner";
        return {
          table,
          writers: [...writers].sort(),
          readers: readOnly.sort(),
          sharing,
        };
      })
      .sort((a, b) => a.table.localeCompare(b.table));
  }

  /** Declared authentication and authorization requirements. */
  authAnnotations(): readonly AuthAnnotationRecord[] {
    return this.structural("auth-annotation") as readonly AuthAnnotationRecord[];
  }

  /** Calls leaving a service over a network boundary. */
  outboundCalls(): readonly OutboundCallRecord[] {
    return this.structural("outbound-call") as readonly OutboundCallRecord[];
  }

  /** Third-party packages each service declares it depends on. */
  dependencies(): readonly PackageDependencyRecord[] {
    return this.structural("package-dependency") as readonly PackageDependencyRecord[];
  }

  /**
   * Signals about how the code copes with failure, per service.
   *
   * Counts, not verdicts: the presence of a catch says nothing about whether it
   * swallows the error, and a reader is told exactly that. Grouped by service
   * because "which part has no transactions" is the shape of the question.
   */
  reliability(): readonly ReliabilitySignal[] {
    const errors = this.structural("error-handling") as readonly ErrorHandlingRecord[];
    const transactions = this.structural("transaction-boundary") as readonly TransactionBoundaryRecord[];
    const discarded = this.structural("discarded-error") as readonly DiscardedErrorRecord[];

    const roots = new Set<string>([
      ...errors.map((record) => record.rootName),
      ...transactions.map((record) => record.rootName),
      ...discarded.map((record) => record.rootName),
    ]);
    const count = (records: readonly { rootName: string }[], root: string): number =>
      records.filter((record) => record.rootName === root).length;

    return [...roots]
      .sort()
      .map((root) => ({
        rootName: root,
        errorHandlingSites: count(errors, root),
        transactionBoundaries: count(transactions, root),
        discardedErrors: count(discarded, root),
      }));
  }

  /**
   * How many tests name each service, and a sample of what they are named.
   *
   * A count of test *names*, not a coverage percentage: a service absent here
   * had no test detected at all, and a service present may still test only its
   * utilities. Both are stated so a reader draws the right, bounded conclusion
   * rather than reading a number as a guarantee. Every analysed root is
   * listed, including the ones with zero — silence about a service with no
   * tests is the finding lost.
   */
  testPresence(): readonly TestPresence[] {
    const names = this.evidence("test-name");
    const byRoot = new Map<string, string[]>();
    for (const root of this.runContext()?.roots ?? []) byRoot.set(root.name, []);
    for (const entry of names) {
      const existing = byRoot.get(entry.rootName) ?? [];
      existing.push(entry.text);
      byRoot.set(entry.rootName, existing);
    }
    return [...byRoot.entries()]
      .map(([rootName, testNames]) => ({
        rootName,
        testCount: testNames.length,
        sample: testNames.slice(0, 6),
      }))
      .sort((a, b) => b.testCount - a.testCount || a.rootName.localeCompare(b.rootName));
  }

  /** What broke without stopping the run. */
  extractionFailures(): readonly { providerId: string; scope: string; reason: string }[] {
    return this.store
      .all<{ provider_id: string; scope: string; reason: string }>(
        "SELECT provider_id, scope, reason FROM extraction_failures WHERE snapshot_id = ? ORDER BY id",
        [this.snapshot.id],
      )
      .map((row) => ({ providerId: row.provider_id, scope: row.scope, reason: row.reason }));
  }
}

/** Opens a knowledge base at the named run, or at the latest published one. */
export function openKnowledgeBase(
  store: Store,
  runId?: string,
  workspacePath?: string,
): KnowledgeBase {
  return new KnowledgeBase(store, resolveSnapshot(store, runId, workspacePath));
}
