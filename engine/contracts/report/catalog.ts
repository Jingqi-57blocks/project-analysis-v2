/**
 * The shared section catalog.
 *
 * One catalog serves all four document views; each view's preset selects from
 * it. Sections marked `shared` scope/audience carry claims common to every
 * document (identity, the fact ledger, coverage, the problem ledger), so a
 * shared claim keeps one fact ID and citation wherever it appears. Project-scope
 * and module-scope sections are distinct: a module detail references the project
 * overview rather than repeating it.
 *
 * This is the versioned skeleton. The block output schemas, prompts and
 * validators are implemented in M3; this fixes the structure and responsibility.
 */

import type { FactKind } from "../shared-fact/families.js";
import { authoredBlock, type ContentBlock, deterministicBlock } from "./blocks.js";

export type SectionRequirement = "required" | "optional";
export type SectionScope = "project" | "module" | "shared";
export type SectionAudience = "product" | "developer" | "shared";

export interface SectionDefinition {
  readonly id: string;
  readonly title: string;
  readonly requirement: SectionRequirement;
  readonly scope: SectionScope;
  readonly audience: SectionAudience;
  /** Ordered blocks; a section is reader structure, not one AI call. */
  readonly blocks: readonly ContentBlock[];
  /** Fact kinds the section reads — the union of its blocks'. */
  readonly inputFactKinds: readonly FactKind[];
  /** When the section is satisfied, as opposed to a partial skeleton. */
  readonly successCondition: string;
}

function section(
  id: string,
  title: string,
  requirement: SectionRequirement,
  scope: SectionScope,
  audience: SectionAudience,
  blocks: readonly ContentBlock[],
  successCondition: string,
): SectionDefinition {
  const inputFactKinds = [...new Set(blocks.flatMap((b) => b.inputFactKinds))].sort();
  return { id, title, requirement, scope, audience, blocks, inputFactKinds, successCondition };
}

const SHARED_SECTIONS: readonly SectionDefinition[] = [
  section("identity", "Scope, source and run identity", "required", "shared", "shared", [
    deterministicBlock("identity.table", ["run-identity", "scope-identity"], "identity.v1"),
  ], "scope, source snapshot and run identity are all present"),
  section("fact-ledger", "Fact ledger", "required", "shared", "shared", [
    deterministicBlock("fact-ledger.table", ["*"], "fact-ledger.v1", true),
  ], "every cited fact resolves to an id, citation, provenance and resolution"),
  section("coverage", "Coverage and gaps", "required", "shared", "shared", [
    deterministicBlock("coverage.table", ["coverage", "gap"], "coverage.v1"),
  ], "coverage, gap and truncation are accounted with the three-state disclosure"),
  section("known-issues", "Known issues and impact", "required", "shared", "shared", [
    deterministicBlock("known-issues.ledger", ["diagnostic"], "problem-ledger.v1", true),
    authoredBlock("known-issues.impact", ["diagnostic"], "problem-impact.v1", true),
  ], "each problem has an id, category, evidence and an impact boundary"),
];

const PROJECT_PRODUCT_SECTIONS: readonly SectionDefinition[] = [
  section("project-boundary", "Project boundary and capabilities", "required", "project", "product", [
    deterministicBlock("project-boundary.map", ["module", "module-containment"], "module-map.v1"),
    authoredBlock("project-boundary.capabilities", ["module", "route"], "capabilities.v1"),
  ], "the module map and product capabilities are present"),
  section("project-roles-flows", "Roles, entry points and main paths", "required", "project", "product", [
    deterministicBlock("project-roles-flows.entries", ["route", "auth-annotation"], "entry-list.v1"),
    authoredBlock("project-roles-flows.paths", ["route", "condition"], "business-paths.v1"),
  ], "roles, entry points and the main cross-module paths are present"),
  section("project-objects-lifecycle", "Core objects, lifecycle and cross-module rules", "required", "project", "product", [
    deterministicBlock("project-objects-lifecycle.states", ["entity", "state-transition"], "lifecycle.v1"),
    authoredBlock("project-objects-lifecycle.rules", ["condition", "state-transition"], "cross-module-rules.v1"),
  ], "core objects, their lifecycle and cross-module rules/states/exceptions are present"),
  section("project-notifications-data", "Notifications, integrations and data impact", "required", "project", "product", [
    deterministicBlock("project-notifications-data.effects", ["outbound-call", "notification-call", "data-access"], "effects.v1"),
  ], "notifications, external integrations and data impact are present"),
];

