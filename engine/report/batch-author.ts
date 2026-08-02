/**
 * Parallel preparation for authored report blocks.
 *
 * The compiled plan owns one task per authored block. Each model call receives
 * exactly one task and only that task's bounded facts, so a model cannot cite a
 * neighbouring section by accident. Tasks run with bounded concurrency and are
 * cached independently, then this adapter exposes a synchronous ProseAuthor map
 * to the existing execution/validation seam. Facts are resolved once from the
 * frozen KB; no task or retry re-reads source.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ReportPlan } from "../contracts/report/pipeline.js";
import { stableStringify } from "../contracts/shared-fact/merge.js";
import { runJsonAgent, type JsonAgentIdentity, type JsonAgentRunner } from "../host/json-agent.js";
import type { AuthoredPromptContract, AuthoringRequest } from "./author-prompt.js";
import { buildAuthoringRequests, citedFactLine } from "./author-prompt.js";
import type { ProseAuthor } from "./authoring-host.js";
import type { DecisionIndex } from "./deterministic-content.js";
import { validateGrounding } from "./grounding.js";
import type { CitedFact, SliceReaders } from "./slice-resolve.js";

const BATCH_SCHEMA_VERSION = "authored-task.v10";
const MAX_TASK_PROMPT_BYTES = 160_000;

function promptPolicyVersion(blockId: string): string {
  if (blockId === "module-flows-branches.flows" || blockId === "project-roles-flows.paths") return "flow-policy.v5";
  if (blockId === "module-flows-branches.lifecycle") return "lifecycle-policy.v3";
  if (blockId === "known-issues.impact") return "issue-policy.v4";
  return "base-policy.v1";
}

export interface StructuredFlowStep {
  readonly label: string;
  readonly detail: string;
  readonly factIds: readonly string[];
}

export interface StructuredFlowBranch {
  /** One-based step index after which this branch occurs. */
  readonly afterStep: number;
  readonly condition: string;
  readonly outcome: string;
  readonly kind: "success" | "rejection" | "conditional" | "exception" | "unknown";
  readonly factIds: readonly string[];
}

export interface StructuredLifecycleNode {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly kind: "start" | "action" | "state" | "decision" | "terminal" | "unknown";
  readonly factIds: readonly string[];
}

export interface StructuredLifecycleEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly kind: "normal" | "conditional" | "rejection" | "recovery" | "unknown";
  readonly factIds: readonly string[];
}

export interface StructuredLifecycle {
  readonly title: string;
  readonly summary: string;
  readonly nodes: readonly StructuredLifecycleNode[];
  readonly edges: readonly StructuredLifecycleEdge[];
}

export interface StructuredVariantRule {
  readonly condition: string;
  readonly outcome: string;
  readonly factIds: readonly string[];
}

export interface StructuredVariantGroup {
  readonly title: string;
  readonly summary: string;
  readonly rules: readonly StructuredVariantRule[];
}

export interface StructuredFlowGroup {
  readonly title: string;
  readonly summary: string;
  readonly factIds: readonly string[];
  readonly steps: readonly StructuredFlowStep[];
  readonly branches: readonly StructuredFlowBranch[];
}

export interface StructuredIssue {
  readonly title: string;
  readonly observation: string;
  readonly impact: string;
  readonly status: "confirmed" | "needs-confirmation";
  readonly factIds: readonly string[];
}

export interface StructuredTaskArtifact {
  readonly taskId: string;
  readonly markdown: string;
  readonly flowGroups: readonly StructuredFlowGroup[];
  readonly lifecycles: readonly StructuredLifecycle[];
  readonly variantGroups: readonly StructuredVariantGroup[];
  readonly issues: readonly StructuredIssue[];
}

interface StructuredClaim {
  /** Reader-facing business statement without citation markup. */
  readonly text: string;
  /** Facts that support the complete statement. */
  readonly factIds: readonly string[];
}

interface AgentTaskArtifact {
  readonly taskId: string;
  readonly claims: readonly StructuredClaim[];
  readonly flowGroups: readonly StructuredFlowGroup[];
  readonly lifecycles: readonly StructuredLifecycle[];
  readonly variantGroups: readonly StructuredVariantGroup[];
  readonly issues: readonly StructuredIssue[];
}

interface BatchResponse {
  readonly tasks: readonly AgentTaskArtifact[];
}

