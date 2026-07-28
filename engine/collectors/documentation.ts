/**
 * Collects the prose a project writes about itself: README titles and intro
 * sections, the manifest's name and description, and configuration key names.
 *
 * The highest-value evidence available and the cheapest to reach — it is
 * already written for humans, so it needs no interpretation to be useful.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { declared, fileRef, inferred, lineRef } from "../structural/provenance.js";
import type {
  CollectionFailure,
  CollectorCapabilities,
  EvidenceGap,
  EvidenceItem,
  SemanticCollector,
  SemanticContribution,
  SemanticRootInput,
} from "../semantic/types.js";

export const COLLECTOR_ID = "documentation";
export const COLLECTOR_VERSION = "1.0.0";

const MAX_FILE_BYTES = 2_000_000;
const README_NAMES = [
  "readme.md",
  "readme.markdown",
  "readme.rst",
  "readme.adoc",
  "readme.asciidoc",
  "readme.txt",
  "readme",
];

/** Configuration files whose keys are worth naming. Values are never read. */
const CONFIG_NAMES = [".env.example", ".env.sample", "config.example.json"];

export function isReadme(relPath: string): boolean {
  return README_NAMES.includes(basename(relPath).toLowerCase());
}

/**
 * Splits Markdown into headed sections, keeping each section's text as written.
 *
 * Truncating to a first line would throw away exactly the material a later
 * template might need, and the summary can always be derived again while the
 * original cannot.
 */
export function readmeSections(
  content: string,
): readonly { heading: string | null; level: number; text: string; line: number }[] {
  const lines = content.split("\n");
  const sections: { heading: string | null; level: number; text: string; line: number }[] = [];

  let heading: string | null = null;
  let level = 0;
  let buffer: string[] = [];
  let startLine = 1;

  const flush = (): void => {
    const text = buffer.join("\n").trim();
    if (text !== "" || heading !== null) sections.push({ heading, level, text, line: startLine });
    buffer = [];
  };

  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      heading = match[2]!.trim();
      level = match[1]!.length;
      startLine = index + 1;
      return;
    }
    if (buffer.length === 0 && line.trim() === "") return;
    buffer.push(line);
  });
  flush();

  return sections.filter((section) => section.heading !== null || section.text !== "");
}

/**
 * Key names from a JSON config file.
 *
 * Handled separately because a JSON key line starts with a quote, which the
 * KEY=VALUE pattern below can never match — so a JSON config would silently
 * yield nothing from a collector declaring support for it.
 *
 * Nested objects contribute dotted paths, so a key's position in the structure
 * survives without any value being read.
 */
export function jsonConfigKeys(content: string): readonly string[] {
  const keys: string[] = [];

  const walk = (value: unknown, prefix: string): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      keys.push(path);
      walk(nested, path);
    }
  };

  walk(JSON.parse(content), "");
  return keys;
}

/** Key names only. Values may hold credentials, and nothing here has a use for one. */
export function configKeys(content: string): readonly { key: string; line: number }[] {
  const keys: { key: string; line: number }[] = [];
  content.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]/.exec(trimmed);
    if (match) keys.push({ key: match[1]!, line: index + 1 });
  });
  return keys;
}

function capabilities(): CollectorCapabilities {
  return {
    declarations: [
      { kind: "project-title", language: "*", support: "full", limits: [] },
      {
        kind: "project-description",
        language: "*",
        support: "partial",
        limits: ["read from package.json and composer.json only"],
      },
      {
        kind: "readme-section",
        language: "*",
        support: "partial",
        limits: [
          "Markdown headings only; reStructuredText and AsciiDoc structure is not parsed",
          `files larger than ${MAX_FILE_BYTES} bytes are skipped`,
        ],
      },
      {
        kind: "config-key",
        language: "*",
        support: "partial",
        limits: [
          "example and sample config files only",
          "key names only — values are never read, since they may hold credentials",
        ],
      },
    ],
  };
}