const PROJECT_DEVELOPER_SECTIONS: readonly SectionDefinition[] = [
  section("project-architecture", "Architecture and technical boundaries", "required", "project", "developer", [
    deterministicBlock("project-architecture.map", ["module", "module-containment", "package-dependency"], "architecture.v1"),
    authoredBlock("project-architecture.boundaries", ["module"], "architecture-notes.v1"),
  ], "repository/module architecture and technical boundaries are present"),
  section("project-callpaths", "Entry points, symbols and call paths", "required", "project", "developer", [
    deterministicBlock("project-callpaths.graph", ["symbol", "call-edge", "reference"], "callpaths.v1"),
  ], "entry points, symbols and cross-repository call/reference paths are present"),
  section("project-control-boundaries", "Rules, state and control boundaries", "required", "project", "developer", [
    deterministicBlock("project-control-boundaries.facts", ["condition", "state-transition", "auth-annotation", "validation-rule"], "control.v1"),
    authoredBlock("project-control-boundaries.notes", ["auth-annotation"], "control-notes.v1"),
  ], "behaviour rules, state implementation and auth/permission/validation boundaries are present"),
  section("project-data-effects", "Data model, transactions and external calls", "required", "project", "developer", [
    deterministicBlock("project-data-effects.model", ["entity", "entity-relation", "data-access", "transaction-boundary", "outbound-call", "notification-call"], "data-effects.v1"),
  ], "data model, reads/writes, transactions, external calls and notifications are present"),
  section("project-ops-entrypoints", "Build, test, config and observability", "optional", "project", "developer", [
    deterministicBlock("project-ops-entrypoints.facts", ["build-target", "test-relation"], "ops.v1"),
  ], "build, test, config, deploy and observability entry points are present where evidenced"),
  section("project-impl-issues", "Implementation issues and change impact", "required", "project", "developer", [
    deterministicBlock("project-impl-issues.diagnostics", ["diagnostic", "test-relation"], "impl-issues.v1"),
    authoredBlock("project-impl-issues.impact", ["diagnostic"], "change-impact.v1"),
  ], "confirmed implementation issues, test evidence, change impact and gaps are present"),
];

const MODULE_PRODUCT_SECTIONS: readonly SectionDefinition[] = [
  section("module-responsibility", "Module responsibility and boundary", "required", "module", "product", [
    deterministicBlock("module-responsibility.neighbours", ["module-containment", "call-edge"], "module-neighbours.v1"),
    authoredBlock("module-responsibility.summary", ["module"], "module-responsibility.v1"),
  ], "module responsibility, boundary and up/downstream are present"),
  section("module-flows-branches", "Roles, flows and evidenced branches", "required", "module", "product", [
    deterministicBlock("module-flows-branches.branches", ["condition", "decision", "route"], "module-branches.v1"),
    authoredBlock("module-flows-branches.flows", ["condition", "decision"], "module-flows.v1"),
  ], "module roles, entry points, flows and all evidenced visible branches are present"),
  section("module-objects-rules-states", "Objects, rules, states, validation and exceptions", "required", "module", "product", [
    deterministicBlock("module-objects-rules-states.facts", ["entity", "state-transition", "validation-rule", "auth-annotation", "discarded-error"], "module-rules.v1"),
    authoredBlock("module-objects-rules-states.notes", ["state-transition"], "module-rules-notes.v1"),
  ], "core objects, lifecycle, rules, states, validation, permissions and exceptions are present"),
  section("module-recovery", "Withdraw, cancel, retry, compensate or recover", "optional", "module", "product", [
    authoredBlock("module-recovery.notes", ["state-transition", "condition"], "module-recovery.v1"),
  ], "recovery behaviours are present where applicable"),
  section("module-notifications-data", "Notifications, integrations and data impact", "required", "module", "product", [
    deterministicBlock("module-notifications-data.effects", ["outbound-call", "notification-call", "data-access"], "module-effects.v1"),
    authoredBlock("module-notifications-data.notes", ["outbound-call"], "module-effects-notes.v1"),
  ], "module notifications, integrations and data impact are present"),
];

const MODULE_DEVELOPER_SECTIONS: readonly SectionDefinition[] = [
  section("module-code-boundary", "Code boundary, entry points and key symbols", "required", "module", "developer", [
    deterministicBlock("module-code-boundary.symbols", ["symbol", "route", "export"], "module-symbols.v1"),
  ], "module code boundary, entry points and key symbols are present"),
  section("module-callpaths-deps", "Upstream/downstream calls, references and dependencies", "required", "module", "developer", [
    deterministicBlock("module-callpaths-deps.graph", ["call-edge", "reference", "import"], "module-callpaths.v1"),
  ], "up/downstream calls, references and dependencies are present"),
  section("module-branches-rules-states", "Branches, rules, states and implementation locations", "required", "module", "developer", [
    deterministicBlock("module-branches-rules-states.facts", ["condition", "decision", "state-transition"], "module-branch-facts.v1"),
  ], "branches, rules, states and their implementation locations are present"),
  section("module-data-control-errors", "Data access, effects, control and error paths", "required", "module", "developer", [
    deterministicBlock("module-data-control-errors.facts", ["data-access", "transaction-boundary", "outbound-call", "notification-call", "auth-annotation", "validation-rule", "error-handling"], "module-data-control.v1"),
    authoredBlock("module-data-control-errors.notes", ["error-handling"], "module-error-notes.v1"),
  ], "data access, transactions, external calls, notifications, auth/permission/validation and error paths are present"),
  section("module-impl-issues", "Implementation issues, tests and change impact", "required", "module", "developer", [
    deterministicBlock("module-impl-issues.diagnostics", ["diagnostic", "test-relation"], "module-impl-issues.v1"),
    authoredBlock("module-impl-issues.impact", ["diagnostic"], "module-change-impact.v1"),
  ], "confirmed implementation issues, related tests, change impact, fragility and gaps are present"),
];

export const SECTION_CATALOG: readonly SectionDefinition[] = [
  ...SHARED_SECTIONS,
  ...PROJECT_PRODUCT_SECTIONS,
  ...PROJECT_DEVELOPER_SECTIONS,
  ...MODULE_PRODUCT_SECTIONS,
  ...MODULE_DEVELOPER_SECTIONS,
];

export function sectionById(id: string): SectionDefinition | undefined {
  return SECTION_CATALOG.find((s) => s.id === id);
}
