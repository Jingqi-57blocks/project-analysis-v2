/**
 * The extracted records, sorted into the buckets derivation works from.
 *
 * Every root produced one merged model; derivation needs them by kind across
 * all roots, plus a few groupings that are cheaper to build here than to
 * recompute at each of the four places that want them.
 *
 * Two distinctions are drawn in this pass and matter more than the sorting. A
 * client-side route is not an endpoint — listing them together would have an
 * agent rebuilding the project create an HTTP endpoint for every React
 * component. And a call written in a generated file is not a call the system
 * makes: those files hold example payloads and mock URLs, and inventory has
 * already said which they are, so nothing here has to guess.
 */

import type { AssembledModel } from "../structural/assemble.js";
import type {
  AuthAnnotationRecord,
  DataAccessRecord,
  OutboundCallRecord,
  RouteRecord,
} from "../structural/boundaries.js";
import type { CallEdgeRecord, SymbolRecord } from "../structural/code.js";
import type {
  ModuleContainmentRecord,
  PackageDependencyRecord,
} from "../structural/dependencies.js";
import type {
  ConditionRecord,
  DiscardedErrorRecord,
  ErrorHandlingRecord,
  TransactionBoundaryRecord,
  ValidationRuleRecord,
} from "../structural/rules.js";
import type {
  ConstraintRecord,
  DataRelationRecord,
  EntityRecord,
  FieldRecord,
} from "../datamodel/types.js";
import type { RootFacts } from "./extract.js";

export interface GatheredRecords {
  readonly routes: readonly RouteRecord[];
  /** Client-side routes: what the application shows, not what it serves. */
  readonly screens: readonly RouteRecord[];
  readonly calls: readonly OutboundCallRecord[];
  readonly symbols: readonly SymbolRecord[];
  readonly callEdges: readonly CallEdgeRecord[];
  readonly dataAccess: readonly DataAccessRecord[];
  readonly validations: readonly ValidationRuleRecord[];
  readonly transactions: readonly TransactionBoundaryRecord[];
  readonly errorHandling: readonly ErrorHandlingRecord[];
  readonly authAnnotations: readonly AuthAnnotationRecord[];
  readonly conditions: readonly ConditionRecord[];
  readonly discarded: readonly DiscardedErrorRecord[];
  readonly containment: readonly ModuleContainmentRecord[];
  readonly dependencies: readonly PackageDependencyRecord[];
  readonly entities: readonly EntityRecord[];
  readonly fields: readonly FieldRecord[];
  readonly relations: readonly DataRelationRecord[];
  readonly constraints: readonly ConstraintRecord[];
  /** Every entity name any reader declared. */
  readonly entityNames: ReadonlySet<string>;
  readonly entitiesByRoot: ReadonlyMap<string, ReadonlySet<string>>;
  /** Entity name → root → the columns that root declares for it. */
  readonly entityColumns: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  /** Tables the code was observed to touch, whether or not a schema declares them. */
  readonly touchedTables: ReadonlySet<string>;
  /** Root → prose describing the area itself, quoted as written. */
  readonly descriptionsByRoot: ReadonlyMap<string, readonly string[]>;
  /** The project's own description, where one part carries one. */
  readonly projectDescription: string | null;
}

interface Buckets {
  routes: RouteRecord[];
  screens: RouteRecord[];
  calls: OutboundCallRecord[];
  symbols: SymbolRecord[];
  callEdges: CallEdgeRecord[];
  dataAccess: DataAccessRecord[];
  validations: ValidationRuleRecord[];
  transactions: TransactionBoundaryRecord[];
  errorHandling: ErrorHandlingRecord[];
  authAnnotations: AuthAnnotationRecord[];
  conditions: ConditionRecord[];
  discarded: DiscardedErrorRecord[];
  containment: ModuleContainmentRecord[];
  dependencies: PackageDependencyRecord[];
  entities: EntityRecord[];
  fields: FieldRecord[];
  relations: DataRelationRecord[];
  constraints: ConstraintRecord[];
}

function emptyBuckets(): Buckets {
  return {
    routes: [],
    screens: [],
    calls: [],
    symbols: [],
    callEdges: [],
    dataAccess: [],
    validations: [],
    transactions: [],
    errorHandling: [],
    authAnnotations: [],
    conditions: [],
    discarded: [],
    containment: [],
    dependencies: [],
    entities: [],
    fields: [],
    relations: [],
    constraints: [],
  };
}

