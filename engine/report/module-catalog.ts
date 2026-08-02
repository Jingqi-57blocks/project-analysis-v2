/**
 * Report-facing module discovery and classification.
 *
 * Generic formation supplies raw route modules, technical components and
 * external boundaries. This adapter enriches that bounded list with facts from
 * the frozen KB, asks one classifier to label it, and reuses the persisted JSON
 * while its candidate digest and classifier identity remain unchanged.
 */

import type { ClassifierIdentity, ClassifiedCandidate, ModuleClassificationArtifact } from "../contracts/module-classification/schema.js";
import type { Store } from "../store/types.js";
import type { KnowledgeBase } from "../kb/query.js";
import { type CandidateInput, generateModuleCandidates } from "../modules/candidates.js";
import { classifyModuleCandidates, type ClassifyOutcome } from "../modules/classify.js";
import { runJsonAgent, type JsonAgentIdentity, type JsonAgentRunner } from "../host/json-agent.js";
import {
  createSliceReaders,
  resolveModuleMembershipForModules,
  resolveSliceFacts,
  type CitedFact,
  type ModuleMembership,
} from "./slice-resolve.js";
import { moduleScope } from "../contracts/report/target.js";

const CLASSIFIER_CONTRACT_VERSION = "report-module-classifier.v6";
const MAX_CLASSIFIER_PROMPT_BYTES = 120_000;

function unique(values: Iterable<string>, cap: number): readonly string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))].sort().slice(0, cap);
}

function objectValue(fact: CitedFact): Record<string, unknown> | null {
  return typeof fact.value === "object" && fact.value !== null ? fact.value as Record<string, unknown> : null;
}

