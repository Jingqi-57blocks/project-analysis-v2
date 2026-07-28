/**
 * Collects the prose a project writes about itself: README titles and intro
 * sections, the manifest's name and description, and configuration key names.
 *
 * The highest-value evidence available and the cheapest to reach — it is
 * already written for humans, so it needs no interpretation to be useful.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { declared, fileRef, lineRef } from "../structural/provenance.js";
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
const README_NAMES = ["readme.md", "readme.rst", "readme.txt", "readme"];

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
): readonly { heading: string | null; text: string; line: number }[] {
  const lines = content.split("\n");
  const sections: { heading: string | null; text: string; line: number }[] = [];

  let heading: string | null = null;
  let buffer: string[] = [];
  let startLine = 1;

  const flush = (): void => {
    const text = buffer.join("\n").trim();
    if (text !== "" || heading !== null) sections.push({ heading, text, line: startLine });
    buffer = [];
  };

  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      heading = match[2]!.trim();
      startLine = index + 1;
      return;
    }
    if (buffer.length === 0 && line.trim() === "") return;
    buffer.push(line);
  });
  flush();

  return sections.filter((section) => section.heading !== null || section.text !== "");
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
        const isConfig = CONFIG_NAMES.includes(name);

        if (!isReadme(relPath) && !isManifest && !isConfig) continue;

        try {
          if (statSync(join(root.path, relPath)).size > MAX_FILE_BYTES) {
            failures.push({ scope: relPath, reason: "file exceeds the read size limit" });
            continue;
          }
          const content = readFileSync(join(root.path, relPath), "utf8");

          if (isReadme(relPath)) {
            sawReadme = true;
            const markdown = extname(relPath).toLowerCase() === ".md" || extname(relPath) === "";
            if (!markdown) {
              gaps.push({
                kind: "readme-section",
                language: extname(relPath),
                reason: `${name} is not Markdown, so its section structure was not parsed`,
              });
              continue;
            }
            for (const section of readmeSections(content)) {
              const source = lineRef(root.name, relPath, section.line);
              items.push({
                rootName: root.name,
                kind: section.heading !== null && section.text === "" ? "project-title" : "readme-section",
                text: section.text === "" ? (section.heading ?? "") : section.text,
                label: section.heading,
                symbolId: null,
                source,
                provenance: declared(source),
              });
            }
            continue;
          }

          if (isManifest) {
            items.push(...manifestEvidence(root, relPath, content));
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