function sortInto(buckets: Buckets, model: AssembledModel, generated: ReadonlySet<string>): void {
  for (const assembled of model.records) {
    switch (assembled.kind) {
      case "route": {
        const route = assembled.record as RouteRecord;
        if (route.surface === "client") buckets.screens.push(route);
        else buckets.routes.push(route);
        break;
      }
      case "outbound-call": {
        const call = assembled.record as OutboundCallRecord;
        if (!generated.has(call.provenance.source.relPath)) buckets.calls.push(call);
        break;
      }
      case "symbol":
        buckets.symbols.push(assembled.record as SymbolRecord);
        break;
      case "call-edge":
        buckets.callEdges.push(assembled.record as CallEdgeRecord);
        break;
      case "data-access":
        buckets.dataAccess.push(assembled.record as DataAccessRecord);
        break;
      case "validation-rule":
        buckets.validations.push(assembled.record as ValidationRuleRecord);
        break;
      case "transaction-boundary":
        buckets.transactions.push(assembled.record as TransactionBoundaryRecord);
        break;
      case "error-handling":
        buckets.errorHandling.push(assembled.record as ErrorHandlingRecord);
        break;
      case "auth-annotation":
        buckets.authAnnotations.push(assembled.record as AuthAnnotationRecord);
        break;
      case "condition":
        buckets.conditions.push(assembled.record as ConditionRecord);
        break;
      case "discarded-error":
        buckets.discarded.push(assembled.record as DiscardedErrorRecord);
        break;
      case "module-containment":
        buckets.containment.push(assembled.record as ModuleContainmentRecord);
        break;
      case "package-dependency":
        buckets.dependencies.push(assembled.record as PackageDependencyRecord);
        break;
      case "entity":
        buckets.entities.push(assembled.record as EntityRecord);
        break;
      case "entity-field":
        buckets.fields.push(assembled.record as FieldRecord);
        break;
      case "entity-relation":
        buckets.relations.push(assembled.record as DataRelationRecord);
        break;
      case "entity-constraint":
        buckets.constraints.push(assembled.record as ConstraintRecord);
        break;
      default:
        break;
    }
  }
}

/**
 * Prose that describes an area rather than a helper inside it.
 *
 * A doc comment on one function describes that function, and showing
 * "GENERATED BY THE COMMAND ABOVE; DO NOT EDIT" under "what this is" would be
 * worse than admitting there is no description: it reads as an answer while
 * telling the reader nothing.
 */
function descriptions(root: RootFacts): string[] {
  return root.evidence.items
    .filter(
      (item) =>
        item.item.kind === "readme-section" || item.item.kind === "project-description",
    )
    .map((item) => item.item.text)
    .filter((text) => text.length > 40 && text.length < 400);
}

export function gatherRecords(roots: readonly RootFacts[]): GatheredRecords {
  const buckets = emptyBuckets();
  const entitiesByRoot = new Map<string, Set<string>>();
  const descriptionsByRoot = new Map<string, readonly string[]>();
  let projectDescription: string | null = null;

  for (const root of roots) {
    sortInto(buckets, root.model, root.generatedFiles);
    descriptionsByRoot.set(root.rootName, descriptions(root));

    // Attributed to the root it came from. A multi-root workspace has no
    // single README, so quoting one part's description as the whole
    // project's would misrepresent it — saying where it came from keeps it
    // honest.
    if (projectDescription === null) {
      for (const item of root.evidence.items) {
        const usable =
          item.item.kind === "project-description" ||
          (item.item.kind === "readme-section" && item.item.text.length > 40);
        if (!usable) continue;
        projectDescription = `${item.item.text.slice(0, 400)}\n\n— ${root.rootName}`;
        break;
      }
    }
  }

  for (const entity of buckets.entities) {
    const forRoot = entitiesByRoot.get(entity.rootName) ?? new Set<string>();
    forRoot.add(entity.name);
    entitiesByRoot.set(entity.rootName, forRoot);
  }

  const entityColumns = new Map<string, Map<string, string[]>>();
  for (const field of buckets.fields) {
    const byRoot = entityColumns.get(field.entityName) ?? new Map<string, string[]>();
    byRoot.set(field.rootName, [...(byRoot.get(field.rootName) ?? []), field.name]);
    entityColumns.set(field.entityName, byRoot);
  }

  const touchedTables = new Set<string>();
  for (const access of buckets.dataAccess) {
    if (access.entity !== null) touchedTables.add(access.entity);
  }

  return {
    ...buckets,
    entityNames: new Set(buckets.entities.map((entity) => entity.name)),
    entitiesByRoot,
    entityColumns,
    touchedTables,
    descriptionsByRoot,
    projectDescription,
  };
}
