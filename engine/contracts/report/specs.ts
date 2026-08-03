/**
 * The output-spec registry.
 *
 * Each report type is one self-describing Markdown file under `specs/`. Its
 * frontmatter declares the `scope × audience` it serves, the shared writing
 * contract it inherits, and the fact kinds it needs. Adding a report type is
 * adding a file — nothing here, in the skill, or in the command layer enumerates
 * the combinations.
 *
 * `scope` and `audience` are therefore open sets. The closed unions in
 * target.ts belong to the deterministic pipeline that PI-119 retires; they are
 * deliberately not reused here.
 *
 * `requires` is also the slicing input: the fact pack is cut to the kinds the
 * spec declares, so a spec can never demand a chapter the pack has no facts for.
 */

import { readFileSync, readdirSync } from "node:fs";

const SPECS_DIR = new URL("./specs/", import.meta.url);

/** Frontmatter `kind` of the inherited writing contract, which is not a report type. */
const SHARED_CONTRACT_KIND = "shared-writing-contract";

/**
 * Fact kinds a spec may require. This is the report side declaring what it is
 * allowed to ask for; PI-109's knowledge-base read contract must supply exactly
 * these and is the authority on their payloads.
 */
export const REQUIRABLE_FACT_KINDS: readonly string[] = [
  // structural
  "auth-annotation",
  "call-edge",
  "condition",
  "data-access",
  "decision",
  "discarded-error",
  "entity",
  "entity-constraint",
  "entity-field",
  "entity-relation",
  "error-handling",
  "guard",
  "import",
  "module-containment",
  "notification-call",
  "outbound-call",
  "package-dependency",
  "reference",
  "route",
  "scheduled-task",
  "source-file",
  "symbol",
  "transaction-boundary",
  "type-relation",
  "validation-rule",
  // behavioural
  "business-rule",
  "state",
  "test-relation",
  "transition",
  "value-set",
  // derived
  "base-binding",
  "component",
  "coverage-note",
  "cross-root-link",
  "feature",
  "feature-finding",
  "feature-flow",
  "health-signal",
  "map-edge",
  "module",
  "run-context",
  "structural-finding",
  "trace",
  "unlinked-call",
];

const REQUIRABLE = new Set(REQUIRABLE_FACT_KINDS);

export interface ReportSpec {
  /** Stable id; equals the file's basename. */
  readonly id: string;
  readonly scope: string;
  readonly audience: string;
  /** Basename of the writing contract this spec inherits. */
  readonly inherits: string;
  readonly version: string;
  /** Human-readable name of the report type. */
  readonly title: string;
  /** Fact kinds the spec's chapters draw on; also the slicing input. */
  readonly requires: readonly string[];
  /** Everything after the frontmatter. */
  readonly body: string;
}

export interface SharedWritingContract {
  readonly id: string;
  readonly version: string;
  readonly body: string;
}

export interface SpecRegistry {
  readonly contract: SharedWritingContract;
  readonly specs: readonly ReportSpec[];
}

/**
 * A deliberately small frontmatter reader: `key: scalar` and `key:` followed by
 * `  - item` lines, nothing else. Anything outside that subset throws rather
 * than being silently misread — a spec is a contract, so a typo must fail loudly.
 */
function parseFrontmatter(text: string, file: string): { fields: Map<string, string | string[]>; body: string } {
  if (!text.startsWith("---\n")) throw new Error(`${file}: must open with a --- frontmatter block`);
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) throw new Error(`${file}: unterminated frontmatter block`);
  const fields = new Map<string, string | string[]>();
  let listKey: string | null = null;
  for (const raw of text.slice(4, end).split("\n")) {
    if (raw.trim().length === 0) continue;
    const item = /^ {2}- (.+)$/.exec(raw);
    if (item) {
      const value = item[1] ?? "";
      if (listKey === null) throw new Error(`${file}: list item "${value}" has no preceding key`);
      (fields.get(listKey) as string[]).push(value.trim());
      continue;
    }
    const pair = /^([a-z][a-z-]*):(.*)$/.exec(raw);
    const key = pair?.[1];
    const rest = pair?.[2];
    if (key === undefined || rest === undefined) {
      throw new Error(`${file}: unsupported frontmatter line: ${raw}`);
    }
    if (fields.has(key)) throw new Error(`${file}: duplicate frontmatter key: ${key}`);
    if (rest.trim().length === 0) {
      listKey = key;
      fields.set(key, []);
    } else {
      listKey = null;
      fields.set(key, rest.trim());
    }
  }
  return { fields, body: text.slice(end + 5) };
}