const BATCH_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "claims", "flowGroups", "lifecycles", "variantGroups", "issues"],
        properties: {
          taskId: { type: "string" },
          claims: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "factIds"],
              properties: {
                text: { type: "string" },
                factIds: { type: "array", minItems: 1, items: { type: "string" } },
              },
            },
          },
          flowGroups: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "summary", "factIds", "steps", "branches"],
              properties: {
                title: { type: "string" },
                summary: { type: "string" },
                factIds: { type: "array", items: { type: "string" } },
                steps: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["label", "detail", "factIds"],
                    properties: {
                      label: { type: "string" },
                      detail: { type: "string" },
                      factIds: { type: "array", items: { type: "string" } },
                    },
                  },
                },
                branches: {
                  type: "array",
                  maxItems: 10,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["afterStep", "condition", "outcome", "kind", "factIds"],
                    properties: {
                      afterStep: { type: "integer", minimum: 1 },
                      condition: { type: "string" },
                      outcome: { type: "string" },
                      kind: { type: "string", enum: ["success", "rejection", "conditional", "exception", "unknown"] },
                      factIds: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
          lifecycles: {
            type: "array",
            maxItems: 4,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "summary", "nodes", "edges"],
              properties: {
                title: { type: "string" },
                summary: { type: "string" },
                nodes: {
                  type: "array",
                  minItems: 2,
                  maxItems: 18,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "label", "detail", "kind", "factIds"],
                    properties: {
                      id: { type: "string" },
                      label: { type: "string" },
                      detail: { type: "string" },
                      kind: { type: "string", enum: ["start", "action", "state", "decision", "terminal", "unknown"] },
                      factIds: { type: "array", minItems: 1, items: { type: "string" } },
                    },
                  },
                },
                edges: {
                  type: "array",
                  minItems: 1,
                  maxItems: 28,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["from", "to", "label", "kind", "factIds"],
                    properties: {
                      from: { type: "string" },
                      to: { type: "string" },
                      label: { type: "string" },
                      kind: { type: "string", enum: ["normal", "conditional", "rejection", "recovery", "unknown"] },
                      factIds: { type: "array", minItems: 1, items: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
          variantGroups: {
            type: "array",
            maxItems: 14,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "summary", "rules"],
              properties: {
                title: { type: "string" },
                summary: { type: "string" },
                rules: {
                  type: "array",
                  minItems: 1,
                  maxItems: 16,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["condition", "outcome", "factIds"],
                    properties: {
                      condition: { type: "string" },
                      outcome: { type: "string" },
                      factIds: { type: "array", minItems: 1, items: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
          issues: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "observation", "impact", "status", "factIds"],
              properties: {
                title: { type: "string" },
                observation: { type: "string" },
                impact: { type: "string" },
                status: { type: "string", enum: ["confirmed", "needs-confirmation"] },
                factIds: { type: "array", minItems: 1, items: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
};

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function capForKind(kind: string): number {
  switch (kind) {
    case "feature-flow": return 100;
    case "route": return 24;
    case "module":
    case "feature": return 40;
    case "ui-label":
    case "doc-comment": return 24;
    case "state-transition":
    case "state":
    case "value-set": return 40;
    case "condition":
      return 20;
    case "decision": return 16;
    case "guard": return 24;
    case "business-rule": return 40;
    case "source-excerpt": return 24;
    default: return 30;
  }
}

function factObject(fact: CitedFact): Readonly<Record<string, unknown>> {
  return typeof fact.value === "object" && fact.value !== null
    ? fact.value as Readonly<Record<string, unknown>>
    : {};
}

function sourceText(fact: CitedFact): string {
  const value = factObject(fact).text;
  return typeof value === "string" ? value : "";
}

function sourceLabel(fact: CitedFact): string {
  const value = factObject(fact).label;
  return typeof value === "string" ? value : "";
}

function normalizedToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function relatedLabel(left: string, right: string): boolean {
  if (left.length < 4 || right.length < 4) return false;
  return left === right || left.endsWith(right) || right.endsWith(left);
}

function candidateScopeCore(fact: CitedFact): boolean {
  return fact.scopeRole === "core";
}

/**
 * A review task needs the implementation behind the supplied flow, not the
 * alphabetically first functions in a module. Rank excerpts by exact flow path
 * and step-name evidence, then by language-neutral control/error density.
 */
function boundedIssueFacts(request: AuthoringRequest): readonly CitedFact[] {
  const facts = request.facts;
  // A module's problem list owns only that module's implementation. Supporting
  // surfaces may be described in its flow map, but their defects belong in
  // their own report rather than being attributed to the caller.
  const projectScope = request.documentId.startsWith("project|");
  const allFlows = facts.filter((fact) =>
    fact.kind === "feature-flow" && (projectScope || factObject(fact).reportScopeRole !== "supporting"),
  );
  const flows = representativeFlows(allFlows, 10);
  const flowPaths = new Set<string>();
  const coreFlowPaths = new Set<string>();
  const flowNames = new Set<string>();
  const coreFlowNames = new Set<string>();
  for (const flow of allFlows) {
    const core = factObject(flow).reportScopeRole !== "supporting";
    const steps = factObject(flow).steps;
    if (!Array.isArray(steps)) continue;
    for (const raw of steps) {
      if (typeof raw !== "object" || raw === null) continue;
      const step = raw as Readonly<Record<string, unknown>>;
      const rootName = typeof step.rootName === "string" ? step.rootName : "";
      const provenance = typeof step.provenance === "object" && step.provenance !== null
        ? step.provenance as Readonly<Record<string, unknown>>
        : {};
      const source = typeof provenance.source === "object" && provenance.source !== null
        ? provenance.source as Readonly<Record<string, unknown>>
        : {};
      const relPath = typeof step.relPath === "string"
        ? step.relPath
        : typeof source.relPath === "string"
          ? source.relPath
          : "";
      const name = typeof step.label === "string"
        ? step.label
        : typeof step.name === "string"
          ? step.name
          : "";
      if (rootName !== "" && relPath !== "") {
        const path = `${rootName}/${relPath}`;
        flowPaths.add(path);
        const stepRole = typeof step.reportScopeRole === "string" ? step.reportScopeRole : null;
        if (core && stepRole !== "supporting") coreFlowPaths.add(path);
      }
      if (name !== "") {
        const token = normalizedToken(name);
        flowNames.add(token);
        if (core) coreFlowNames.add(token);
      }
    }
  }

  const highSignalKinds = new Set([
    "diagnostic", "feature-finding", "structural-finding", "health-signal",
    "discarded-error", "error-handling", "transaction-boundary", "auth-annotation",
    "validation-rule", "state-transition", "guard", "decision", "condition", "business-rule",
  ]);
  const rawSignals = facts.filter((fact) => highSignalKinds.has(fact.kind) && fact.kind !== "feature-finding");
  const coreDirectories = new Set([...coreFlowPaths].map((path) => dirname(path)));
  const sourceExcerptFacts = facts.filter((fact) => fact.kind === "source-excerpt");
  const excerptCandidates = sourceExcerptFacts.map((fact) => {
    const label = normalizedToken(sourceLabel(fact).replace(/\s*\(part \d+\)$/i, ""));
    const path = `${fact.citation.rootName}/${fact.citation.relPath}`;
    const exactFlowLabel = [...flowNames].some((flowName) => relatedLabel(label, flowName));
    const exactCoreLabel = [...coreFlowNames].some((flowName) => relatedLabel(label, flowName));
    const corePath = coreFlowPaths.has(path);
    const coreDirectory = coreDirectories.has(dirname(path));
    const eligible = projectScope || candidateScopeCore(fact) || corePath || coreDirectory;
    const start = fact.citation.startLine;
    const end = fact.citation.endLine;
    const containedSignals = start === null || end === null
      ? []
      : rawSignals.filter((signal) => {
          const signalPath = `${signal.citation.rootName}/${signal.citation.relPath}`;
          const line = signal.citation.startLine;
          return signalPath === path && line !== null && line >= start && line <= end;
        });
    return {
      fact,
      label,
      path,
      exactFlowLabel,
      exactCoreLabel,
      corePath,
      coreDirectory,
      eligible,
      containedSignals,
    };
  });

  const relevantRanges = new Map<string, { start: number; end: number }[]>();
  for (const excerpt of excerptCandidates.filter((candidate) => candidate.eligible)) {
    const start = excerpt.fact.citation.startLine;
    const end = excerpt.fact.citation.endLine;
    if (start === null || end === null) continue;
    const ranges = relevantRanges.get(excerpt.path) ?? [];
    ranges.push({ start, end });
    relevantRanges.set(excerpt.path, ranges);
  }
  const inReachedFunction = (fact: CitedFact): boolean => {
    if (projectScope) return true;
    const path = `${fact.citation.rootName}/${fact.citation.relPath}`;
    // Older or reduced snapshots may have no source excerpts. Keep the
    // file-scoped evidence path usable there; function precision is an
    // enhancement, not a reason to make a non-empty authored block empty.
    if (relevantRanges.size === 0) return flowPaths.size === 0 || flowPaths.has(path);
    const line = fact.citation.startLine;
    if (line === null) return false;
    return (relevantRanges.get(path) ?? []).some((range) => line >= range.start && line <= range.end);
  };

  const selected: CitedFact[] = [...flows];
  const kindCounts = new Map<string, number>();
  const signalPriority: Readonly<Record<string, number>> = {
    "feature-finding": 0, diagnostic: 0, "structural-finding": 1, "health-signal": 1,
    "discarded-error": 2, "error-handling": 2, "transaction-boundary": 3,
    "auth-annotation": 3, "validation-rule": 3, "state-transition": 3,
    guard: 4, decision: 4, condition: 5, "business-rule": 5,
  };
  const signals = facts
    .filter((fact) => {
      if (!highSignalKinds.has(fact.kind)) return false;
      // Analyzer findings already have their own deterministic report row.
      // The model review is reserved for concrete code-level evidence.
      if (fact.kind === "feature-finding") return false;
      return inReachedFunction(fact);
    })
    .sort((a, b) => (signalPriority[a.kind] ?? 9) - (signalPriority[b.kind] ?? 9) || a.factId.localeCompare(b.factId));
  for (const fact of signals) {
    if (selected.length >= 38) break;
    if (!highSignalKinds.has(fact.kind)) continue;
    const count = kindCounts.get(fact.kind) ?? 0;
    if (count >= capForKind(fact.kind)) continue;
    kindCounts.set(fact.kind, count + 1);
    selected.push(fact);
  }

  const excerpts = excerptCandidates
    .filter((candidate) => candidate.eligible)
    .map((candidate) => {
      const { fact, path, exactFlowLabel, exactCoreLabel, corePath, coreDirectory, containedSignals } = candidate;
      const text = sourceText(fact);
      const rawLabel = sourceLabel(fact).replace(/\s*\(part \d+\)$/i, "");
      const idAddressed = /(?:\.Where\s*\([^\n]{0,100}\bid\b|where\s*:\s*\{[\s\S]{0,160}\bid\b|findByPk\s*\(|findOne\s*\([\s\S]{0,160}\bid\b)/i.test(text);
      const interpolatedSql = /`[^`]*(?:select|update|delete|insert)[^`]*\$\{/i.test(text);
      let score = 0;
      if (candidateScopeCore(fact)) score += 120;
      if (flowPaths.has(path)) score += 80;
      if (coreDirectory) score += 100;
      if (corePath) score += 100;
      if (exactFlowLabel) score += 140;
      if (exactCoreLabel) score += 180;
      if (!/\(part \d+\)$/i.test(sourceLabel(fact))) score += 15;
      if (/\b(if|else|switch|case|throw|catch|return|defer|recover)\b/.test(text)) score += 15;
      if (/\b(transaction|rollback|commit|permission|authori[sz]|status|state|validate|error)\b/i.test(text)) score += 15;
      if (idAddressed) score += 55;
      if (interpolatedSql) score += 80;
      if (/\b(?:permission|approver|operator|owner|leader|manager|user[_ ]?id|currentUser)\b/i.test(text)) score += 30;
      if (/\b(?:transaction|rollback|commit|billing|cancel|reject|approve|completed)\b/i.test(text)) score += 25;
      if (/(?:permission|authori[sz]|validate|handle|approv|aprv|reject|cancel|update|delete|export|create|apply|pagination|detail|byid|procedure)/i.test(rawLabel)) score += 45;
      score += Math.min(20, (text.match(/\b(if|case|throw|return)\b/g) ?? []).length);
      score += Math.min(120, containedSignals.length * 20);
      const anchor = interpolatedSql || idAddressed ||
        /(?:permission|authori[sz]|ownership|owner|byid|detail)/i.test(rawLabel) ||
        containedSignals.some((signal) => signal.kind === "auth-annotation");
      return { fact, score, bytes: Buffer.byteLength(text, "utf8"), anchor };
    })
    .sort((a, b) => b.score - a.score || a.fact.factId.localeCompare(b.fact.factId));
  let excerptBytes = 0;
  let excerptCount = 0;
  const selectedExcerptIds = new Set<string>();
  const selectedPaths = new Set<string>();
  const selectedPathCounts = new Map<string, number>();
  const addExcerpt = (excerpt: (typeof excerpts)[number]): boolean => {
    if (selectedExcerptIds.has(excerpt.fact.factId) || excerptBytes + excerpt.bytes > 128_000 || excerptCount >= 36) return false;
    selected.push(excerpt.fact);
    selectedExcerptIds.add(excerpt.fact.factId);
    const path = `${excerpt.fact.citation.rootName}/${excerpt.fact.citation.relPath}`;
    selectedPaths.add(path);
    selectedPathCounts.set(path, (selectedPathCounts.get(path) ?? 0) + 1);
    excerptBytes += excerpt.bytes;
    excerptCount += 1;
    return true;
  };
  // Spend the review budget on the module-owned package first. Shared helpers
  // stay eligible, but cannot crowd out permission, state and persistence code
  // merely because many modules call them.
  const coreExcerpts = excerpts.filter((excerpt) => candidateScopeCore(excerpt.fact));
  for (const excerpt of coreExcerpts.filter((candidate) => candidate.anchor)) {
    addExcerpt(excerpt);
    if (excerptCount >= 10) break;
  }
  for (const excerpt of coreExcerpts) {
    const path = `${excerpt.fact.citation.rootName}/${excerpt.fact.citation.relPath}`;
    if (selectedPaths.has(path)) continue;
    addExcerpt(excerpt);
    if (excerptCount >= 14) break;
  }
  // A permission or service file often contains both shared helpers and the
  // caller that uses them. Keep up to three high-density functions from selected
  // core files before spreading the remaining budget globally.
  for (const excerpt of coreExcerpts) {
    const path = `${excerpt.fact.citation.rootName}/${excerpt.fact.citation.relPath}`;
    if (!selectedPaths.has(path) || (selectedPathCounts.get(path) ?? 0) >= 3) continue;
    addExcerpt(excerpt);
    if (excerptCount >= 28) break;
  }
  for (const excerpt of coreExcerpts) {
    addExcerpt(excerpt);
    if (excerptCount >= 33) break;
  }
  return [...new Map(selected.map((fact) => [fact.factId, fact] as const)).values()];
}

function lifecycleSignalKey(fact: CitedFact): string {
  const value = factObject(fact);
  const compact = {
    kind: fact.kind,
    subject: value.subject ?? value.field ?? value.valueSet ?? null,
    test: value.fullTest ?? value.test ?? value.text ?? value.statement ?? null,
    operator: value.operator ?? null,
    literal: value.literal ?? value.value ?? null,
    meanings: value.meanings ?? null,
    outcome: value.guarded ?? value.outcome ?? value.to ?? null,
  };
  return stableStringify(compact);
}

function lifecycleSignalScore(fact: CitedFact): number {
  const value = factObject(fact);
  const literal = value.literal;
  const meanings = Array.isArray(value.meanings) ? value.meanings : [];
  const test = String(value.fullTest ?? value.test ?? value.text ?? value.statement ?? "");
  let score = fact.scopeRole === "core" ? 80 : fact.scopeRole === "supporting" ? -80 : 20;
  if (fact.kind === "guard" || fact.kind === "validation-rule") score += 90;
  if (fact.kind === "decision") score += 75;
  if (fact.kind === "condition") score += 45;
  if (fact.kind === "business-rule") score += 55;
  if (value.guarded === "rejects" || value.outcome === "leaves") score += 70;
  if (typeof literal === "number" && literal !== 0) score += 110;
  if (typeof literal === "string" && literal.trim() !== "" && literal.length <= 64) score += 95;
  if (meanings.length > 0 || typeof value.valueSetName === "string") score += 115;
  if (/&&|\|\||\blen\s*\(|\.length\b/.test(test)) score += 85;
  if (/[<>]=?|===?|!==?/.test(test)) score += 40;
  if (/\b(status|state|type|role|level|hour|date|time|balance|remain|attachment|file)\b/i.test(test)) score += 45;
  return score;
}

function lifecycleNotificationEvidence(fact: CitedFact): boolean {
  if (fact.kind === "notification-call") return true;
  const value = factObject(fact);
  const text = [
    fact.citation.relPath,
    sourceLabel(fact),
    sourceText(fact),
    value.channel,
    value.mechanism,
    value.target,
    value.call,
  ].map((entry) => typeof entry === "string" ? entry : "").join(" ");
  return /\b(notification|notify|email|mail|mobile\s+push|push\s+notification|slack|postmessage|recipient)\b/i.test(text);
}

/** A concrete delivery channel, rather than a subject/template helper in a notification file. */
function lifecycleChannelEvidence(fact: CitedFact): boolean {
  const value = factObject(fact);
  const text = [
    sourceLabel(fact),
    sourceText(fact),
    value.channel,
    value.mechanism,
    value.call,
  ].map((entry) => typeof entry === "string" ? entry : "").join(" ");
  return /Notify(?:Email|Mail|Mobile|Push)|mobile\s+push\s+notification|push\s+notification|email\.InputParam|genMobileComposite|\b(?:email|mail|mobile\s+push)\b/i.test(text);
}

function lifecycleCompositeChannelEvidence(fact: CitedFact): boolean {
  const text = sourceText(fact);
  return /Notify(?:Email|Mail)Cpst/i.test(text) && /Notify(?:Mobile|Push)Cpst/i.test(text);
}

function lifecycleApprovalStageEvidence(fact: CitedFact): boolean {
  if (fact.kind !== "source-excerpt") return false;
  return /(?:waiting|pending)[A-Za-z0-9_]*L\d+[A-Za-z0-9_]*(?:approve|approval)/i.test(sourceText(fact));
}

/** Source-level state writes used when a provider cannot yet form the transition. */
function lifecycleTransitionEvidence(fact: CitedFact): boolean {
  if (fact.kind !== "source-excerpt") return false;
  const text = `${sourceLabel(fact)} ${sourceText(fact)}`;
  return /(?:update|set|change|transition|move)[A-Za-z0-9_]*(?:status|state)|(?:\.|\b)(?:status|state)\s*=|(?:waiting|pending)[A-Za-z0-9_]*L\d+[A-Za-z0-9_]*(?:approve|approval)/i.test(text);
}

/**
 * Keep the lifecycle author's input complete in the dimensions a reader cares
 * about without handing one model thousands of raw AST conditions. Selection is
 * structural and language-neutral where possible: non-zero thresholds, enum
 * meanings, rejecting/compound guards, state changes and diverse subjects win.
 */
function boundedLifecycleFacts(request: AuthoringRequest): readonly CitedFact[] {
  const coreEligible = request.facts.filter((fact) => fact.scopeRole !== "supporting");
  const coreValueSetNames = new Set<string>();
  const coreTransitionSetCounts = new Map<string, number>();
  for (const fact of coreEligible) {
    const value = factObject(fact);
    if (fact.kind === "value-set" && typeof value.name === "string") coreValueSetNames.add(value.name);
    if (fact.kind === "state" && typeof value.valueSet === "string") coreValueSetNames.add(value.valueSet);
    if (fact.kind === "state-transition") {
      for (const endpoint of [value.from, value.to]) {
        if (typeof endpoint !== "object" || endpoint === null) continue;
        const valueSet = (endpoint as Readonly<Record<string, unknown>>).valueSet;
        if (typeof valueSet === "string") {
          coreValueSetNames.add(valueSet);
          if (endpoint === value.to) {
            coreTransitionSetCounts.set(valueSet, (coreTransitionSetCounts.get(valueSet) ?? 0) + 1);
          }
        }
      }
    }
  }
  const maximumCoreTransitions = Math.max(0, ...coreTransitionSetCounts.values());
  const relatedLifecycleSets = maximumCoreTransitions < 2
    ? coreValueSetNames
    : new Set(
        [...coreTransitionSetCounts.entries()]
          .filter(([, count]) => count >= 2 && count >= maximumCoreTransitions * 0.4)
          .map(([name]) => name),
      );

  // A scheduled writer admitted by module membership is supporting code, but
  // a transition into the same state vocabulary is part of this lifecycle.
  // Keep only that exact vocabulary link; other jobs in a shared cron file stay
  // outside the report.
  const relatedTransitions = request.facts.filter((fact) => {
    if (fact.scopeRole !== "supporting" || fact.kind !== "state-transition") return false;
    const value = factObject(fact);
    const endpoint = typeof value.to === "object" && value.to !== null
      ? value.to as Readonly<Record<string, unknown>>
      : {};
    return typeof endpoint.valueSet === "string" && relatedLifecycleSets.has(endpoint.valueSet);
  });
  const relatedPaths = new Set(relatedTransitions.map((fact) => `${fact.citation.rootName}/${fact.citation.relPath}`));
  const relatedTriggers = new Map<string, Set<string>>();
  for (const fact of relatedTransitions) {
    const path = `${fact.citation.rootName}/${fact.citation.relPath}`;
    const trigger = factObject(fact).trigger;
    if (typeof trigger !== "string" || trigger === "") continue;
    const triggers = relatedTriggers.get(path) ?? new Set<string>();
    triggers.add(trigger);
    relatedTriggers.set(path, triggers);
  }
  const supportingExcerpts = request.facts.filter((fact) =>
    fact.scopeRole === "supporting" && fact.kind === "source-excerpt" &&
    relatedPaths.has(`${fact.citation.rootName}/${fact.citation.relPath}`),
  );
  const lineFromExcerpt = (excerpt: CitedFact, line: number): string => {
    const start = excerpt.citation.startLine;
    if (start === null) return "";
    return sourceText(excerpt).split("\n")[line - start] ?? "";
  };
  const relatedSchedules = request.facts.filter((fact) => {
    if (fact.scopeRole !== "supporting" || fact.kind !== "scheduled-task") return false;
    const path = `${fact.citation.rootName}/${fact.citation.relPath}`;
    const line = fact.citation.startLine;
    const triggers = relatedTriggers.get(path);
    if (line === null || triggers === undefined) return false;
    return supportingExcerpts
      .filter((excerpt) => {
        const start = excerpt.citation.startLine ?? Number.MAX_SAFE_INTEGER;
        const end = excerpt.citation.endLine ?? -1;
        return line >= start && line <= end;
      })
      .some((excerpt) => [...triggers].some((trigger) => lineFromExcerpt(excerpt, line).includes(trigger)));
  });
  const relatedLinesByPath = new Map<string, number[]>();
  for (const fact of [...relatedTransitions, ...relatedSchedules]) {
    const line = fact.citation.startLine;
    if (line === null) continue;
    const path = `${fact.citation.rootName}/${fact.citation.relPath}`;
    const lines = relatedLinesByPath.get(path) ?? [];
    lines.push(line);
    relatedLinesByPath.set(path, lines);
  }
  const relatedExcerpts = supportingExcerpts.filter((fact) => {
    const path = `${fact.citation.rootName}/${fact.citation.relPath}`;
    const start = fact.citation.startLine ?? Number.MAX_SAFE_INTEGER;
    const end = fact.citation.endLine ?? -1;
    return (relatedLinesByPath.get(path) ?? []).some((line) => line >= start && line <= end);
  });
  const relatedIds = new Set(
    [...relatedTransitions, ...relatedSchedules, ...relatedExcerpts].map((fact) => fact.factId),
  );
  const eligible = request.facts.filter((fact) => fact.scopeRole !== "supporting" || relatedIds.has(fact.factId));

  const flowScore = (fact: CitedFact): number => {
    const value = factObject(fact);
    const steps = Array.isArray(value.steps) ? value.steps : [];
    const first = typeof steps[0] === "object" && steps[0] !== null
      ? steps[0] as Readonly<Record<string, unknown>>
      : {};
    const method = String(value.method ?? "").toUpperCase();
    const observedCaller = first.provenance !== null && first.provenance !== undefined;
    return (observedCaller ? 300 : 0) +
      (["POST", "PUT", "PATCH", "DELETE"].includes(method) ? 200 : 0) +
      (value.partial === false ? 30 : 0);
  };
  const coreFlows = eligible
    .filter((fact) => fact.kind === "feature-flow")
    .sort((a, b) => flowScore(b) - flowScore(a) || a.factId.localeCompare(b.factId))
    .slice(0, 28);
  const activeLifecycleRoots = new Set(coreFlows.flatMap((flow) => {
    const steps = factObject(flow).steps;
    if (!Array.isArray(steps) || typeof steps[0] !== "object" || steps[0] === null) return [];
    const first = steps[0] as Readonly<Record<string, unknown>>;
    if (first.provenance === null || first.provenance === undefined) return [];
    return steps
      .filter((step): step is Readonly<Record<string, unknown>> => typeof step === "object" && step !== null)
      .map((step) => typeof step.rootName === "string" ? step.rootName : "")
      .filter(Boolean);
  }));
  const lifecycleRank = (fact: CitedFact): number =>
    lifecycleSignalScore(fact) + (activeLifecycleRoots.has(fact.citation.rootName) ? 500 : 0);
  const candidateTransitions = eligible
    .filter((fact) => fact.kind === "state-transition")
    .filter((fact) => {
      const value = factObject(fact);
      const trigger = String(value.trigger ?? "");
      // File-scope UI assignments and notification/template DTO construction
      // describe presentation state, not a persisted business lifecycle.
      return trigger !== "<file-scope>" && !/(?:^|\/)(?:notification|notifications|template|templates|mail|email)(?:[._/]|$)/i.test(fact.citation.relPath);
    });
  const transitionCounts = new Map<string, number>();
  for (const fact of candidateTransitions) {
    const field = String(factObject(fact).field ?? "unknown");
    transitionCounts.set(field, (transitionCounts.get(field) ?? 0) + 1);
  }
  const hasRepeatedTransitionField = [...transitionCounts.values()].some((count) => count >= 2);
  const transitions = candidateTransitions
    .sort((a, b) => {
      const ac = transitionCounts.get(String(factObject(a).field ?? "unknown")) ?? 0;
      const bc = transitionCounts.get(String(factObject(b).field ?? "unknown")) ?? 0;
      return bc - ac || a.factId.localeCompare(b.factId);
    })
    .filter((fact) => !hasRepeatedTransitionField || (transitionCounts.get(String(factObject(fact).field ?? "unknown")) ?? 0) >= 2)
    .slice(0, 36);
  const endpointIds = new Set(transitions.flatMap((fact) => {
    const value = factObject(fact);
    return [value.fromFactId, value.toFactId].filter((id): id is string => typeof id === "string");
  }));
  const stateFacts = eligible
    .filter((fact) => fact.kind === "state")
    .sort((a, b) => (endpointIds.has(a.factId) ? 0 : 1) - (endpointIds.has(b.factId) ? 0 : 1) || a.factId.localeCompare(b.factId))
    .slice(0, 28);
  const valueSets = eligible
    .filter((fact) => fact.kind === "value-set")
    .sort((a, b) => a.factId.localeCompare(b.factId))
    .slice(0, 16);
  const states = [...stateFacts, ...transitions, ...valueSets, ...relatedSchedules];
  const communications = eligible
    .filter((fact) => fact.kind === "notification-call" || (fact.kind === "outbound-call" && lifecycleNotificationEvidence(fact)))
    .sort((a, b) => {
      const rank = (fact: CitedFact) => fact.kind === "notification-call" ? 0 : 1;
      return rank(a) - rank(b) || a.factId.localeCompare(b.factId);
    })
    .slice(0, 12);

  const signalKinds = new Set(["condition", "decision", "guard", "business-rule", "validation-rule"]);
  const comparisonKey = (fact: CitedFact): string => {
    const value = factObject(fact);
    return stableStringify({
      subject: value.subject ?? value.field ?? null,
      operator: value.operator ?? null,
      literal: value.literal ?? null,
    });
  };
  const conditionComparisons = new Set(eligible
    .filter((fact) => fact.kind === "condition")
    .map(comparisonKey));
  const dedupedSignals: CitedFact[] = [];
  const seenSignals = new Set<string>();
  for (const fact of eligible
    .filter((entry) => signalKinds.has(entry.kind))
    .sort((a, b) => lifecycleRank(b) - lifecycleRank(a) || a.factId.localeCompare(b.factId))) {
    const value = factObject(fact);
    const meanings = Array.isArray(value.meanings) ? value.meanings : [];
    if (fact.kind === "business-rule" && meanings.length === 0 && conditionComparisons.has(comparisonKey(fact))) continue;
    const key = lifecycleSignalKey(fact);
    if (seenSignals.has(key)) continue;
    seenSignals.add(key);
    dedupedSignals.push(fact);
  }
  const bySubject = new Map<string, CitedFact[]>();
  for (const fact of dedupedSignals) {
    const value = factObject(fact);
    const subject = String(value.subject ?? value.field ?? value.valueSetName ?? fact.citation.relPath);
    const group = `${fact.kind}:${normalizedToken(subject) || fact.citation.relPath}`;
    const list = bySubject.get(group) ?? [];
    list.push(fact);
    bySubject.set(group, list);
  }
  for (const list of bySubject.values()) {
    list.sort((a, b) => lifecycleRank(b) - lifecycleRank(a) || a.factId.localeCompare(b.factId));
  }
  const signals: CitedFact[] = [];
  const selectedSignalIds = new Set<string>();
  // Preserve actual branch and validation evidence before threshold-heavy
  // conditions consume the diversity budget.
  const reservedByKind = new Map<string, number>([["guard", 11], ["decision", 5], ["validation-rule", 4]]);
  for (const kind of ["guard", "decision", "validation-rule"]) {
    const candidates = dedupedSignals.filter((entry) => {
      if (entry.kind !== kind) return false;
      if (kind !== "decision") return true;
      const subject = normalizedToken(String(factObject(entry).subject ?? ""));
      return subject !== "" && !/^(?:err|error|ok|found|loaded|loading|index|i)$/.test(subject);
    });
    for (const fact of candidates.slice(0, reservedByKind.get(kind) ?? 0)) {
      signals.push(fact);
      selectedSignalIds.add(fact.factId);
    }
  }
  // Reader-facing subtype names are often expressed as string literals in UI
  // conditions. Reserve them before numeric/status comparisons consume the
  // material-threshold budget, so a module with many rules still keeps every
  // major selectable variant (leave type, application kind, expense category,
  // and similar vocabularies) without relying on a project keyword list.
  const namedVariants = dedupedSignals
    .filter((fact) => {
      if (fact.kind !== "condition") return false;
      const value = factObject(fact);
      const subject = normalizedToken(String(value.subject ?? value.field ?? ""));
      return typeof value.literal === "string" && value.literal.trim() !== "" && /(?:type|category|kind)$/.test(subject);
    })
    .sort((a, b) => lifecycleRank(b) - lifecycleRank(a) || a.factId.localeCompare(b.factId));
  const selectedNamedVariants = new Set<string>();
  for (const fact of namedVariants) {
    if (signals.length >= 36) break;
    const value = factObject(fact);
    const key = `${normalizedToken(String(value.subject ?? value.field ?? ""))}:${String(value.literal).toLowerCase()}`;
    if (selectedNamedVariants.has(key) || selectedSignalIds.has(fact.factId)) continue;
    selectedNamedVariants.add(key);
    signals.push(fact);
    selectedSignalIds.add(fact.factId);
  }
  // Approval stages and validation variants commonly compare the same field
  // against several thresholds (for example >16 and >40 hours). A single
  // round-robin winner per subject silently drops the later stage, so reserve a
  // bounded slot for every materially distinct literal/enum comparison first.
  const selectedThresholds = new Set<string>();
  const materialThresholdKey = (fact: CitedFact): string | null => {
    const value = factObject(fact);
    const literal = value.literal;
    const meanings = Array.isArray(value.meanings) ? value.meanings : [];
    const materialLiteral = (typeof literal === "number" && literal !== 0) ||
      (typeof literal === "string" && literal.trim() !== "" && literal.length <= 64);
    const materialVocabulary = meanings.length > 0 || typeof value.valueSetName === "string";
    if (!materialLiteral && !materialVocabulary) return null;
    const subject = normalizedToken(String(value.subject ?? value.field ?? value.valueSetName ?? "unknown"));
    return stableStringify({
      subject,
      operator: value.operator ?? null,
      literal: materialLiteral ? literal : null,
      valueSetName: value.valueSetName ?? null,
      meanings: materialVocabulary ? meanings : null,
    });
  };
  for (const fact of dedupedSignals) {
    if (signals.length >= 46) break;
    const key = materialThresholdKey(fact);
    if (key === null || selectedThresholds.has(key)) continue;
    selectedThresholds.add(key);
    if (selectedSignalIds.has(fact.factId)) continue;
    signals.push(fact);
    selectedSignalIds.add(fact.factId);
  }
  const groups = [...bySubject.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, list]) => list);
  for (let round = 0; signals.length < 48; round += 1) {
    const candidates = groups
      .map((group) => group[round])
      .filter((fact): fact is CitedFact => fact !== undefined)
      .sort((a, b) => lifecycleRank(b) - lifecycleRank(a) || a.factId.localeCompare(b.factId));
    for (const fact of candidates) {
      if (selectedSignalIds.has(fact.factId)) continue;
      signals.push(fact);
      selectedSignalIds.add(fact.factId);
      if (signals.length >= 48) break;
    }
    if (candidates.length === 0) break;
  }

  const selectedSignalRanges = new Map<string, number[]>();
  for (const fact of [...states, ...signals]) {
    const line = fact.citation.startLine;
    if (line === null) continue;
    const path = `${fact.citation.rootName}/${fact.citation.relPath}`;
    const lines = selectedSignalRanges.get(path) ?? [];
    lines.push(line);
    selectedSignalRanges.set(path, lines);
  }
  const excerptCandidates = eligible
    .filter((fact) => fact.kind === "source-excerpt")
    .map((fact) => {
      const path = `${fact.citation.rootName}/${fact.citation.relPath}`;
      const start = fact.citation.startLine ?? -1;
      const end = fact.citation.endLine ?? start;
      const contained = (selectedSignalRanges.get(path) ?? []).filter((line) => line >= start && line <= end).length;
      const text = sourceText(fact);
      let score = contained * 140;
      if (candidateScopeCore(fact)) score += 80;
      if (relatedPaths.has(path)) score += 250;
      if (lifecycleNotificationEvidence(fact)) score += 120;
      if (lifecycleChannelEvidence(fact)) score += 500;
      if (lifecycleCompositeChannelEvidence(fact)) score += 500;
      if (lifecycleTransitionEvidence(fact)) score += 400;
      if (lifecycleApprovalStageEvidence(fact)) score += 700;
      if (/\b(status|state|approve|reject|cancel|withdraw|submit|create|update|delete|transition)\b/i.test(text)) score += 55;
      if (/\b(if|switch|case|transaction|rollback|commit)\b/i.test(text)) score += 30;
      return { fact, score, bytes: Buffer.byteLength(text, "utf8"), contained };
    })
    .filter((entry) => entry.contained > 0 || entry.score >= 120)
    .sort((a, b) => b.score - a.score || a.fact.factId.localeCompare(b.fact.factId));
  const excerpts: CitedFact[] = [];
  const excerptIds = new Set<string>();
  let excerptBytes = 0;
  const addExcerpt = (entry: (typeof excerptCandidates)[number]): boolean => {
    if (excerptIds.has(entry.fact.factId) || excerpts.length >= 14 || excerptBytes + entry.bytes > 72_000) return false;
    excerpts.push(entry.fact);
    excerptIds.add(entry.fact.factId);
    excerptBytes += entry.bytes;
    return true;
  };
  const relatedExcerptIds = new Set(relatedExcerpts.map((fact) => fact.factId));
  let relatedExcerptCount = 0;
  for (const entry of excerptCandidates.filter((candidate) => relatedExcerptIds.has(candidate.fact.factId))) {
    if (addExcerpt(entry)) relatedExcerptCount += 1;
    if (relatedExcerptCount >= 4) break;
  }
  let approvalStageExcerptCount = 0;
  for (const entry of excerptCandidates.filter((candidate) => lifecycleApprovalStageEvidence(candidate.fact))) {
    if (addExcerpt(entry)) approvalStageExcerptCount += 1;
    if (approvalStageExcerptCount >= 4) break;
  }
  const notificationFacets = [
    /waiting|nextapprover|applied|submit/i,
    /approved|requestupdate/i,
    /reject/i,
    /cancel/i,
  ];
  for (const facet of notificationFacets) {
    const match = excerptCandidates.find((candidate) =>
      !excerptIds.has(candidate.fact.factId) &&
      lifecycleCompositeChannelEvidence(candidate.fact) &&
      facet.test(`${sourceLabel(candidate.fact)} ${sourceText(candidate.fact)}`),
    );
    if (match !== undefined) addExcerpt(match);
  }
  let transitionExcerptCount = 0;
  for (const entry of excerptCandidates.filter((candidate) =>
    !excerptIds.has(candidate.fact.factId) && candidate.contained > 0 && lifecycleTransitionEvidence(candidate.fact),
  )) {
    if (addExcerpt(entry)) transitionExcerptCount += 1;
    if (transitionExcerptCount >= 2) break;
  }
  const flowLabels = coreFlows.flatMap((flow) => {
    const steps = factObject(flow).steps;
    if (!Array.isArray(steps)) return [];
    return steps
      .filter((step): step is Readonly<Record<string, unknown>> => typeof step === "object" && step !== null)
      .filter((step) => step.kind === "handler")
      .map((step) => typeof step.label === "string" ? normalizedToken(step.label) : "")
      .filter((label) => label.length >= 4);
  });
  const implementationFirst = (entries: readonly (typeof excerptCandidates)[number][]) =>
    [...entries].sort((a, b) => {
      const span = (entry: (typeof excerptCandidates)[number]) =>
        (entry.fact.citation.endLine ?? 0) - (entry.fact.citation.startLine ?? 0);
      const active = (entry: (typeof excerptCandidates)[number]) => activeLifecycleRoots.has(entry.fact.citation.rootName) ? 1 : 0;
      return active(b) - active(a) || span(b) - span(a) || b.score - a.score || a.fact.factId.localeCompare(b.fact.factId);
    });
  for (const label of [...new Set(flowLabels)].slice(0, 8)) {
    const match = implementationFirst(excerptCandidates.filter((candidate) => relatedLabel(
        normalizedToken(sourceLabel(candidate.fact).replace(/\s*\(part \d+\)$/i, "")),
        label,
      )))[0];
    if (match !== undefined) addExcerpt(match);
  }
  const lifecycleFacets = [
    /withdraw|refund|restore|compensat/i,
    /cancell|cancel|delet/i,
    /reject|declin/i,
    /complete|finish|close|expir/i,
  ];
  for (const facet of lifecycleFacets) {
    const match = implementationFirst(excerptCandidates.filter((candidate) =>
      !excerptIds.has(candidate.fact.factId) && facet.test(sourceLabel(candidate.fact)),
    ))[0];
    if (match !== undefined) addExcerpt(match);
  }
  for (const entry of excerptCandidates) {
    addExcerpt(entry);
  }

  const labels = eligible.filter((fact) => fact.kind === "ui-label").slice(0, 6);
  return [...new Map(
    [...coreFlows, ...states, ...signals, ...communications, ...excerpts, ...labels].map((fact) => [fact.factId, fact] as const),
  ).values()];
}

function representativeFlows(flows: readonly CitedFact[], cap: number): readonly CitedFact[] {
  const groups = new Map<string, CitedFact[]>();
  for (const fact of flows) {
    const value = typeof fact.value === "object" && fact.value !== null ? fact.value as Record<string, unknown> : {};
    const key = typeof value.featureId === "string"
      ? value.featureId
      : typeof value.featureName === "string"
        ? value.featureName
        : fact.factId.split("|").slice(0, 3).join("|");
    const list = groups.get(key) ?? [];
    list.push(fact);
    groups.set(key, list);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, list]) => list);
  const selected: CitedFact[] = [];
  for (let round = 0; selected.length < cap; round += 1) {
    let added = false;
    for (const group of ordered) {
      const fact = group[round];
      if (fact === undefined) continue;
      selected.push(fact);
      added = true;
      if (selected.length >= cap) break;
    }
    if (!added) break;
  }
  return selected;
}

/** Keep every module-flow fact and a representative, per-kind sample elsewhere. */
function boundedFacts(facts: readonly CitedFact[], keepEveryFlow = false, totalCap = 120): readonly CitedFact[] {
  const counts = new Map<string, number>();
  // Flow facts are the report's topology, not illustrative prose evidence. Put
  // them first so a dense condition/rule slice can never consume the global cap
  // before the model sees the flows it must account for.
  const flows = facts.filter((fact) => fact.kind === "feature-flow");
  if (keepEveryFlow && flows.length > capForKind("feature-flow")) {
    throw new Error(`flow slice has ${flows.length} feature-flow facts; the bounded V1 authoring contract supports at most ${capForKind("feature-flow")}`);
  }
  const selected: CitedFact[] = [...(keepEveryFlow ? flows : representativeFlows(flows, 30))];
  counts.set("feature-flow", selected.length);
  const nonFlows = facts
    .filter((entry) => entry.kind !== "feature-flow")
    .sort((a, b) => {
      const rank = (fact: CitedFact) => fact.scopeRole === "core" ? 0 : fact.scopeRole === "supporting" ? 2 : 1;
      return rank(a) - rank(b) || a.factId.localeCompare(b.factId);
    });
  for (const fact of nonFlows) {
    if (selected.length >= totalCap) break;
    const count = counts.get(fact.kind) ?? 0;
    if (count >= capForKind(fact.kind)) continue;
    counts.set(fact.kind, count + 1);
    selected.push(fact);
  }
  return selected;
}

export function boundedFactsFor(request: AuthoringRequest): readonly CitedFact[] {
  if (request.blockId === "known-issues.impact") return boundedIssueFacts(request);
  if (request.blockId === "module-flows-branches.lifecycle") return boundedLifecycleFacts(request);
  const coreOnlyModuleBlocks = new Set([
    "module-responsibility.summary",
    "module-objects-rules-states.notes",
    "module-recovery.notes",
    "module-notifications-data.notes",
  ]);
  const facts = coreOnlyModuleBlocks.has(request.blockId)
    ? request.facts.filter((fact) => fact.scopeRole !== "supporting")
    : request.facts;
  const keepEveryFlow = request.blockId === "module-flows-branches.flows";
  const totalCap = request.blockId === "module-flows-branches.flows" || request.blockId === "project-roles-flows.paths"
    ? 180
    : request.blockId === "module-responsibility.summary" || request.blockId === "project-boundary.capabilities"
      ? 90
      : request.blockId === "module-objects-rules-states.notes" || request.blockId === "project-objects-lifecycle.rules"
        ? 120
        : request.blockId === "module-recovery.notes"
          ? 80
          : 100;
  return boundedFacts(facts, keepEveryFlow, totalCap);
}

function flowTask(request: AuthoringRequest): boolean {
  return request.blockId === "module-flows-branches.flows" || request.blockId === "project-roles-flows.paths";
}

function lifecycleTask(request: AuthoringRequest): boolean {
  return request.blockId === "module-flows-branches.lifecycle";
}

function authorFactLine(fact: CitedFact, blockId?: string): string {
  if (fact.kind === "source-excerpt") {
    return citedFactLine(fact, blockId === "module-flows-branches.lifecycle" ? 5_200 : 7_200);
  }
  if (fact.kind !== "feature-flow" || typeof fact.value !== "object" || fact.value === null) {
    return citedFactLine(fact, 520);
  }
  const value = fact.value as Record<string, unknown>;
  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  const steps = rawSteps
    .filter((step): step is Record<string, unknown> => typeof step === "object" && step !== null)
    .map((step) => ({
      kind: step.kind,
      label: step.label,
      conditions: step.conditions,
      unresolved: step.unresolvedReason,
      reportScopeRole: step.reportScopeRole,
    }));
  const byKind = (kind: string, cap: number) => steps.filter((step) => step.kind === kind).slice(0, cap);
  const compact = {
    featureName: value.featureName,
    entryKey: value.entryKey,
    method: value.method,
    path: value.path,
    partial: value.partial,
    reportScopeRole: value.reportScopeRole,
    // Preserve the business-relevant middle of the trace. A fixed JSON prefix
    // used to cut every flow after the browser and route, hiding the service,
    // branch and effect evidence from the author even though it was in the KB.
    steps: [
      ...steps.filter((step) => step.kind === "frontend-call" || step.kind === "route" || step.kind === "handler").slice(0, 3),
      ...byKind("service", 6),
      ...byKind("outbound", 3),
      ...byKind("data-access", 3),
    ],
  };
  return citedFactLine({ ...fact, value: compact }, 1_800);
}

function promptForDocument(
  documentId: string,
  requests: readonly AuthoringRequest[],
  contracts: ReadonlyMap<string, AuthoredPromptContract>,
  language: string,
  correction: string | null,
): string {
  const selectedByTask = new Map(requests.map((request) => [request.taskId, boundedFactsFor(request)] as const));
  const sharedFacts = [...new Map(
    [...selectedByTask.values()].flat().map((fact) => [fact.factId, fact] as const),
  ).values()].sort((a, b) => a.factId.localeCompare(b.factId));
  const tasks = requests.map((request) => {
    const facts = selectedByTask.get(request.taskId)!;
    return {
      taskId: request.taskId,
      sectionId: request.sectionId,
      blockId: request.blockId,
      instruction: contracts.get(request.blockId)?.prompt ?? "Explain the supplied facts for this report block.",
      structuredFlowRequired: flowTask(request),
      structuredLifecycleRequired: lifecycleTask(request),
      structuredIssueReview: request.blockId === "known-issues.impact",
      factIds: facts.map((fact) => fact.factId),
    };
  });
  return [
    `Author the report blocks for ${documentId}. Use only the supplied cited facts; do not inspect files or run tools.`,
    `Write concise ${language.toLowerCase().startsWith("zh") ? "Simplified Chinese" : language} for a non-technical reader. State current behaviour only. Do not add goals, priorities, fixes, future plans, or unsupported claims.`,
    "Return every task exactly once. Put reader-facing prose in 1-8 concise claims. Each claim contains plain text plus the exact raw factIds that support the entire claim; do not put citation markers or square brackets in claim text.",
    "Keep each claim to one compact business statement. Avoid backticks and guillemets unless preserving an exact source token; when you preserve one, its exact text must occur in one of that claim's factIds.",
    "Raw fact inventories belong to deterministic rendering. Do not add a claim merely to repeat identifiers, file paths or endpoint lists.",
    "Facts are listed once in a shared fact table. Each task may use only its factIds from that table; do not use another task's facts.",
    "For a structuredFlowRequired task, group all supplied feature-flow facts into 3-8 major business flows. Put every feature-flow factId in at least one flow group's factIds. Facts with reportScopeRole=core define the module's main business flows. Preserve materially different business variants as separate flows when their steps or rules differ; do not collapse all request types into one generic create flow. Do not promote generic lookups, thumbnails, calculations, shared AI helpers or other reportScopeRole=supporting facts into separate module responsibilities: combine those into at most one final supporting-capabilities group. A supporting surface with a coherent user-visible outcome, such as time-clock records, credential management or connector configuration, is a distinct major flow; do not merge unrelated coherent surfaces into a generic supporting group. Use 2-6 steps per group. Use branches for success, rejection, conditional, exception or unknown outcomes, but return no more than 10 branch rows per group: merge related field validations or equivalent status outcomes into one reader-facing branch and attach all supporting factIds to it. A flow that contains a rejection or exception branch must also contain an explicit success branch whenever the supplied flow reaches a normal result; never present a normal create/submit operation as if every outcome were rejection. Set afterStep to the one-based step after which the branch occurs. Translate raw user-facing errors into concise business language; preserve an English token only when it materially identifies a state or rule. Put every supplied guard and decision factId in at least one branch's factIds, so evidenced branch conditions are not dropped. Each step and branch must cite only factIds from that task. For other tasks, flowGroups must be empty.",
    "For a structuredLifecycleRequired task, return 1-3 lifecycles and the complete material variantGroups supported by the supplied bounded facts. The first lifecycle must be the primary end-to-end user journey, not an endpoint list: combine the user's entry, type or option selection, type-specific validation, successful submission, approval or processing stages, successful and rejected terminal outcomes, evidenced notifications, and scheduled completion in one connected lifecycle. Put type-specific detail in variantGroups but keep the selection and validation decision visible in the primary lifecycle. Use a secondary lifecycle only for an evidenced cancel, withdraw, delete or recovery path; never create a lifecycle for a caller-unresolved entry. Give every node a short stable id, business label, detail and factIds; every edge must reference two node ids from that lifecycle, state the triggering condition or action, classify the edge, and cite factIds. Do not infer a missing origin, status, notification channel or outcome: use an unknown node or edge. Connect each evidenced email, mobile-push, chat or other notification to the lifecycle action that triggers it; when a source excerpt constructs both an email component and a mobile-push component, name both channels in the lifecycle. Do not name Slack or any channel absent from the supplied facts. Every numeric threshold that changes the approval or processing stage must be rendered as its own lifecycle edge with the exact threshold, even when the same fact also appears in a variant rule. If a source excerpt writes a named approval stage or state, use that evidenced stage instead of an unknown next stage. In variantGroups, preserve distinct type-, role-, duration-, date-, balance-, attachment- and threshold-dependent rules. Combine equivalent duplicate facts into one reader-facing rule and attach all of their factIds, but never replace a concrete number or condition with generic 'validation'. Every supplied scheduled-task, state, state-transition, value-set, condition, decision, guard, business-rule, validation-rule, notification-call, concrete-channel source-excerpt and state-write source-excerpt factId must appear in at least one lifecycle node/edge or variant rule. For other tasks, lifecycles and variantGroups must both be empty.",
    "For a structuredIssueReview task, return 0-8 concise issues in issues. Use status=confirmed only for an explicit contradiction, discarded failure, unreachable outcome, inconsistent handling, a complete function excerpt that performs an ID-addressed read/write without relating the record to the current actor before returning or mutating it, a write that replaces ownership from the request without first proving the actor may change that record, or a raw SQL statement that directly interpolates actor/request values. Use needs-confirmation when an excerpt is chunked, enforcement may be delegated to an omitted callee/middleware, a missing state transition is inferred from an incomplete write inventory, or the evidence only suggests a missing control. Compare related functions when the supplied evidence shows two paths implementing the same rule differently, especially role checks, boundary values, project/owner relationships, transactions and list/export filters. Each issue must state the observed code behaviour and a bounded user/business impact, cite only supplied factIds, and contain no fix or priority. Prefer module-owned excerpts over generic supporting helpers when both are supplied. For other tasks, issues must be empty.",
    correction === null ? "" : `The previous response was invalid. Correct these problems:\n${correction}`,
    "Tasks:",
    JSON.stringify(tasks),
    "Shared bounded fact table:",
    JSON.stringify(sharedFacts.map((fact) => authorFactLine(fact, requests[0]?.blockId))),
  ].filter(Boolean).join("\n\n");
}

function idsInFlow(group: StructuredFlowGroup): readonly string[] {
  return [
    ...group.factIds,
    ...group.steps.flatMap((step) => step.factIds),
    ...group.branches.flatMap((branch) => branch.factIds),
  ];
}

function idsInLifecycle(lifecycle: StructuredLifecycle): readonly string[] {
  return [
    ...lifecycle.nodes.flatMap((node) => node.factIds),
    ...lifecycle.edges.flatMap((edge) => edge.factIds),
  ];
}

function idsInVariants(groups: readonly StructuredVariantGroup[]): readonly string[] {
  return groups.flatMap((group) => group.rules.flatMap((rule) => rule.factIds));
}

function claimMarkdown(claim: StructuredClaim, facts: readonly CitedFact[]): string {
  const factNumbers = new Map(facts.map((fact, index) => [fact.factId, index + 1] as const));
  const markers = claim.factIds.map((id) => `[${factNumbers.get(id) ?? 0}]`).join("");
  const text = claim.text.trim();
  // A factIds array supports the whole claim. Inject its markers before every
  // sentence terminator, so sentence-local grounding remains deterministic
  // even if the model returned two short sentences in one claim.
  const sentences = text
    .split(/(?<=[。！？])|(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return sentences.map((sentence) => {
    const punctuation = sentence.match(/[。！？.!?]$/)?.[0] ?? "";
    const body = punctuation === "" ? sentence : sentence.slice(0, -punctuation.length).trimEnd();
    return `${body} ${markers}${punctuation}`.trim();
  }).join(" ");
}

function taskMarkdown(task: AgentTaskArtifact, facts: readonly CitedFact[]): string {
  return task.claims.map((claim) => claimMarkdown(claim, facts)).join("\n\n");
}

function lifecycleReaderText(task: AgentTaskArtifact): string {
  return [
    ...task.lifecycles.flatMap((lifecycle) => [
      lifecycle.title,
      lifecycle.summary,
      ...lifecycle.nodes.flatMap((node) => [node.label, node.detail]),
      ...lifecycle.edges.map((edge) => edge.label),
    ]),
    ...task.variantGroups.flatMap((group) => [
      group.title,
      group.summary,
      ...group.rules.flatMap((rule) => [rule.condition, rule.outcome]),
    ]),
  ].join(" ");
}

function approvalLevelsInEvidence(facts: readonly CitedFact[]): readonly number[] {
  const levels = new Set<number>();
  for (const fact of facts.filter(lifecycleTransitionEvidence)) {
    const text = `${sourceLabel(fact)} ${sourceText(fact)}`;
    for (const match of text.matchAll(/(?:waiting|pending)[A-Za-z0-9_]*?L([1-9])[A-Za-z0-9_]*?(?:approve|approval)/gi)) {
      levels.add(Number(match[1]));
    }
  }
  return [...levels].sort((a, b) => a - b);
}

function namesApprovalLevel(text: string, level: number): boolean {
  const chinese = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"][level] ?? String(level);
  return new RegExp(`(?:\\bL\\s*${level}\\b|\\blevel\\s*${level}\\b|\\b${level}(?:st|nd|rd|th)?[- ]level\\b|${chinese}级[^\u3002\uff1b]{0,12}审批|第${chinese}级[^\u3002\uff1b]{0,12}审批)`, "i").test(text);
}

function validateBatch(requests: readonly AuthoringRequest[], response: BatchResponse): readonly string[] {
  const problems: string[] = [];
  const requestById = new Map(requests.map((request) => [request.taskId, request] as const));
  const seen = new Set<string>();
  for (const task of response.tasks) {
    const request = requestById.get(task.taskId);
    if (request === undefined) {
      problems.push(`foreign task ${task.taskId}`);
      continue;
    }
    if (seen.has(task.taskId)) {
      problems.push(`duplicate task ${task.taskId}`);
      continue;
    }
    seen.add(task.taskId);
    if (task.claims.length === 0) problems.push(`task ${task.taskId} has no claims`);
    const bounded = boundedFactsFor(request);
    const allowed = new Set(bounded.map((fact) => fact.factId));
    for (const [index, claim] of task.claims.entries()) {
      if (claim.text.trim().length === 0) problems.push(`task ${task.taskId} claim ${index} has empty text`);
      if (/\[(?:\d|[^\]]*\|)/.test(claim.text)) {
        problems.push(`task ${task.taskId} claim ${index} contains citation markup in text; use factIds only`);
      }
      if (claim.factIds.length === 0) problems.push(`task ${task.taskId} claim ${index} cites no facts`);
      for (const id of claim.factIds) {
        if (!allowed.has(id)) problems.push(`task ${task.taskId} claim ${index} cites foreign fact ${id}`);
      }
    }
    const markdown = taskMarkdown(task, request.facts);
    const grounding = validateGrounding(markdown, request.facts, { requireEveryFactualSentenceCited: true });
    if (!grounding.ok) {
      problems.push(`task ${task.taskId} grounding: ${grounding.ungrounded.map((entry) => entry.detail).join("; ")}`);
    }
    for (const group of task.flowGroups) {
      for (const id of idsInFlow(group)) {
        if (!allowed.has(id)) problems.push(`task ${task.taskId} flow cites foreign fact ${id}`);
      }
      for (const [index, branch] of group.branches.entries()) {
        if (branch.afterStep < 1 || branch.afterStep > group.steps.length) {
          problems.push(`task ${task.taskId} flow ${group.title} branch ${index} points to step ${branch.afterStep}, but has ${group.steps.length} step(s)`);
        }
      }
      const hasFailure = group.branches.some((branch) => branch.kind === "rejection" || branch.kind === "exception");
      const hasSuccess = group.branches.some((branch) => branch.kind === "success");
      if (hasFailure && !hasSuccess) {
        problems.push(`task ${task.taskId} flow ${group.title} presents failure branches without an explicit success path`);
      }
    }
    for (const lifecycle of task.lifecycles) {
      const nodeIds = new Set<string>();
      for (const [index, node] of lifecycle.nodes.entries()) {
        if (node.id.trim() === "" || node.label.trim() === "" || node.detail.trim() === "") {
          problems.push(`task ${task.taskId} lifecycle ${lifecycle.title} node ${index} has an empty field`);
        }
        if (nodeIds.has(node.id)) problems.push(`task ${task.taskId} lifecycle ${lifecycle.title} repeats node id ${node.id}`);
        nodeIds.add(node.id);
        for (const id of node.factIds) if (!allowed.has(id)) problems.push(`task ${task.taskId} lifecycle node cites foreign fact ${id}`);
      }
      for (const [index, edge] of lifecycle.edges.entries()) {
        if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
          problems.push(`task ${task.taskId} lifecycle ${lifecycle.title} edge ${index} references an unknown node`);
        }
        if (edge.label.trim() === "") problems.push(`task ${task.taskId} lifecycle ${lifecycle.title} edge ${index} has an empty label`);
        for (const id of edge.factIds) if (!allowed.has(id)) problems.push(`task ${task.taskId} lifecycle edge cites foreign fact ${id}`);
      }
    }
    for (const [groupIndex, group] of task.variantGroups.entries()) {
      if (group.title.trim() === "" || group.summary.trim() === "") {
        problems.push(`task ${task.taskId} variant group ${groupIndex} has an empty title or summary`);
      }
      for (const [ruleIndex, rule] of group.rules.entries()) {
        if (rule.condition.trim() === "" || rule.outcome.trim() === "") {
          problems.push(`task ${task.taskId} variant group ${groupIndex} rule ${ruleIndex} has an empty field`);
        }
        for (const id of rule.factIds) if (!allowed.has(id)) problems.push(`task ${task.taskId} variant rule cites foreign fact ${id}`);
      }
    }
    for (const [index, issue] of task.issues.entries()) {
      if (issue.title.trim() === "" || issue.observation.trim() === "" || issue.impact.trim() === "") {
        problems.push(`task ${task.taskId} issue ${index} has an empty required field`);
      }
      if (issue.factIds.length === 0) problems.push(`task ${task.taskId} issue ${index} cites no facts`);
      for (const id of issue.factIds) {
        if (!allowed.has(id)) problems.push(`task ${task.taskId} issue ${index} cites foreign fact ${id}`);
      }
    }
    const issueTask = request.blockId === "known-issues.impact";
    if (!issueTask && task.issues.length > 0) problems.push(`task ${task.taskId} must not return issues`);
    if (!flowTask(request) && task.flowGroups.length > 0) problems.push(`task ${task.taskId} must not return flow groups`);
    if (!lifecycleTask(request) && (task.lifecycles.length > 0 || task.variantGroups.length > 0)) {
      problems.push(`task ${task.taskId} must not return lifecycle or variant data`);
    }
    if (lifecycleTask(request)) {
      if (task.lifecycles.length === 0) problems.push(`task ${task.taskId} returned no lifecycle`);
      const lifecycleKinds = new Set(["scheduled-task", "state", "state-transition", "value-set", "condition", "decision", "guard", "business-rule", "validation-rule", "notification-call"]);
      const required = bounded
        .filter((fact) => lifecycleKinds.has(fact.kind) || lifecycleChannelEvidence(fact) || lifecycleTransitionEvidence(fact))
        .map((fact) => fact.factId);
      const placed = new Set([
        ...task.lifecycles.flatMap(idsInLifecycle),
        ...idsInVariants(task.variantGroups),
      ]);
      const missing = required.filter((id) => !placed.has(id));
      if (missing.length > 0) {
        problems.push(`task ${task.taskId} omitted ${missing.length} lifecycle/rule fact(s): ${missing.slice(0, 8).join(", ")}`);
      }
      const readerText = lifecycleReaderText(task);
      const channelText = bounded
        .filter(lifecycleChannelEvidence)
        .map((fact) => `${sourceLabel(fact)} ${sourceText(fact)} ${String(factObject(fact).channel ?? "")}`)
        .join(" ");
      if (/Notify(?:Email|Mail)|email\.InputParam|\b(?:email|mail)\b/i.test(channelText) && !/(?:邮件|电子邮件|\bemail\b|\bmail\b)/i.test(readerText)) {
        problems.push(`task ${task.taskId} omits the evidenced email notification channel from its lifecycle`);
      }
      if (/Notify(?:Mobile|Push)|mobile\s+push|push\s+notification|genMobileComposite/i.test(channelText) && !/(?:移动(?:端)?推送|手机推送|mobile\s+push|push\s+notification)/i.test(readerText)) {
        problems.push(`task ${task.taskId} omits the evidenced mobile-push notification channel from its lifecycle`);
      }
      for (const level of approvalLevelsInEvidence(bounded)) {
        if (!namesApprovalLevel(readerText, level)) {
          problems.push(`task ${task.taskId} omits evidenced approval level L${level} from its lifecycle`);
        }
      }
    }
    if (flowTask(request)) {
      if (task.flowGroups.length === 0) problems.push(`task ${task.taskId} returned no flow groups`);
      if (request.blockId === "module-flows-branches.flows") {
        const required = request.facts.filter((fact) => fact.kind === "feature-flow").map((fact) => fact.factId);
        const placed = new Set(task.flowGroups.flatMap(idsInFlow));
        const missing = required.filter((id) => !placed.has(id));
        if (missing.length > 0) problems.push(`task ${task.taskId} omitted ${missing.length} feature-flow fact(s): ${missing.slice(0, 8).join(", ")}`);
      }
      const requiredBranches = boundedFactsFor(request)
        .filter((fact) => fact.kind === "guard" || fact.kind === "decision")
        .map((fact) => fact.factId);
      const placedBranches = new Set(task.flowGroups.flatMap((group) => group.branches.flatMap((branch) => branch.factIds)));
      const missingBranches = requiredBranches.filter((id) => !placedBranches.has(id));
      if (missingBranches.length > 0) {
        problems.push(`task ${task.taskId} omitted ${missingBranches.length} evidenced branch fact(s): ${missingBranches.slice(0, 8).join(", ")}`);
      }
    }
  }
  for (const request of requests) {
    if (!seen.has(request.taskId)) problems.push(`missing task ${request.taskId}`);
  }
  return problems;
}

interface CachedBatch {
  readonly schemaVersion: string;
  readonly cacheKey: string;
  readonly response: BatchResponse;
}

function readCache(path: string, key: string): BatchResponse | null {
  if (!existsSync(path)) return null;
  try {
    const cached = JSON.parse(readFileSync(path, "utf8")) as CachedBatch;
    return cached.schemaVersion === BATCH_SCHEMA_VERSION && cached.cacheKey === key ? cached.response : null;
  } catch {
    return null;
  }
}

function writeCache(path: string, key: string, response: BatchResponse): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${stableStringify({ schemaVersion: BATCH_SCHEMA_VERSION, cacheKey: key, response })}\n`, "utf8");
  renameSync(tmp, path);
}

export interface PrepareBatchAuthorOptions {
  readonly plan: ReportPlan;
  readonly readers: SliceReaders;
  readonly decisions: DecisionIndex;
  readonly contractsByBlockId: ReadonlyMap<string, AuthoredPromptContract>;
  readonly language: string;
  readonly agent: JsonAgentIdentity;
  readonly cacheDir: string;
  readonly concurrency?: number;
  readonly run?: JsonAgentRunner<BatchResponse>;
}

export interface BatchAuthorPreparation {
  readonly author: ProseAuthor;
  readonly structuredByTask: ReadonlyMap<string, StructuredTaskArtifact>;
  readonly agentCalls: number;
  readonly cacheHits: number;
  readonly agentInputBytes: number;
  readonly agentOutputBytes: number;
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<readonly R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

/** Prepare independently cached section prose, then hand it to the synchronous host seam. */
export async function prepareBatchAuthor(options: PrepareBatchAuthorOptions): Promise<BatchAuthorPreparation> {
  const requests = buildAuthoringRequests(options.plan, options.readers, options.decisions, options.contractsByBlockId);
  mkdirSync(options.cacheDir, { recursive: true });
  let agentCalls = 0;
  let cacheHits = 0;
  let agentInputBytes = 0;
  let agentOutputBytes = 0;
  const responses = await mapConcurrent(requests, options.concurrency ?? 6, async (request) => {
    const documentRequests = [request];
    const documentId = request.documentId;
    const key = digest({
      schemaVersion: BATCH_SCHEMA_VERSION,
      documentId,
      agent: options.agent,
      language: options.language,
      tasks: documentRequests.map((request) => ({
        taskId: request.taskId,
        sectionId: request.sectionId,
        blockId: request.blockId,
        instruction: options.contractsByBlockId.get(request.blockId)?.prompt ?? null,
        promptPolicyVersion: promptPolicyVersion(request.blockId),
        // Fact ids alone are not a safe cache identity: a provider may preserve
        // an identity while correcting the fact value or evidence payload.
        facts: boundedFactsFor(request),
      })),
    });
    const path = join(options.cacheDir, `${key}.json`);
    const cached = readCache(path, key);
    if (cached !== null && validateBatch(documentRequests, cached).length === 0) {
      cacheHits += 1;
      return cached;
    }

    let correction: string | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      agentCalls += 1;
      const prompt = promptForDocument(documentId, documentRequests, options.contractsByBlockId, options.language, correction);
      const promptBytes = Buffer.byteLength(prompt, "utf8");
      if (promptBytes > MAX_TASK_PROMPT_BYTES) {
        throw new Error(`authored task ${request.taskId} is ${promptBytes} bytes; bounded V1 limit is ${MAX_TASK_PROMPT_BYTES}`);
      }
      agentInputBytes += promptBytes;
      const response = await runJsonAgent<BatchResponse>({
        prompt,
        schema: BATCH_SCHEMA,
        identity: options.agent,
        ...(options.run === undefined ? {} : { run: options.run }),
      });
      agentOutputBytes += Buffer.byteLength(stableStringify(response), "utf8");
      const problems = validateBatch(documentRequests, response);
      if (problems.length === 0) {
        writeCache(path, key, response);
        return response;
      }
      correction = problems.slice(0, 20).join("\n");
    }
    throw new Error(`authored task ${request.taskId} failed validation after 3 attempts: ${correction ?? "unknown validation error"}`);
  });

  const structuredByTask = new Map<string, StructuredTaskArtifact>();
  const requestByTaskId = new Map(requests.map((request) => [request.taskId, request] as const));
  for (const response of responses) {
    for (const task of response.tasks) {
      const request = requestByTaskId.get(task.taskId);
      if (request === undefined) throw new Error(`validated response contains unknown task ${task.taskId}`);
      structuredByTask.set(task.taskId, {
        taskId: task.taskId,
        markdown: taskMarkdown(task, request.facts),
        flowGroups: task.flowGroups,
        lifecycles: task.lifecycles,
        variantGroups: task.variantGroups,
        issues: task.issues,
      });
    }
  }
  const author: ProseAuthor = (request) => {
    const task = structuredByTask.get(request.taskId);
    return task === undefined ? null : { prose: task.markdown };
  };
  return { author, structuredByTask, agentCalls, cacheHits, agentInputBytes, agentOutputBytes };
}
