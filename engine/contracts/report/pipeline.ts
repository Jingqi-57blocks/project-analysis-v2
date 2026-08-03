/**
 * The report pipeline: how one analysis snapshot compiles into a plan of work.
 *
 * A `ReportPlan` is the whole of what a request asks for — every requested
 * `project|module × product|developer` document, each an ordered list of
 * sections, each section an ordered list of blocks. A block is one of two
 * producers: `deterministic` (rendered from facts by code) or
 * `authored-required` (prose the external Host Agent writes and must cite). The
 * engine compiles the plan and emits the authored tasks; it never calls a model.
 * That boundary is the point — the same plan runs under any host with an agent.
 *
 * Everything here is derived, so it is byte-reproducible: the plan, its task
 * ids and its digest are functions of the request, the snapshot identity and the
 * versioned generation parameters, and of nothing else. Change the model, the
 * prompt, the executor, a preset or a generator version and identity changes
 * with it; change none of them and two compiles are identical to the byte.
 *
 * This is PI-14: the contract, the registry and the deterministic compiler. The
 * bounded fact slices are named here (PI-42 fills their normalized queries); the
 * budget-controlled bundle execution is PI-80; the tri-state applicability is
 * PI-15. What is fixed here is the shape, the identity and the boundary.
 */

import { createHash } from "node:crypto";

import type { FactKind } from "../shared-fact/families.js";
import { stableStringify } from "../shared-fact/merge.js";
import { joinKey } from "../shared-fact/serialization.js";
import type { SectionApplicability } from "../shared-fact/applicability.js";
import type { BlockKind, ContentBlock } from "./blocks.js";
import { SECTION_CATALOG, type SectionDefinition } from "./catalog.js";
import { DOCUMENT_PRESETS, type DocumentPreset } from "./presets.js";
import {
  type Audience,
  type ReportRequest,
  type ReportTarget,
  type Scope,
  targetKey,
  validateRequest,
} from "./target.js";
import { type AnalysisSnapshotIdentity, snapshotKey } from "./snapshot.js";
import { REPORT_CONTRACT_VERSION } from "./version.js";

/** A block definition — the section catalog's `ContentBlock` under its contract name. */
export type ContentBlockDefinition = ContentBlock;

/** A compile-time rejection: an unregistered preset/section, a cycle, an out-of-bound slice. */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function scopeId(scope: Scope): string {
  return scope.kind === "project" ? "project" : `module:${scope.moduleId}`;
}

// ---------------------------------------------------------------------------
// Versions and policy — the identity dimensions the engine owns.
// ---------------------------------------------------------------------------

/** The three engine-owned version dimensions folded into every identity. */
export interface PipelineVersions {
  readonly pipeline: string;
  readonly preset: string;
  readonly generator: string;
}

export const PIPELINE_VERSIONS: PipelineVersions = {
  pipeline: "1.0.0",
  preset: REPORT_CONTRACT_VERSION,
  generator: "1.0.0",
};

/**
 * A versioned generation policy. V1 fixes the single internal `standard-v1`; the
 * contract is versioned so a later depth tier is a new policy, not a silent
 * change to this one. No user-facing depth knob exists in V1.
 */
export interface GenerationPolicy {
  readonly id: string;
  readonly version: string;
}

export const STANDARD_V1: GenerationPolicy = { id: "standard-v1", version: "1.0.0" };

/**
 * A pipeline preset binds a pipeline version, its generation policy and the set
 * of document presets it may compile. The registry is fail-closed against it: a
 * requested target whose preset is not listed here is rejected, never guessed.
 */
export interface PipelinePreset {
  readonly id: string;
  readonly version: string;
  readonly policy: GenerationPolicy;
  readonly documentPresetIds: readonly string[];
}

export const STANDARD_PIPELINE: PipelinePreset = {
  id: "standard",
  version: PIPELINE_VERSIONS.pipeline,
  policy: STANDARD_V1,
  documentPresetIds: DOCUMENT_PRESETS.map((p) => p.id),
};

// ---------------------------------------------------------------------------
// Prompt binding — the prompt dimension of an authored block's identity.
// ---------------------------------------------------------------------------

/** A versioned reference to the prompt an authored block is written from. */
export interface PromptBinding {
  readonly promptId: string;
  readonly promptVersion: string;
}

