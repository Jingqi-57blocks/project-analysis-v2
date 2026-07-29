/**
 * A template is a document's shape, as data.
 *
 * Sections are filled one of two ways. A `code` section is rendered from the
 * knowledge base by a named fragment — tables, diagrams, lists, things with a
 * right answer. An `llm` section carries a prompt and the slice of the
 * knowledge base that prompt may use; the engine writes the task and the host
 * agent answers it. Nothing here calls a model.
 *
 * The format is JSON plus prompt files beside it, so a prompt stays diffable
 * and a person editing wording never touches the manifest.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Contract {
  readonly maxWords?: number;
  /** Deepest heading the answer may use, so it cannot outrank the document. */
  readonly maxHeadingLevel?: number;
  /** `one-per:<selector>` — one heading per item the section was given. */
  readonly requiredHeadings?: string;
}

interface SectionBase {
  readonly id: string;
  readonly heading: string | null;
  readonly requires: readonly string[];
  /** Render nothing at all when every selector came back empty. */
  readonly omitWhenEmpty?: boolean;
}

export interface CodeSection extends SectionBase {
  readonly kind: "code";
  readonly fragment: string;
}

export interface LlmSection extends SectionBase {
  readonly kind: "llm";
  /** Path to the prompt file, relative to the template directory. */
  readonly prompt: string;
  readonly contract?: Contract;
  /** A missing answer for an optional section is a note, not a refusal. */
  readonly optional?: boolean;
}

export type Section = CodeSection | LlmSection;

export interface Template {
  readonly id: string;
  readonly title: string;
  /** Names the caller must supply, e.g. `module` for a per-module document. */
  readonly params: readonly string[];
  readonly sections: readonly Section[];
  readonly dir: string;
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** Where the shipped templates live. `pathname` alone stays percent-encoded. */
export const BUILT_IN_DIR = fileURLToPath(new URL("../../templates", import.meta.url));

function templateDir(idOrDir: string): string {
  if (idOrDir.includes("/") || isAbsolute(idOrDir)) return resolve(idOrDir);
  return join(BUILT_IN_DIR, idOrDir);
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") {
    throw new TemplateError(`${where} must be a non-empty string`);
  }
  return value;
}

/** An id names a directory and a marker, so it may not carry either's syntax. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function parseContract(raw: unknown, id: string): Contract {
  if (typeof raw !== "object" || raw === null) {
    throw new TemplateError(`section ${id} has a contract that is not an object`);
  }
  const value = raw as Record<string, unknown>;
  const contract: Record<string, unknown> = {};

  for (const key of ["maxWords", "maxHeadingLevel"] as const) {
    const given = value[key];
    if (given === undefined) continue;
    // An unchecked contract fails open: `maxWords: "ten"` makes every
    // comparison NaN-false and silently disables the check it declares.
    if (typeof given !== "number" || !Number.isInteger(given) || given < 1) {
      throw new TemplateError(`section ${id}: ${key} must be a positive whole number`);
    }
    contract[key] = given;
  }

  const headings = value["requiredHeadings"];
  if (headings !== undefined) {
    if (typeof headings !== "string" || !headings.startsWith("one-per:")) {
      throw new TemplateError(`section ${id}: requiredHeadings must be "one-per:<selector>"`);
    }
    contract["requiredHeadings"] = headings;
  }

  return contract as Contract;
}

function parseSection(raw: unknown, index: number): Section {
  if (typeof raw !== "object" || raw === null) {
    throw new TemplateError(`section ${index} is not an object`);
  }
  const value = raw as Record<string, unknown>;
  const id = asString(value["id"], `section ${index} id`);
  if (!SAFE_ID.test(id)) {
    throw new TemplateError(
      `section id "${id}" may contain only letters, digits, "-" and "_" — it names a directory and an HTML comment`,
    );
  }
  const heading = value["heading"] === undefined ? null : asString(value["heading"], `${id} heading`);
  const requires = Array.isArray(value["requires"])
    ? value["requires"].map((entry, n) => asString(entry, `${id} requires[${n}]`))
    : [];
  const omitWhenEmpty = value["omitWhenEmpty"] === true ? { omitWhenEmpty: true } : {};

  if (value["kind"] === "code") {
    return {
      kind: "code",
      id,
      heading,
      requires,
      fragment: asString(value["fragment"], `${id} fragment`),
      ...omitWhenEmpty,
    };
  }
  if (value["kind"] === "llm") {
    return {
      kind: "llm",
      id,
      heading,
      requires,
      prompt: asString(value["prompt"], `${id} prompt`),
      ...(value["contract"] === undefined ? {} : { contract: parseContract(value["contract"], id) }),
      ...(value["optional"] === true ? { optional: true } : {}),
      ...omitWhenEmpty,
    };
  }
  throw new TemplateError(`section ${id} has kind ${String(value["kind"])}; expected "code" or "llm"`);
}

export function parseTemplate(json: string, dir: string): Template {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new TemplateError(`${dir}/template.json is not valid JSON: ${String(error)}`);
  }
  const value = raw as Record<string, unknown>;

  const sections = Array.isArray(value["sections"]) ? value["sections"].map(parseSection) : [];
  if (sections.length === 0) throw new TemplateError(`${dir}/template.json declares no sections`);

  const seen = new Set<string>();
  for (const section of sections) {
    if (seen.has(section.id)) {
      // Ids name the splice markers and the task directories; two sections
      // sharing one would overwrite each other's answers.
      throw new TemplateError(`two sections share the id "${section.id}"`);
    }
    seen.add(section.id);
  }

  return {
    id: asString(value["id"], "id"),
    title: asString(value["title"], "title"),
    params: Array.isArray(value["params"])
      ? value["params"].map((entry, n) => asString(entry, `params[${n}]`))
      : [],
    sections,
    dir,
  };
}

export function loadTemplate(idOrDir: string): Template {
  const dir = templateDir(idOrDir);
  let json: string;
  try {
    json = readFileSync(join(dir, "template.json"), "utf8");
  } catch {
    throw new TemplateError(`No template at ${dir} — expected ${join(dir, "template.json")}`);
  }
  return parseTemplate(json, dir);
}

export function readPrompt(template: Template, section: LlmSection): string {
  const path = join(template.dir, section.prompt);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new TemplateError(`Section "${section.id}" names a prompt that is not there: ${path}`);
  }
}
