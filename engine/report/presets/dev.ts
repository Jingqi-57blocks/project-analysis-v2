/**
 * The developer report preset — the three content domains (PI-46 architecture,
 * PI-47 data/control, PI-48 tests/impact/fragility) integrated into one audience
 * contract.
 *
 * This binds the catalog's developer sections, for project and module scope, to
 * the authored-block contracts the content leaves define, and turns "a developer
 * can locate and reason about this" into a structural check: every required
 * developer question maps to a real section, every authored block in the preset
 * has a contract, and every contract names a real catalog block. Every developer
 * authored block already has a contract from the content leaves — this preset
 * composes and validates them, and shares the same facts as the product report
 * while keeping technical precision (real symbols, paths, source locations).
 */

import type { FactKind } from "../../contracts/shared-fact/families.js";
import type { SectionApplicability } from "../../contracts/shared-fact/applicability.js";
import { type SectionDefinition, sectionById } from "../../contracts/report/catalog.js";
import { MODULE_DEVELOPER_DETAIL, PROJECT_DEVELOPER, resolveSections } from "../../contracts/report/presets.js";
import type { SectionApplicabilityDecision } from "../applicability.js";
import { DEV_ARCHITECTURE_AUTHORED_BLOCKS } from "../content/architecture.js";
import { DEV_DATAFLOW_AUTHORED_BLOCKS } from "../content/dataflow.js";
import { DEV_IMPL_AUTHORED_BLOCKS } from "../content/impl-issues.js";
import { KNOWN_ISSUES_IMPACT_BLOCK } from "../content/effects.js";

export interface AuthoredBlockContract {
  readonly blockId: string;
  readonly outputSchemaId: string;
  readonly promptId: string;
  readonly citationRule: "required";
  readonly validatorId: string;
  readonly inputFactKinds: readonly FactKind[];
  readonly prompt: string;
}

/** Set-equality over fact kinds — order-independent, duplicate-tolerant. */
function sameKinds(a: readonly FactKind[], b: readonly FactKind[]): boolean {
  const as = new Set(a);
  const bs = new Set(b);
  return as.size === bs.size && [...as].every((k) => bs.has(k));
}

/** Every authored-required block the developer preset relies on, from the content leaves and the shared ledger block. */
export const DEV_AUTHORED_BLOCKS: readonly AuthoredBlockContract[] = [
  ...DEV_ARCHITECTURE_AUTHORED_BLOCKS,
  ...DEV_DATAFLOW_AUTHORED_BLOCKS,
  ...DEV_IMPL_AUTHORED_BLOCKS,
  KNOWN_ISSUES_IMPACT_BLOCK,
];

export type QuestionScope = "shared" | "project" | "module";

export interface DevQuestion {
  readonly id: string;
  readonly question: string;
  readonly sectionId: string;
  readonly scope: QuestionScope;
}

export const DEV_QUESTIONS: readonly DevQuestion[] = [
  { id: "identity", question: "What was analysed, and under which run and source snapshot?", sectionId: "identity", scope: "shared" },
  { id: "facts", question: "What facts back the report, with citation and provenance?", sectionId: "fact-ledger", scope: "shared" },
  { id: "coverage", question: "What was covered, and what are the gaps?", sectionId: "coverage", scope: "shared" },
  { id: "known-issues", question: "What are the confirmed problems and their impact?", sectionId: "known-issues", scope: "shared" },
  { id: "project-architecture", question: "What is the repository/module architecture and its technical boundaries?", sectionId: "project-architecture", scope: "project" },
  { id: "project-callpaths", question: "What are the entry points, symbols and cross-repository call/reference paths?", sectionId: "project-callpaths", scope: "project" },
  { id: "project-control", question: "What are the behaviour rules, state implementation and auth/permission/validation boundaries?", sectionId: "project-control-boundaries", scope: "project" },
  { id: "project-data", question: "What is the data model, its reads/writes, transactions, external calls and notifications?", sectionId: "project-data-effects", scope: "project" },
  { id: "project-ops", question: "What are the build, test, config, deploy and observability entry points?", sectionId: "project-ops-entrypoints", scope: "project" },
  { id: "project-impl", question: "What are the confirmed implementation issues, test evidence, change impact and gaps?", sectionId: "project-impl-issues", scope: "project" },
  { id: "module-boundary", question: "What is the module's code boundary, entry points and key symbols?", sectionId: "module-code-boundary", scope: "module" },
  { id: "module-callpaths", question: "What are the up/downstream calls, references and dependencies?", sectionId: "module-callpaths-deps", scope: "module" },
  { id: "module-branches", question: "What are the branches, rules, states and their implementation locations?", sectionId: "module-branches-rules-states", scope: "module" },
  { id: "module-data", question: "What are the data access, transactions, external calls, auth/validation and error paths?", sectionId: "module-data-control-errors", scope: "module" },
  { id: "module-impl", question: "What are the confirmed implementation issues, related tests, change impact and gaps?", sectionId: "module-impl-issues", scope: "module" },
];