/**
 * How a block resolves to its prompt. The default binds a prompt per output
 * schema at the generator version — the prompts themselves are authored in later
 * M3 issues; what is fixed here is that a prompt change moves the identity.
 */
export type PromptResolver = (block: ContentBlockDefinition, section: SectionDefinition) => PromptBinding;

// ---------------------------------------------------------------------------
// The parameters a caller fixes for a run — the execution-side identity inputs.
// ---------------------------------------------------------------------------

/** A generation parameter value — kept scalar so identity stays canonical. */
export type GenerationParamValue = string | number | boolean;

export interface GenerationParams {
  /** Who runs the authored tasks — e.g. `host-agent`. Part of identity. */
  readonly executorKind: string;
  /** The model the host will use. Part of identity; a different model is a different task. */
  readonly modelId: string;
  /** The report's language. Part of identity. */
  readonly language: string;
  /** Any further generation parameters (e.g. temperature), folded into identity. */
  readonly params?: Readonly<Record<string, GenerationParamValue>>;
}

// ---------------------------------------------------------------------------
// Bounded fact slice — what a block may read, and the key PI-42 dedups on.
// ---------------------------------------------------------------------------

/**
 * The bounded set of facts a block reads. `factKinds` is the block's declared
 * input, never wider; `sliceKey` is the normalized (scope, kinds) identity two
 * documents share when they read the same slice, so PI-42 can dedup cross-document
 * queries without re-deriving them here.
 */
export interface FactSliceRef {
  readonly scope: Scope;
  readonly factKinds: readonly FactKind[];
  readonly sliceKey: string;
}

function sliceKeyOf(scope: Scope, factKinds: readonly FactKind[]): string {
  return joinKey([scopeId(scope), ...[...factKinds].sort()]);
}

/**
 * Rejects a slice that reaches past its block's declared inputs. Generated slices
 * are in-bound by construction; this guards a hand-built or evolved plan from
 * quietly widening what a block may read.
 */
export function assertSliceInBounds(block: ContentBlockDefinition, slice: FactSliceRef): void {
  const allowed = new Set<FactKind>(block.inputFactKinds);
  if (allowed.has("*")) return;
  for (const kind of slice.factKinds) {
    if (!allowed.has(kind)) {
      throw new RegistryError(`block ${block.id} slice reads fact kind ${kind} outside its declared inputs`);
    }
  }
}

// ---------------------------------------------------------------------------
// Authored task — the unit of identity, validation, accounting, attempt, retry.
// ---------------------------------------------------------------------------

/** Authored prose must cite the facts it rests on; deterministic content needs none. */
export type CitationRule = "required" | "none";

/** Every dimension whose change must change the task's identity. */
export interface TaskIdentity {
  readonly executorKind: string;
  readonly modelId: string;
  readonly promptHash: string;
  readonly pipelineVersion: string;
  readonly presetVersion: string;
  readonly generatorVersion: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly language: string;
  readonly params: Readonly<Record<string, GenerationParamValue>>;
  /**
   * The analysis this task reads. A task id must move with the snapshot, so a
   * receipt produced under a stale analysis (changed source, providers, schema
   * or config) can never be adopted for a task compiled from a newer one.
   */
  readonly snapshotKey: string;
}

export interface AuthoredBlockTask {
  /** Deterministic over identity, document, section, block and slice. */
  readonly taskId: string;
  readonly documentId: string;
  readonly sectionId: string;
  readonly blockId: string;
  readonly outputSchemaId: string;
  readonly prompt: PromptBinding;
  readonly citationRule: CitationRule;
  /** The validator contract the answer is checked against (the output schema). */
  readonly validatorId: string;
  readonly factSlice: FactSliceRef;
  readonly identity: TaskIdentity;
}

// ---------------------------------------------------------------------------
// Plan shape — blocks compose into sections, sections into documents.
// ---------------------------------------------------------------------------

export interface BlockPlan {
  readonly blockId: string;
  readonly kind: BlockKind;
  readonly outputSchemaId: string;
  readonly carriesSharedClaim: boolean;
  readonly factSlice: FactSliceRef;
  /** Present only for `authored-required` blocks; deterministic blocks carry none. */
  readonly task?: AuthoredBlockTask;
}

