/**
 * The product-manager report preset — the three content domains (PI-43 boundary,
 * PI-44 flows, PI-45 effects) integrated into one audience contract.
 *
 * This binds the catalog's product sections, for project and module scope, to the
 * authored-block contracts the content leaves define, adds the two project-scope
 * authored blocks that complete the set, and turns "a PM can understand this" into
 * a structural check: every required product-manager question maps to a real
 * section, every authored block in the preset has a contract, and every contract
 * names a real catalog block. It does not re-implement a section — it composes and
 * validates them, and shares the same facts as the developer report while keeping
 * a non-technical voice.
 */

import type { FactKind } from "../../contracts/shared-fact/families.js";
import { type SectionDefinition, sectionById } from "../../contracts/report/catalog.js";
import { MODULE_PRODUCT_DETAIL, PROJECT_PRODUCT, resolveSections } from "../../contracts/report/presets.js";
import { PM_STRUCTURE_AUTHORED_BLOCKS } from "../content/boundary.js";
import { PM_FLOWS_AUTHORED_BLOCKS } from "../content/flows.js";
import { PM_EFFECTS_AUTHORED_BLOCKS } from "../content/effects.js";

export interface AuthoredBlockContract {
  readonly blockId: string;
  readonly outputSchemaId: string;
  readonly promptId: string;
  readonly citationRule: "required";
  readonly validatorId: string;
  readonly inputFactKinds: readonly FactKind[];
  readonly prompt: string;
}

const PM_AUDIENCE_RULES = [
  "Write for a product manager: describe the current, observable behaviour in business language.",
  "State only what the cited facts support; never invent a capability, name, path or number, and cite every claim by its fact id.",
  "Do not present an implementation detail as a product requirement, and do not add a subjective priority, a remediation, a future requirement or a roadmap.",
].join("\n");

/**
 * project-roles-flows.paths — the project's main cross-module business paths. A
 * project-scope authored block completed here, as the parent that unifies the PM
 * preset across the content leaves.
 */
export const PROJECT_BUSINESS_PATHS_BLOCK: AuthoredBlockContract = {
  blockId: "project-roles-flows.paths",
  outputSchemaId: "business-paths.v1",
  promptId: "business-paths.v1",
  citationRule: "required",
  validatorId: "business-paths.v1",
  inputFactKinds: ["route", "condition"],
  prompt: `Describe the project's main cross-module business paths from the entries and branches you are given — the happy path and the visible rejections. Summarise across modules; do not expand every module's internals.\n\n${PM_AUDIENCE_RULES}`,
};

/** project-objects-lifecycle.rules — the project's cross-module rules, states and exceptions. */
export const PROJECT_CROSS_MODULE_RULES_BLOCK: AuthoredBlockContract = {
  blockId: "project-objects-lifecycle.rules",
  outputSchemaId: "cross-module-rules.v1",
  promptId: "cross-module-rules.v1",
  citationRule: "required",
  validatorId: "cross-module-rules.v1",
  inputFactKinds: ["condition", "state-transition"],
  prompt: `Describe the core business objects' cross-module rules, states and exceptions from the facts you are given, keeping state names verbatim. Summarise the project-level rules; module detail belongs to the module reports.\n\n${PM_AUDIENCE_RULES}`,
};

/** Every authored-required block the PM preset relies on, from the three leaves plus the two project-scope blocks. */
export const PM_AUTHORED_BLOCKS: readonly AuthoredBlockContract[] = [
  ...PM_STRUCTURE_AUTHORED_BLOCKS,
  ...PM_FLOWS_AUTHORED_BLOCKS,
  ...PM_EFFECTS_AUTHORED_BLOCKS,
  PROJECT_BUSINESS_PATHS_BLOCK,
  PROJECT_CROSS_MODULE_RULES_BLOCK,
];

export type QuestionScope = "shared" | "project" | "module";

/** A product-manager question the preset must answer, mapped to the section that answers it. */
export interface PmQuestion {
  readonly id: string;
  readonly question: string;
  readonly sectionId: string;
  readonly scope: QuestionScope;
}