function manifestEvidence(
  root: SemanticRootInput,
  relPath: string,
  content: string,
): readonly EvidenceItem[] {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const items: EvidenceItem[] = [];
  const source = fileRef(root.name, relPath);

  if (typeof parsed["name"] === "string" && parsed["name"] !== "") {
    items.push({
      rootName: root.name,
      kind: "project-title",
      text: parsed["name"],
      label: "name",
      symbolId: null,
      source,
      provenance: declared(source),
    });
  }
  if (typeof parsed["description"] === "string" && parsed["description"] !== "") {
    items.push({
      rootName: root.name,
      kind: "project-description",
      text: parsed["description"],
      label: "description",
      symbolId: null,
      source,
      provenance: declared(source),
    });
  }
  return items;
}

export function createDocumentationCollector(): SemanticCollector {
  return {
    id: COLLECTOR_ID,
    version: COLLECTOR_VERSION,
    capabilities,

    collect(root: SemanticRootInput): SemanticContribution {
      const items: EvidenceItem[] = [];
      const failures: CollectionFailure[] = [];
      const gaps: EvidenceGap[] = [];
      let sawReadme = false;

      for (const relPath of root.analyzedFiles) {
        const name = basename(relPath);
        const isManifest = name === "package.json" || name === "composer.json";
        const isConfig = CONFIG_NAMES.includes(name.toLowerCase());

        if (!isReadme(relPath) && !isManifest && !isConfig) continue;

        try {
          if (statSync(join(root.path, relPath)).size > MAX_FILE_BYTES) {
            failures.push({ scope: relPath, reason: "file exceeds the read size limit" });
            continue;
          }
          const content = readFileSync(join(root.path, relPath), "utf8");

          if (isReadme(relPath)) {
            sawReadme = true;
            const extension = extname(relPath).toLowerCase();
            const markdown = extension === ".md" || extension === ".markdown" || extension === "";
            if (!markdown) {
              gaps.push({
                kind: "readme-section",
                language: extname(relPath),
                reason: `${name} is not Markdown, so its section structure was not parsed`,
              });
              continue;
            }
            let titleTaken = false;
            for (const section of readmeSections(content)) {
              const source = lineRef(root.name, relPath, section.line);

              // Only the first top-level heading is treated as the project's
              // title, and even then it is an inference: deciding a heading
              // names the project is a judgement, not a verbatim reading. A
              // heading-only section anywhere else is just an empty section.
              const isTitle = !titleTaken && section.level === 1 && section.heading !== null;
              if (isTitle) {
                titleTaken = true;
                items.push({
                  rootName: root.name,
                  kind: "project-title",
                  text: section.heading!,
                  label: section.heading,
                  symbolId: null,
                  source,
                  provenance: inferred(source, "medium"),
                });
              }

              // The heading and the prose under it are two different facts. A
              // title carrying the body as its text would conflate them, so
              // the section is emitted separately whenever it has any.
              if (section.text !== "") {
                items.push({
                  rootName: root.name,
                  kind: "readme-section",
                  text: section.text,
                  label: section.heading,
                  symbolId: null,
                  source,
                  provenance: declared(source),
                });
              } else if (!isTitle) {
                items.push({
                  rootName: root.name,
                  kind: "readme-section",
                  text: section.heading ?? "",
                  label: section.heading,
                  symbolId: null,
                  source,
                  provenance: declared(source),
                });
              }
            }
            continue;
          }

          if (isManifest) {
            items.push(...manifestEvidence(root, relPath, content));
            continue;
          }

          if (extname(relPath).toLowerCase() === ".json") {
            const source = fileRef(root.name, relPath);
            for (const key of jsonConfigKeys(content)) {
              items.push({
                rootName: root.name,
                kind: "config-key",
                text: key,
                label: name,
                symbolId: null,
                source,
                provenance: declared(source),
              });
            }
            continue;
          }

          for (const { key, line } of configKeys(content)) {
            const source = lineRef(root.name, relPath, line);
            items.push({
              rootName: root.name,
              kind: "config-key",
              text: key,
              label: name,
              symbolId: null,
              source,
              provenance: declared(source),
            });
          }
        } catch (error) {
          failures.push({
            scope: relPath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Many projects legitimately have no README. An empty result with a
      // recorded reason is a fact; an empty result with no reason is a mystery.
      if (!sawReadme) {
        gaps.push({
          kind: "readme-section",
          language: "*",
          reason: "no README file was found in this root",
        });
      }

      return {
        collectorId: COLLECTOR_ID,
        collectorVersion: COLLECTOR_VERSION,
        rootName: root.name,
        items,
        gaps,
        failures,
      };
    },
  };
}