/** A section is reader structure: it composes and orders blocks, nothing more. */
export interface SectionPlan {
  readonly sectionId: string;
  readonly title: string;
  readonly order: number;
  /** Dependency depth — 0 with no prerequisites; the execution wave (PI-80 schedules it). */
  readonly wave: number;
  readonly successCondition: string;
  readonly blocks: readonly BlockPlan[];
}

export interface DocumentPlan {
  readonly documentId: string;
  readonly scope: Scope;
  readonly audience: Audience;
  readonly presetId: string;
  readonly sections: readonly SectionPlan[];
}

/**
 * The Host Agent's execution unit: one per document, carrying that document's
 * authored tasks. A bundle may hold many blocks but keeps each block's task
 * distinct, so every block is validated and accounted on its own. The
 * budget-controlled compilation of bundles is PI-80's; this fixes the unit.
 */
export interface ExecutionBundle {
  readonly bundleId: string;
  readonly documentId: string;
  readonly policy: GenerationPolicy;
  readonly taskIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Problem ledger — a bounded projection of facts/diagnostics, shared across docs.
// ---------------------------------------------------------------------------

export type ProblemResolution = "observed" | "inferred" | "unresolved";
export type ProblemConfidence = "high" | "medium" | "low";

/**
 * A known problem as the reports reference it — a bounded projection of the
 * fact/diagnostic base, not a second knowledge base. It records what was
 * observed and where, never a subjective priority, remediation or roadmap. Its
 * id is stable over scope, category and the sorted evidence it rests on, so the
 * same problem carries one identity into every document that cites it.
 */
export interface ProblemRecord {
  readonly problemId: string;
  readonly scope: Scope;
  readonly category: string;
  readonly resolution: ProblemResolution;
  readonly confidence: ProblemConfidence;
  /** The fact/diagnostic ids this problem is evidenced by, sorted. */
  readonly evidenceIds: readonly string[];
  /** Where the problem is cited from — fact or diagnostic ids. */
  readonly citations: readonly string[];
  /** The bounded statement of what the problem affects — factual, not advisory. */
  readonly impactBoundary: string;
}

/** Deterministic over scope, category and the sorted evidence ids — nothing else. */
export function problemId(scope: Scope, category: string, evidenceIds: readonly string[]): string {
  return digest([scopeId(scope), category, [...evidenceIds].sort()]).slice(0, 16);
}

/**
 * Dedup problem records by id and order them. Two documents projecting the same
 * problem converge on one record — the ledger is shared, so a product-only, a
 * developer-only and a both request all reference the same identity.
 */
export function buildProblemLedger(records: readonly ProblemRecord[]): readonly ProblemRecord[] {
  const byId = new Map<string, ProblemRecord>();
  for (const record of records) {
    const existing = byId.get(record.problemId);
    if (existing !== undefined) {
      // Same id, identical record: an expected duplicate, kept once. Same id but
      // differing non-id fields (resolution/confidence/citations/impactBoundary):
      // two sources describe one problem divergently — fail closed rather than let
      // input order pick a winner and skew the shared ledger and the plan digest.
      if (stableStringify(existing) !== stableStringify(record)) {
        throw new RegistryError(`conflicting problem records share id ${record.problemId}`);
      }
      continue;
    }
    byId.set(record.problemId, record);
  }
  return [...byId.values()].sort((a, b) => (a.problemId < b.problemId ? -1 : a.problemId > b.problemId ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Run identity and the plan itself.
// ---------------------------------------------------------------------------

export interface RunIdentity {
  readonly contractVersion: string;
  readonly pipelineId: string;
  readonly pipelineVersion: string;
  readonly presetVersion: string;
  readonly generatorVersion: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly executorKind: string;
  readonly modelId: string;
  readonly language: string;
  readonly params: Readonly<Record<string, GenerationParamValue>>;
  readonly snapshotKey: string;
}

export interface ReportPlan {
  readonly runIdentity: RunIdentity;
  readonly snapshot: AnalysisSnapshotIdentity;
  readonly policy: GenerationPolicy;
  readonly documents: readonly DocumentPlan[];
  readonly bundles: readonly ExecutionBundle[];
  readonly problemLedger: readonly ProblemRecord[];
  /** Byte-stable digest of the whole plan — equal inputs and versions, equal digest. */
  readonly planDigest: string;
}

// ---------------------------------------------------------------------------
// Registry validation — fail closed.
// ---------------------------------------------------------------------------

function assertSectionSound(section: SectionDefinition): void {
  if (section.blocks.length === 0) throw new RegistryError(`section ${section.id} has no blocks`);
  const union = new Set<FactKind>(section.inputFactKinds);
  const seen = new Set<string>();
  for (const block of section.blocks) {
    if (seen.has(block.id)) throw new RegistryError(`section ${section.id} has duplicate block ${block.id}`);
    seen.add(block.id);
    if (block.outputSchemaId.length === 0) throw new RegistryError(`block ${block.id} has no output schema`);
    for (const kind of block.inputFactKinds) {
      if (!union.has(kind)) {
        throw new RegistryError(`block ${block.id} reads fact kind ${kind} outside section ${section.id}`);
      }
    }
  }
}

/**
 * Depth-first cycle detection over the section dependency graph. Rejects a
 * dependency on an unknown section and any cycle, naming the path — a plan whose
 * sections cannot be linearised must not compile.
 */
function assertAcyclic(
  dependencies: Readonly<Record<string, readonly string[]>>,
  known: ReadonlySet<string>,
): void {
  const state = new Map<string, "open" | "closed">();
  const visit = (id: string, stack: readonly string[]): void => {
    if (!known.has(id)) throw new RegistryError(`section dependency references unknown section ${id}`);
    const s = state.get(id);
    if (s === "closed") return;
    if (s === "open") throw new RegistryError(`cyclic section dependency: ${[...stack, id].join(" -> ")}`);
    state.set(id, "open");
    for (const next of dependencies[id] ?? []) visit(next, [...stack, id]);
    state.set(id, "closed");
  };
  for (const id of Object.keys(dependencies)) visit(id, []);
}

function waveOf(
  id: string,
  dependencies: Readonly<Record<string, readonly string[]>>,
  memo: Map<string, number>,
): number {
  const cached = memo.get(id);
  if (cached !== undefined) return cached;
  const prereqs = dependencies[id] ?? [];
  const wave = prereqs.length === 0 ? 0 : 1 + Math.max(...prereqs.map((p) => waveOf(p, dependencies, memo)));
  memo.set(id, wave);
  return wave;
}

// ---------------------------------------------------------------------------
// The compiler.
// ---------------------------------------------------------------------------

export interface CompileOptions {
  readonly request: ReportRequest;
  readonly snapshot: AnalysisSnapshotIdentity;
  readonly params: GenerationParams;
  /**
   * Overrides for the preset/generator versions. The pipeline version is owned by
   * the pipeline preset (a different pipeline is a different `PipelinePreset`), so
   * it is not overridable here — only these two are.
   */
  readonly versions?: Partial<Omit<PipelineVersions, "pipeline">>;
  readonly pipeline?: PipelinePreset;
  readonly catalog?: readonly SectionDefinition[];
  readonly presets?: readonly DocumentPreset[];
  readonly promptResolver?: PromptResolver;
  /** Tri-state applicability (PI-15). Default includes every section. */
  readonly applicability?: (target: ReportTarget, section: SectionDefinition) => SectionApplicability;
  /** Section dependency edges — validated acyclic; default none (V1 sections are independent). */
  readonly dependencies?: Readonly<Record<string, readonly string[]>>;
  /** Problem records projected from diagnostics; deduped into the shared ledger. */
  readonly problems?: readonly ProblemRecord[];
}

/**
 * Compile one request into one plan. Deterministic and fail-closed: the request
 * must be legal, every preset registered, every section sound and registered,
 * the dependency graph acyclic, and every slice in-bound. Documents are ordered
 * by identity so the plan does not depend on the order targets were requested;
 * an unrequested target gets no document, task or bundle.
 */
export function compileReportPlan(options: CompileOptions): ReportPlan {
  const requestValidation = validateRequest(options.request);
  if (!requestValidation.ok) throw new RegistryError(requestValidation.reason);

  const pipeline = options.pipeline ?? STANDARD_PIPELINE;
  // The pipeline preset owns the pipeline version; preset/generator may be
  // overridden (to prove identity moves with them), pipeline follows the preset.
  const effectiveVersions: PipelineVersions = {
    ...PIPELINE_VERSIONS,
    ...options.versions,
    pipeline: pipeline.version,
  };
  const policy = pipeline.policy;
  const catalog = options.catalog ?? SECTION_CATALOG;
  const presets = options.presets ?? DOCUMENT_PRESETS;
  const resolvePrompt: PromptResolver =
    options.promptResolver ?? ((block) => ({ promptId: block.outputSchemaId, promptVersion: effectiveVersions.generator }));
  const applicabilityOf =
    options.applicability ?? ((): SectionApplicability => "included");
  const dependencies = options.dependencies ?? {};
  const snapKey = snapshotKey(options.snapshot);

  for (const section of catalog) assertSectionSound(section);
  // The provided catalog is authoritative for what compiles, not the module
  // global — a preset resolves its section ids against this map, so validation
  // and output read one catalog and a custom catalog can add real sections.
  const sectionMap = new Map(catalog.map((s) => [s.id, s] as const));
  assertAcyclic(dependencies, new Set(sectionMap.keys()));
  const waveMemo = new Map<string, number>();

  const presetById = new Map(presets.map((p) => [p.id, p] as const));
  const registeredPreset = new Set(pipeline.documentPresetIds);

  const presetFor = (target: ReportTarget): DocumentPreset => {
    const match = presets.find((p) => p.scope === target.scope.kind && p.audience === target.audience);
    if (!match) throw new RegistryError(`no document preset for ${target.scope.kind}/${target.audience}`);
    if (!registeredPreset.has(match.id) || !presetById.has(match.id)) {
      throw new RegistryError(`document preset ${match.id} is not registered with pipeline ${pipeline.id}`);
    }
    return match;
  };

  // A stable, order-independent document order: sort requested targets by key.
  const targets = [...options.request].sort((a, b) => (targetKey(a) < targetKey(b) ? -1 : 1));

  const documents: DocumentPlan[] = [];
  const bundles: ExecutionBundle[] = [];

  for (const target of targets) {
    const documentId = targetKey(target);
    const preset = presetFor(target);
    // Reader order: required sections, then optional. Each id resolves against
    // the provided catalog; an unknown id fails closed.
    const ordered = [...preset.requiredSectionIds, ...preset.optionalSectionIds].map((id) => {
      const section = sectionMap.get(id);
      if (!section) throw new RegistryError(`preset ${preset.id} references unknown section ${id}`);
      return section;
    });

    const sections: SectionPlan[] = [];
    let order = 0;
    for (const section of ordered) {
      if (applicabilityOf(target, section) === "not-applicable") continue;

      const blocks: BlockPlan[] = section.blocks.map((block) => {
        const slice: FactSliceRef = {
          scope: target.scope,
          factKinds: block.inputFactKinds,
          sliceKey: sliceKeyOf(target.scope, block.inputFactKinds),
        };
        assertSliceInBounds(block, slice);

        if (block.kind === "deterministic") {
          return {
            blockId: block.id,
            kind: block.kind,
            outputSchemaId: block.outputSchemaId,
            carriesSharedClaim: block.carriesSharedClaim,
            factSlice: slice,
          };
        }

        const prompt = resolvePrompt(block, section);
        const promptHash = digest({
          promptId: prompt.promptId,
          promptVersion: prompt.promptVersion,
          blockId: block.id,
          outputSchemaId: block.outputSchemaId,
          language: options.params.language,
        });
        const identity: TaskIdentity = {
          executorKind: options.params.executorKind,
          modelId: options.params.modelId,
          promptHash,
          pipelineVersion: effectiveVersions.pipeline,
          presetVersion: effectiveVersions.preset,
          generatorVersion: effectiveVersions.generator,
          policyId: policy.id,
          policyVersion: policy.version,
          language: options.params.language,
          params: options.params.params ?? {},
          snapshotKey: snapKey,
        };
        const task: AuthoredBlockTask = {
          taskId: digest({ identity, documentId, sectionId: section.id, blockId: block.id, factSlice: slice }),
          documentId,
          sectionId: section.id,
          blockId: block.id,
          outputSchemaId: block.outputSchemaId,
          prompt,
          citationRule: "required",
          validatorId: block.outputSchemaId,
          factSlice: slice,
          identity,
        };
        return {
          blockId: block.id,
          kind: block.kind,
          outputSchemaId: block.outputSchemaId,
          carriesSharedClaim: block.carriesSharedClaim,
          factSlice: slice,
          task,
        };
      });

      sections.push({
        sectionId: section.id,
        title: section.title,
        order: order++,
        wave: waveOf(section.id, dependencies, waveMemo),
        successCondition: section.successCondition,
        blocks,
      });
    }

    const taskIds = sections.flatMap((s) => s.blocks.map((b) => b.task?.taskId).filter((id): id is string => id !== undefined));
    documents.push({ documentId, scope: target.scope, audience: target.audience, presetId: preset.id, sections });
    bundles.push({ bundleId: digest({ documentId, taskIds, policy, snapshotKey: snapKey }), documentId, policy, taskIds });
  }

  const problemLedger = buildProblemLedger(options.problems ?? []);

  const runIdentity: RunIdentity = {
    contractVersion: REPORT_CONTRACT_VERSION,
    pipelineId: pipeline.id,
    pipelineVersion: effectiveVersions.pipeline,
    presetVersion: effectiveVersions.preset,
    generatorVersion: effectiveVersions.generator,
    policyId: policy.id,
    policyVersion: policy.version,
    executorKind: options.params.executorKind,
    modelId: options.params.modelId,
    language: options.params.language,
    params: options.params.params ?? {},
    snapshotKey: snapKey,
  };

  const planDigest = digest({ runIdentity, snapshot: options.snapshot, policy, documents, bundles, problemLedger });
  return { runIdentity, snapshot: options.snapshot, policy, documents, bundles, problemLedger, planDigest };
}

/** Every authored task in a plan, in document then section then block order. */
export function authoredTasks(plan: ReportPlan): readonly AuthoredBlockTask[] {
  return plan.documents.flatMap((doc) =>
    doc.sections.flatMap((section) =>
      section.blocks.map((block) => block.task).filter((task): task is AuthoredBlockTask => task !== undefined),
    ),
  );
}

// ---------------------------------------------------------------------------
// Execution boundary — the Host Agent runs tasks; the engine records receipts.
// ---------------------------------------------------------------------------

export type AttemptOutcome = "accepted" | "rejected" | "failed";

/**
 * One attempt at one task, as recorded after the Host Agent ran it. The engine
 * writes these; it never executes the task itself. Retries append — the receipt
 * chain is the audit trail, and a rejected or failed attempt is kept, not
 * overwritten.
 */
export interface AttemptReceipt {
  readonly taskId: string;
  readonly attempt: number;
  readonly executorKind: string;
  readonly modelId: string;
  readonly outcome: AttemptOutcome;
  /** Where the produced artifact landed, or null when the attempt produced none. */
  readonly artifactRef: string | null;
  readonly validationOk: boolean;
  readonly detail: string;
}

export interface TaskLedger {
  readonly taskId: string;
  readonly attempts: readonly AttemptReceipt[];
}

export function emptyLedger(taskId: string): TaskLedger {
  return { taskId, attempts: [] };
}

/**
 * Append an attempt, numbering it after the ones already recorded. The receipt
 * must be for this task; a new attempt never rewrites a prior one, so the chain
 * stays a full history a later reader can audit.
 */
export function recordAttempt(
  ledger: TaskLedger,
  receipt: Omit<AttemptReceipt, "attempt">,
): TaskLedger {
  if (receipt.taskId !== ledger.taskId) {
    throw new Error(`attempt for task ${receipt.taskId} cannot be recorded on ledger ${ledger.taskId}`);
  }
  const attempt = ledger.attempts.length + 1;
  return { taskId: ledger.taskId, attempts: [...ledger.attempts, { ...receipt, attempt }] };
}

/**
 * The attempt a run adopts: the last accepted, validated one, or null when none
 * was accepted. This seam only locates the adopted attempt; whether a required
 * authored block with no adopted attempt leaves the run incomplete — and the
 * partial-artifact-versus-placeholder rule — is decided downstream (PI-80), not here.
 */
export function adoptedAttempt(ledger: TaskLedger): AttemptReceipt | null {
  for (let i = ledger.attempts.length - 1; i >= 0; i -= 1) {
    const receipt = ledger.attempts[i]!;
    if (receipt.outcome === "accepted" && receipt.validationOk) return receipt;
  }
  return null;
}

/**
 * The execution seam the engine compiles against but never crosses: a Host Agent
 * runs a task and reports how it went. The engine calls no model; a fake host in
 * a test satisfies this interface exactly as a real one does.
 */
export interface HostAgent {
  execute(task: AuthoredBlockTask): Omit<AttemptReceipt, "attempt" | "taskId">;
}
