/**
 * Module identity, separated from module display names.
 *
 * Module classification currently produces reader-facing names alongside the
 * grouping itself, which puts language inside identity: changing the output
 * language reruns classification, and a rerun can group differently. A Chinese
 * edition with 21 modules and an English one with 19 is a defect, not a variation.
 *
 * So identity is structural and computed once; a display name is an attribute of
 * it, generated per language on demand. **Changing language MUST NOT change the
 * number of modules or where their boundaries fall.**
 *
 * Addressing follows from the same split. A user writes `--module leave`; if that
 * matched a generated display name, two runs could disagree ("Leave management"
 * vs "Leave and time off") and the command would break. An id is structural, and
 * every display name and historical alias resolves to one.
 */

export const MODULE_CONTRACT_ID = "module-identity";
export const MODULE_CONTRACT_VERSION = "1.0.0";

/**
 * What a module is, structurally. Not a judgement about quality or importance —
 * only what the shape of its code says it plays the part of.
 */
export type ModuleCategory =
  | "product-capability"
  | "aggregate-entry"
  | "technical-component"
  | "infrastructure"
  | "external";

export const MODULE_CATEGORIES: readonly ModuleCategory[] = [
  "product-capability",
  "aggregate-entry",
  "technical-component",
  "infrastructure",
  "external",
];

export interface ModuleIdentity {
  /** Stable, structural, language-independent. */
  readonly id: string;
  /** The structural name the grouping was formed on — a code term, not prose. */
  readonly structuralName: string;
  readonly category: ModuleCategory;
  readonly rootNames: readonly string[];
  /** Earlier structural names that resolved to this module. */
  readonly aliases: readonly string[];
}

/** A module's name for one language. An attribute of the identity, never part of it. */
export interface ModuleDisplayName {
  readonly moduleId: string;
  /** BCP-47-ish tag, uninterpreted: the contract does not restrict languages. */
  readonly language: string;
  readonly name: string;
}

/**
 * Structural signals a classifier can see. Deliberately counts and names only —
 * nothing that could carry a target project's vocabulary into this contract.
 */
export interface ModuleShape {
  readonly endpointCount: number;
  readonly dataEntityCount: number;
  readonly outboundTargetCount: number;
  readonly symbolCount: number;
  /** How many other modules reach into it. */
  readonly dependentCount: number;
}

/**
 * Which part a module plays, from its shape alone.
 *
 * Ordered from most to least specific. Every branch keys on counts, so the same
 * rules hold for any project in any language.
 *
 * Measured limitation: on the reference snapshot all 39 modules classify as
 * `product-capability`, because module formation is entry-point driven and every
 * formed module therefore owns both endpoints and entities. Separating a product
 * capability from an aggregate entry needs a signal the module facts do not yet
 * carry — whether the module is reader-facing, or whether it owns its entities or
 * merely reads another module's. Supplying that is an analysis-layer change. The
 * axis is kept because the contract needs it; it does not yet discriminate.
 */
export function categorize(shape: ModuleShape): ModuleCategory {
  if (shape.endpointCount === 0 && shape.symbolCount === 0 && shape.outboundTargetCount > 0) return "external";
  if (shape.endpointCount > 0 && shape.dataEntityCount > 0) return "product-capability";
  if (shape.endpointCount > 0 && shape.dataEntityCount === 0) return "aggregate-entry";
  if (shape.endpointCount === 0 && shape.dependentCount > 0) return "technical-component";
  return "infrastructure";
}

/**
 * Fold a structural name to its matching form.
 *
 * Plural and case differences are spelling, not identity: a report that scopes
 * `leave` and a store that formed `leaves` are the same module, and making the
 * user know which spelling the analyser chose would be a poor contract.
 */
export function normalizeRef(ref: string): string {
  return ref
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/(?:ies|s)$/, (suffix) => (suffix === "ies" ? "y" : ""));
}