function stringField(fact: CitedFact, field: string): string | null {
  const value = objectValue(fact)?.[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function moduleContext(store: Store, kb: KnowledgeBase, moduleId: string) {
  const membership = resolveModuleMembershipForModules(kb, moduleId, [moduleId]);
  const readers = createSliceReaders(store, kb.snapshot.id, membership);
  const scope = moduleScope(moduleId);
  const facts = resolveSliceFacts(readers, scope, [
    "feature-flow",
    "data-access",
    "outbound-call",
    "ui-label",
    "doc-comment",
  ]);
  const ofKind = (kind: string): readonly CitedFact[] => facts.filter((fact) => fact.kind === kind);
  return {
    featureNames: unique(ofKind("feature-flow").map((fact) => stringField(fact, "featureName") ?? ""), 8),
    filePaths: unique(membership.files, 8),
    entityNames: unique(ofKind("data-access").map((fact) => stringField(fact, "entity") ?? ""), 6),
    outboundTargets: unique(ofKind("outbound-call").map((fact) => stringField(fact, "target") ?? ""), 6),
    uiLabels: unique(ofKind("ui-label").map((fact) => stringField(fact, "text") ?? ""), 6),
    evidenceRefs: unique(facts.map((fact) => fact.factId), 3),
  };
}

/** The exact bounded candidate input classified for this snapshot. */
export function reportModuleCandidateInput(store: Store, kb: KnowledgeBase): CandidateInput {
  const modules = kb.modules();
  const contextByCandidateId = Object.fromEntries(
    modules.map((module) => [module.id, moduleContext(store, kb, module.id)] as const),
  );
  const externalSystems = kb
    .mapEdges()
    .filter((edge) => edge.kind === "external")
    .map((edge) => ({
      key: edge.to,
      displayNameCandidates: [edge.to],
      targets: [edge.to],
      evidenceRefs: [`fact:map-edge:${edge.from}:${edge.to}`],
      reason: `the frozen workspace map records an external boundary from ${edge.from}`,
    }));
  return { modules, components: kb.components(), externalSystems, contextByCandidateId };
}

interface ClassificationResponse {
  readonly candidates: readonly {
    readonly candidateId: string;
    readonly classification: "product-module" | "aggregate-surface" | "technical-component" | "external-system" | "infrastructure" | "unresolved";
    readonly confidence: number;
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
    readonly displayName: string;
    readonly summary: string;
    readonly group: string;
    readonly includedCandidateIds: readonly string[];
  }[];
}

const CLASSIFICATION_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "candidateId",
          "classification",
          "confidence",
          "reason",
          "evidenceRefs",
          "displayName",
          "summary",
          "group",
          "includedCandidateIds",
        ],
        properties: {
          candidateId: { type: "string" },
          classification: {
            type: "string",
            enum: ["product-module", "aggregate-surface", "technical-component", "external-system", "infrastructure", "unresolved"],
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
          displayName: { type: "string" },
          summary: { type: "string" },
          group: { type: "string" },
          includedCandidateIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

function classifierPrompt(candidates: ReturnType<typeof generateModuleCandidates>, language: string, correction: string | null): string {
  const outputLanguage = language.toLowerCase().startsWith("zh") ? "简体中文" : language;
  return [
    "You classify a bounded list of project-analysis module candidates. Use only the supplied JSON; do not inspect files or run tools.",
    "Classify by structural evidence, entry surfaces, business objects, relations and UI labels, never by a vendor keyword table.",
    "Labels:",
    "- product-module: a cohesive user-facing business capability worthy of its own report.",
    "- aggregate-surface: a dashboard, approval center, report/list facade, or route surface that aggregates other capabilities.",
    "- technical-component: an internal technical unit useful to developers but not a product capability.",
    "- external-system: a dependency outside the analyzed roots.",
    "- infrastructure: authentication, plumbing, jobs, download/config/support infrastructure without an independent business capability.",
    "- unresolved: evidence is insufficient.",
    "For every candidate, write a non-empty reader-facing displayName, one-sentence summary, and broad group in " + outputLanguage + ". Product modules use business language; other labels state their structural role without promoting them to product capabilities.",
    "Do not create duplicate product modules for two route surfaces of the same capability. Choose the best canonical candidate, put genuine supporting formed-module ids in includedCandidateIds, and label the supporting surface by its actual aggregate/technical/infrastructure role. Identity or access with its own user-visible flows may be a product module; authentication plumbing without an independent user path is infrastructure.",
    "Use aggregate-surface only for a presentation or navigation facade: dashboards, read-only lists, reports, search, or a shallow dispatcher. A candidate that accepts submissions and owns approval, rejection, cancellation, state transitions, validations, or other end-to-end workflow behaviour is a product-module even when it unifies several business subtypes.",
    "A settings, connector, sync, search or credential surface whose purpose is configuring or invoking one external provider is infrastructure, not a product module, unless the supplied evidence shows an independent end-to-end user outcome beyond that provider.",
    "includedCandidateIds may name supporting formed-module candidates that are genuinely part of the same capability. Never include external-system, infrastructure, or unrelated aggregate candidates. Otherwise return an empty array.",
    "Use only evidenceRefs present on that same candidate; one valid ref is enough. Return every candidate exactly once.",
    correction === null ? "" : `The previous response was unusable. Correct this problem:\n${correction}`,
    "Candidate input:",
    JSON.stringify(candidates),
  ].filter(Boolean).join("\n\n");
}

export interface ClassifyReportModulesOptions {
  readonly store: Store;
  readonly kb: KnowledgeBase;
  readonly runDir: string;
  readonly language: string;
  readonly agent: JsonAgentIdentity;
  readonly run?: JsonAgentRunner<ClassificationResponse>;
}

export interface ReportModuleClassification extends ClassifyOutcome {
  readonly input: CandidateInput;
  readonly boundedCandidates: ReturnType<typeof generateModuleCandidates>;
  readonly classifierCalls: number;
  readonly classifierInputBytes: number;
  readonly classifierOutputBytes: number;
}

export async function classifyReportModules(options: ClassifyReportModulesOptions): Promise<ReportModuleClassification> {
  const input = reportModuleCandidateInput(options.store, options.kb);
  const boundedCandidates = generateModuleCandidates(input);
  const moduleIds = new Set(input.modules.map((module) => module.id));
  const componentIds = new Set(input.components.map((component) => component.id));
  let classifierCalls = 0;
  let classifierInputBytes = 0;
  let classifierOutputBytes = 0;
  const classifier: ClassifierIdentity = {
    executor: options.agent.executor,
    // Reader-facing names and summaries are part of the classification output,
    // so the requested language must participate in reuse identity as well.
    model: `${options.agent.model}@reasoning=${options.agent.reasoningEffort}@language=${options.language}`,
    contractVersion: CLASSIFIER_CONTRACT_VERSION,
  };
  const outcome = await classifyModuleCandidates(input, {
    runDir: options.runDir,
    sourceSnapshotId: options.kb.snapshot.identity,
    classifier,
    classify: async (candidates) => {
      // Technical components and observed external boundaries are already typed
      // by structural formation. The expensive judgement is only whether a formed
      // route/module candidate is a product capability, an aggregate surface,
      // infrastructure or an external client accidentally shaped like a module.
      // Sending known components and boundaries again added no information and
      // more than doubled the WCP classifier prompt.
      const judged = candidates.filter((candidate) => moduleIds.has(candidate.candidateId));
      let classifiedModules: readonly ClassifiedCandidate[] | null = null;
      let correction: string | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        classifierCalls += 1;
        const prompt = classifierPrompt(judged, options.language, correction);
        const promptBytes = Buffer.byteLength(prompt, "utf8");
        if (promptBytes > MAX_CLASSIFIER_PROMPT_BYTES) {
          throw new Error(`module classifier input is ${promptBytes} bytes; bounded V1 limit is ${MAX_CLASSIFIER_PROMPT_BYTES}`);
        }
        classifierInputBytes += promptBytes;
        const response = await runJsonAgent<ClassificationResponse>({
          prompt,
          schema: CLASSIFICATION_SCHEMA,
          identity: options.agent,
          ...(options.run === undefined ? {} : { run: options.run }),
        });
        classifierOutputBytes += Buffer.byteLength(JSON.stringify(response), "utf8");
        const foreign = response.candidates.filter((candidate) => !moduleIds.has(candidate.candidateId));
        if (foreign.length > 0) throw new Error(`module classifier returned non-module candidate(s): ${foreign.map((candidate) => candidate.candidateId).join(", ")}`);
        const current = response.candidates.map((candidate): ClassifiedCandidate => ({
          ...candidate,
          status: candidate.classification === "unresolved" ? "unresolved" : "classified",
        }));
        if (current.some((candidate) => candidate.classification === "product-module")) {
          classifiedModules = current;
          break;
        }
        correction = `All ${current.length} returned module candidates were non-product or unresolved. The supplied list contains formed route/workflow modules; identify every evidenced cohesive user-facing capability as product-module, while keeping technical, aggregate and infrastructure candidates in their proper classes. Do not promote candidates without evidence.`;
      }
      if (classifiedModules === null) throw new Error("module classifier produced no product modules after 2 attempts");
      const fixed = candidates
        .filter((candidate) => !moduleIds.has(candidate.candidateId))
        .map((candidate): ClassifiedCandidate => {
          const technical = componentIds.has(candidate.candidateId);
          const displayName = candidate.displayNameCandidates[0] ?? candidate.candidateId;
          return {
            candidateId: candidate.candidateId,
            classification: technical ? "technical-component" : "external-system",
            confidence: 1,
            reason: technical
              ? "structural formation identified this candidate as a technical component"
              : "the frozen workspace map identified this candidate beyond an external boundary",
            evidenceRefs: candidate.evidenceRefs.slice(0, 1),
            status: "classified",
            displayName,
            summary: technical ? `${displayName} 是源码中的技术组成。` : `${displayName} 是项目调用的外部边界。`,
            group: technical ? "技术组成" : "外部依赖",
            includedCandidateIds: [],
          };
        });
      return [...classifiedModules, ...fixed];
    },
  });
  return { ...outcome, input, boundedCandidates, classifierCalls, classifierInputBytes, classifierOutputBytes };
}

export interface ReportModule {
  readonly id: string;
  readonly sourceCandidateIds: readonly string[];
  /** Entries owned by another canonical report scope; cross-surface closure may not absorb them. */
  readonly excludedEntryKeys?: readonly string[];
  readonly rawNames: readonly string[];
  readonly displayName: string;
  readonly summary: string;
  readonly group: string;
  readonly confidence: number;
}

function reportModulesOfClass(
  classification: ModuleClassificationArtifact,
  input: CandidateInput,
  accepted: ReadonlySet<string>,
): readonly ReportModule[] {
  const moduleName = new Map(input.modules.map((module) => [module.id, module.name] as const));
  const classificationById = new Map(
    classification.candidates.map((candidate) => [candidate.candidateId, candidate] as const),
  );
  const supportingClasses = new Set(["product-module", "aggregate-surface", "technical-component"]);
  const reportBoundaryClasses = new Set(["product-module", "aggregate-surface"]);
  const entriesByModuleId = new Map(input.modules.map((module) => [module.id, module.entryKeys] as const));
  const reportBoundaryIds = new Set<string>();
  for (const candidate of classification.candidates) {
    if (candidate.status !== "classified" || !reportBoundaryClasses.has(candidate.classification ?? "")) continue;
    if (moduleName.has(candidate.candidateId)) reportBoundaryIds.add(candidate.candidateId);
    for (const includedId of candidate.includedCandidateIds ?? []) {
      if (moduleName.has(includedId)) reportBoundaryIds.add(includedId);
    }
  }
  return classification.candidates
    .filter((candidate) => candidate.status === "classified" && accepted.has(candidate.classification ?? ""))
    .map((candidate) => {
      const included = unique(candidate.includedCandidateIds ?? [], 20).filter((id) => {
        if (!moduleName.has(id)) return false;
        const support = classificationById.get(id);
        return support?.status === "classified" && supportingClasses.has(support.classification ?? "");
      });
      const sourceCandidateIds = unique([candidate.candidateId, ...included], 21).filter((id) => moduleName.has(id));
      const rawNames = sourceCandidateIds.map((id) => moduleName.get(id)!).sort();
      const excludedEntryKeys = unique(
        [...reportBoundaryIds]
          .filter((id) => !sourceCandidateIds.includes(id))
          .flatMap((id) => entriesByModuleId.get(id) ?? []),
        2_000,
      );
      return {
        id: candidate.candidateId,
        sourceCandidateIds,
        excludedEntryKeys,
        rawNames,
        displayName: candidate.displayName ?? rawNames[0] ?? candidate.candidateId,
        summary: candidate.summary ?? candidate.reason,
        group: candidate.group ?? "其他",
        confidence: candidate.confidence,
      };
    })
    .filter((module) => module.sourceCandidateIds.length > 0)
    .sort((a, b) => a.group.localeCompare(b.group) || a.displayName.localeCompare(b.displayName));
}

/** Product modules only; external/infrastructure candidates stay outside the report nav. */
export function productReportModules(
  classification: ModuleClassificationArtifact,
  input: CandidateInput,
): readonly ReportModule[] {
  return reportModulesOfClass(classification, input, new Set(["product-module"]));
}

/**
 * Bounded scopes that may be requested explicitly.
 *
 * An aggregate surface is not promoted to a product module in the overview,
 * but it still has canonical source membership and can own a useful detail
 * report when the caller names it. External systems, infrastructure and raw
 * technical components remain ineligible.
 */
export function reportableReportModules(
  classification: ModuleClassificationArtifact,
  input: CandidateInput,
): readonly ReportModule[] {
  return reportModulesOfClass(
    classification,
    input,
    new Set(["product-module", "aggregate-surface"]),
  );
}

export function membershipForReportModule(kb: KnowledgeBase, module: ReportModule): ModuleMembership {
  return resolveModuleMembershipForModules(
    kb,
    module.id,
    module.sourceCandidateIds,
    {
      expandObservedSurface: true,
      preferObservedEntries: true,
      excludedEntryKeys: new Set(module.excludedEntryKeys ?? []),
    },
  );
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/s$/, "");
}

/** Resolve a CLI name such as "leave" or "worklogs" to the classified canonical id. */
export function findReportModule(modules: readonly ReportModule[], requested: string): ReportModule | null {
  const target = normalizedName(requested);
  return modules.find((module) =>
    module.id === requested ||
    normalizedName(module.displayName) === target ||
    module.rawNames.some((name) => normalizedName(name) === target),
  ) ?? null;
}