/** The developer sections for a scope: the shared sections plus that scope's own. */
export function devPresetSections(scope: "project" | "module"): readonly SectionDefinition[] {
  const preset = scope === "project" ? PROJECT_DEVELOPER : MODULE_DEVELOPER_DETAIL;
  const { required, optional } = resolveSections(preset);
  return [...required, ...optional];
}

export type PresetValidation = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Validate that the developer preset is complete and consistent: every required
 * question maps to a real section; every product section answers a question; both
 * developer presets resolve; every authored-required block has a contract; and
 * every contract names a real catalog block with the matching output schema and
 * fact kinds. A gap here means a document that cannot be finished, so it fails closed.
 */
export function validateDevPreset(): PresetValidation {
  const reasons: string[] = [];

  for (const q of DEV_QUESTIONS) {
    if (sectionById(q.sectionId) === undefined) reasons.push(`question ${q.id} maps to unknown section ${q.sectionId}`);
  }

  const questionSections = new Set(DEV_QUESTIONS.map((q) => q.sectionId));
  const contractByBlock = new Map(DEV_AUTHORED_BLOCKS.map((b) => [b.blockId, b] as const));
  const sections = [...devPresetSections("project"), ...devPresetSections("module")];
  const seen = new Set<string>();
  for (const section of sections) {
    if (seen.has(section.id)) continue;
    seen.add(section.id);
    if (!questionSections.has(section.id)) reasons.push(`section ${section.id} answers no developer question`);
    for (const block of section.blocks) {
      if (block.kind !== "authored-required") continue;
      const contract = contractByBlock.get(block.id);
      if (contract === undefined) {
        reasons.push(`authored block ${block.id} has no developer content contract`);
        continue;
      }
      if (contract.outputSchemaId !== block.outputSchemaId) reasons.push(`authored block ${block.id} schema ${contract.outputSchemaId} ≠ catalog ${block.outputSchemaId}`);
      if (!sameKinds(contract.inputFactKinds, block.inputFactKinds)) reasons.push(`authored block ${block.id} input fact kinds differ from the catalog`);
    }
  }

  const catalogSchema = (blockId: string): string | undefined => {
    for (const section of sections) {
      const block = section.blocks.find((b) => b.id === blockId);
      if (block) return block.outputSchemaId;
    }
    return undefined;
  };
  for (const contract of DEV_AUTHORED_BLOCKS) {
    const schema = catalogSchema(contract.blockId);
    if (schema === undefined) reasons.push(`contract ${contract.blockId} names no catalog block in the developer preset`);
    else if (schema !== contract.outputSchemaId) reasons.push(`contract ${contract.blockId} schema ${contract.outputSchemaId} ≠ catalog ${schema}`);
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export interface DevQuestionStatus {
  readonly questionId: string;
  readonly sectionId: string;
  readonly applicability: SectionApplicability;
  readonly reason: string;
}

/**
 * Bind each required developer question to its section's applicability, so every
 * question is either answered (`included`) or carries a structured `not-applicable`
 * / `unknown` reason — the two never conflated, an undecided section never silently
 * answered.
 */
export function devQuestionCoverage(
  decisionsBySection: Readonly<Record<string, SectionApplicabilityDecision>>,
): readonly DevQuestionStatus[] {
  return DEV_QUESTIONS.map((q) => {
    const decision = decisionsBySection[q.sectionId];
    return {
      questionId: q.id,
      sectionId: q.sectionId,
      applicability: decision?.applicability ?? "unknown",
      reason: decision?.reason ?? "no applicability decision was made for this section",
    };
  });
}