export class UnresolvedModuleError extends Error {
  constructor(
    readonly ref: string,
    readonly known: readonly string[],
  ) {
    super(
      `module "${ref}" did not resolve. Known modules: ${known.slice(0, 20).join(", ")}${known.length > 20 ? ", …" : ""}`,
    );
    this.name = "UnresolvedModuleError";
  }
}

export interface ModuleDirectory {
  readonly identities: readonly ModuleIdentity[];
  readonly displayNames: readonly ModuleDisplayName[];
}

/**
 * Resolve a user-supplied reference to exactly one module.
 *
 * Accepts the id, the structural name, any language's display name, or a
 * historical alias. **Fails closed**: an unknown reference throws rather than
 * widening to the whole project, which would silently answer a different
 * question than the one asked. An ambiguous reference throws too — quietly
 * picking one would be worse than saying so.
 */
export function resolveModuleRef(directory: ModuleDirectory, ref: string): ModuleIdentity {
  const wanted = normalizeRef(ref);
  const byId = directory.identities.find((identity) => identity.id === ref);
  if (byId !== undefined) return byId;

  const matches = new Map<string, ModuleIdentity>();
  for (const identity of directory.identities) {
    const candidates = [identity.structuralName, ...identity.aliases].map(normalizeRef);
    if (candidates.includes(wanted)) matches.set(identity.id, identity);
  }
  for (const display of directory.displayNames) {
    if (normalizeRef(display.name) !== wanted) continue;
    const identity = directory.identities.find((entry) => entry.id === display.moduleId);
    if (identity !== undefined) matches.set(identity.id, identity);
  }

  const found = [...matches.values()];
  const first = found[0];
  if (first === undefined || found.length > 1) {
    throw new UnresolvedModuleError(
      ref,
      directory.identities.map((identity) => identity.structuralName).sort(),
    );
  }
  return first;
}

export type DirectoryValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * The properties multi-language correctness rests on.
 *
 * Chiefly: display names are complete per language, and no two modules share one.
 * An incomplete set would make a module unaddressable in that language; a shared
 * name would make a reference ambiguous.
 */
export function validateDirectory(directory: ModuleDirectory): DirectoryValidation {
  const reasons: string[] = [];
  const ids = new Set<string>();
  for (const identity of directory.identities) {
    if (identity.id.length === 0) reasons.push("a module has an empty id");
    if (ids.has(identity.id)) reasons.push(`duplicate module id: ${identity.id}`);
    ids.add(identity.id);
    if (identity.structuralName.length === 0) reasons.push(`${identity.id}: empty structural name`);
    if (!MODULE_CATEGORIES.includes(identity.category)) {
      reasons.push(`${identity.id}: unknown category "${identity.category}"`);
    }
  }
  const languages = new Set(directory.displayNames.map((display) => display.language));
  for (const language of [...languages].sort()) {
    const inLanguage = directory.displayNames.filter((display) => display.language === language);
    for (const display of inLanguage) {
      if (!ids.has(display.moduleId)) reasons.push(`${language}: display name for unknown module ${display.moduleId}`);
      if (display.name.trim().length === 0) reasons.push(`${language}: empty display name for ${display.moduleId}`);
    }
    if (inLanguage.length !== ids.size) {
      reasons.push(`${language}: ${inLanguage.length} display names for ${ids.size} modules`);
    }
    const seen = new Map<string, string>();
    for (const display of inLanguage) {
      const key = normalizeRef(display.name);
      const other = seen.get(key);
      if (other !== undefined && other !== display.moduleId) {
        reasons.push(`${language}: "${display.name}" names both ${other} and ${display.moduleId}`);
      }
      seen.set(key, display.moduleId);
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/** The identity set, independent of any language. Two languages MUST agree on this. */
export function identityFingerprint(directory: ModuleDirectory): readonly string[] {
  return directory.identities.map((identity) => `${identity.id}:${identity.category}`).sort();
}