export const PM_QUESTIONS: readonly PmQuestion[] = [
  { id: "identity", question: "What was analysed, and under which run and source snapshot?", sectionId: "identity", scope: "shared" },
  { id: "facts", question: "What facts back the report, with citation and provenance?", sectionId: "fact-ledger", scope: "shared" },
  { id: "coverage", question: "What was covered, and what are the gaps?", sectionId: "coverage", scope: "shared" },
  { id: "known-issues", question: "What are the known problems and their impact?", sectionId: "known-issues", scope: "shared" },
  { id: "project-boundary", question: "What is the system made of — boundary, capabilities and module map?", sectionId: "project-boundary", scope: "project" },
  { id: "project-roles", question: "Who enters from where, and what are the main business paths?", sectionId: "project-roles-flows", scope: "project" },
  { id: "project-objects", question: "What are the core objects, their lifecycle and cross-module rules/states/exceptions?", sectionId: "project-objects-lifecycle", scope: "project" },
  { id: "project-effects", question: "What notifications, integrations and data impact does the project have?", sectionId: "project-notifications-data", scope: "project" },
  { id: "module-responsibility", question: "What is the module responsible for, and its up/downstream?", sectionId: "module-responsibility", scope: "module" },
  { id: "module-flows", question: "What are the module's roles, entries, flows and evidenced branches?", sectionId: "module-flows-branches", scope: "module" },
  { id: "module-objects", question: "What are the module's objects, rules, states, validation, permissions and exceptions?", sectionId: "module-objects-rules-states", scope: "module" },
  { id: "module-recovery", question: "What withdraw/cancel/retry/compensate/recover behaviours are there?", sectionId: "module-recovery", scope: "module" },
  { id: "module-effects", question: "What notifications, integrations and data impact does the module have?", sectionId: "module-notifications-data", scope: "module" },
];

/** The product sections for a scope: the shared sections plus that scope's own. */
export function pmPresetSections(scope: "project" | "module"): readonly SectionDefinition[] {
  const preset = scope === "project" ? PROJECT_PRODUCT : MODULE_PRODUCT_DETAIL;
  const { required, optional } = resolveSections(preset);
  return [...required, ...optional];
}

export type PresetValidation = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Validate that the PM preset is complete and consistent: every required question
 * maps to a real section; both the project and module product presets resolve;
 * every authored block in those presets has a contract; and every contract names a
 * real catalog block with the matching output schema. A gap here means a document
 * that cannot be finished, so it fails closed.
 */
export function validatePmPreset(): PresetValidation {
  const reasons: string[] = [];

  for (const q of PM_QUESTIONS) {
    if (sectionById(q.sectionId) === undefined) reasons.push(`question ${q.id} maps to unknown section ${q.sectionId}`);
  }

  const catalogSchema = (blockId: string): string | undefined => {
    for (const section of [...pmPresetSections("project"), ...pmPresetSections("module")]) {
      const block = section.blocks.find((b) => b.id === blockId);
      if (block) return block.outputSchemaId;
    }
    return undefined;
  };

  // Every authored-required block in the preset must have a contract.
  const contractByBlock = new Map(PM_AUTHORED_BLOCKS.map((b) => [b.blockId, b] as const));
  const seen = new Set<string>();
  for (const section of [...pmPresetSections("project"), ...pmPresetSections("module")]) {
    if (seen.has(section.id)) continue;
    seen.add(section.id);
    for (const block of section.blocks) {
      if (block.kind !== "authored-required") continue;
      const contract = contractByBlock.get(block.id);
      if (contract === undefined) reasons.push(`authored block ${block.id} has no PM content contract`);
      else if (contract.outputSchemaId !== block.outputSchemaId) {
        reasons.push(`authored block ${block.id} schema ${contract.outputSchemaId} ≠ catalog ${block.outputSchemaId}`);
      }
    }
  }

  // Every contract must name a real catalog block with the matching schema.
  for (const contract of PM_AUTHORED_BLOCKS) {
    const schema = catalogSchema(contract.blockId);
    if (schema === undefined) reasons.push(`contract ${contract.blockId} names no catalog block in the PM preset`);
    else if (schema !== contract.outputSchemaId) reasons.push(`contract ${contract.blockId} schema ${contract.outputSchemaId} ≠ catalog ${schema}`);
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
