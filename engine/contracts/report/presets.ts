/**
 * The four fixed document views, each selecting from the shared section catalog.
 *
 * A preset is scope × audience: project/product, project/developer, module
 * product detail, module developer detail. Each includes the shared sections
 * (identity, fact ledger, coverage, problem ledger) plus the sections for its
 * own scope and audience. A module preset never includes a project-scope
 * section — a module detail references the project overview, it does not repeat
 * it.
 */

import { SECTION_CATALOG, type SectionDefinition, sectionById } from "./catalog.js";

export type DocumentScope = "project" | "module";
export type DocumentAudience = "product" | "developer";

export interface DocumentPreset {
  readonly id: string;
  readonly scope: DocumentScope;
  readonly audience: DocumentAudience;
  readonly requiredSectionIds: readonly string[];
  readonly optionalSectionIds: readonly string[];
}

function buildPreset(id: string, scope: DocumentScope, audience: DocumentAudience): DocumentPreset {
  const relevant = SECTION_CATALOG.filter(
    (s) =>
      (s.scope === "shared" && s.audience === "shared") ||
      (s.scope === scope && s.audience === audience),
  );
  return {
    id,
    scope,
    audience,
    requiredSectionIds: relevant.filter((s) => s.requirement === "required").map((s) => s.id),
    optionalSectionIds: relevant.filter((s) => s.requirement === "optional").map((s) => s.id),
  };
}

export const PROJECT_PRODUCT = buildPreset("project-product", "project", "product");
export const PROJECT_DEVELOPER = buildPreset("project-developer", "project", "developer");
export const MODULE_PRODUCT_DETAIL = buildPreset("module-product-detail", "module", "product");
export const MODULE_DEVELOPER_DETAIL = buildPreset("module-developer-detail", "module", "developer");

export const DOCUMENT_PRESETS: readonly DocumentPreset[] = [
  PROJECT_PRODUCT,
  PROJECT_DEVELOPER,
  MODULE_PRODUCT_DETAIL,
  MODULE_DEVELOPER_DETAIL,
];

export function presetFor(scope: DocumentScope, audience: DocumentAudience): DocumentPreset {
  const preset = DOCUMENT_PRESETS.find((p) => p.scope === scope && p.audience === audience);
  if (!preset) throw new Error(`no document preset for ${scope}/${audience}`);
  return preset;
}

export function resolveSections(preset: DocumentPreset): {
  readonly required: readonly SectionDefinition[];
  readonly optional: readonly SectionDefinition[];
} {
  const look = (ids: readonly string[]): SectionDefinition[] =>
    ids.map((id) => {
      const definition = sectionById(id);
      if (!definition) throw new Error(`preset ${preset.id} references unknown section ${id}`);
      return definition;
    });
  return { required: look(preset.requiredSectionIds), optional: look(preset.optionalSectionIds) };
}

export type PresetValidation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function validatePreset(preset: DocumentPreset): PresetValidation {
  for (const id of [...preset.requiredSectionIds, ...preset.optionalSectionIds]) {
    const definition = sectionById(id);
    if (!definition) return { ok: false, reason: `unknown section ${id}` };
    if (definition.blocks.length === 0) return { ok: false, reason: `section ${id} has no blocks` };
    for (const block of definition.blocks) {
      if (block.outputSchemaId.length === 0) return { ok: false, reason: `block ${block.id} has no output schema` };
    }
  }
  return { ok: true };
}