function scalar(fields: Map<string, string | string[]>, key: string, file: string): string {
  const value = fields.get(key);
  if (typeof value !== "string" || value.length === 0) throw new Error(`${file}: missing "${key}"`);
  return value;
}

/**
 * Reads every spec file plus the shared contract. Deterministic: sorted by id.
 *
 * The directory is a parameter so a test can point at a fixture set — which is
 * also the proof that adding a report type is adding a file: nothing here names
 * a combination.
 */
export function loadSpecRegistry(dir: URL = SPECS_DIR): SpecRegistry {
  const files = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  let contract: SharedWritingContract | undefined;
  const specs: ReportSpec[] = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, dir), "utf8");
    const { fields, body } = parseFrontmatter(text, file);
    const id = scalar(fields, "id", file);
    if (id !== file.slice(0, -3)) throw new Error(`${file}: id "${id}" does not match the file name`);
    if (fields.get("kind") === SHARED_CONTRACT_KIND) {
      if (contract) throw new Error(`${file}: a second shared writing contract`);
      contract = { id, version: scalar(fields, "version", file), body };
      continue;
    }
    const requires = fields.get("requires");
    if (!Array.isArray(requires)) throw new Error(`${file}: missing "requires"`);
    specs.push({
      id,
      scope: scalar(fields, "scope", file),
      audience: scalar(fields, "audience", file),
      inherits: scalar(fields, "inherits", file),
      version: scalar(fields, "version", file),
      title: scalar(fields, "title", file),
      requires,
      body,
    });
  }
  if (!contract) throw new Error("specs/: no shared writing contract found");
  return { contract, specs };
}

export type SpecValidation = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Structural legality of the registry. Checks the properties the extension
 * mechanism rests on: one spec per combination, every spec inherits the one
 * shared contract, and every required kind is one the fact pack can supply.
 */
export function validateSpecRegistry(registry: SpecRegistry): SpecValidation {
  const reasons: string[] = [];
  const combinations = new Set<string>();
  for (const spec of registry.specs) {
    const combination = `${spec.scope}/${spec.audience}`;
    if (combinations.has(combination)) reasons.push(`duplicate scope × audience: ${combination}`);
    combinations.add(combination);
    if (spec.inherits !== `${registry.contract.id}.md`) {
      reasons.push(`${spec.id}: inherits "${spec.inherits}", expected "${registry.contract.id}.md"`);
    }
    if (spec.requires.length === 0) reasons.push(`${spec.id}: requires no fact kinds`);
    if (new Set(spec.requires).size !== spec.requires.length) reasons.push(`${spec.id}: duplicate entry in requires`);
    for (const kind of spec.requires) {
      if (!REQUIRABLE.has(kind)) reasons.push(`${spec.id}: requires unknown fact kind "${kind}"`);
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * The spec serving a requested combination, or undefined. Callers MUST fail
 * closed and list the available combinations rather than falling back.
 */
export function specFor(registry: SpecRegistry, scope: string, audience: string): ReportSpec | undefined {
  return registry.specs.find((spec) => spec.scope === scope && spec.audience === audience);
}

/** Every legal combination, for a caller's error message. */
export function availableCombinations(registry: SpecRegistry): readonly string[] {
  return registry.specs.map((spec) => `${spec.scope}/${spec.audience}`).sort();
}

/** Union of the kinds any spec may need — the upper bound on a fact pack. */
export function allRequiredKinds(registry: SpecRegistry): readonly string[] {
  return [...new Set(registry.specs.flatMap((spec) => spec.requires))].sort();
}
