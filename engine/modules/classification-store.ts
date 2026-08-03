/**
 * Persists the module-classification artifact, and reads it back for reuse (PI-79).
 *
 * The artifact lives in the analyzer's own run directory, never in the analyzed
 * repository — the caller passes the run dir, and this module writes exactly one
 * file there. The write is atomic (temp file then rename) so a crashed run leaves
 * either the old artifact or the new one, never a half-written JSON a later run
 * would fail closed on and re-classify needlessly.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { ModuleClassificationArtifact } from "../contracts/module-classification/schema.js";
import { MODULE_CLASSIFICATION_SCHEMA_VERSION } from "../contracts/module-classification/schema.js";
import { stableStringify } from "../contracts/shared-fact/merge.js";

export const MODULE_CLASSIFICATION_FILENAME = "module-classification.v2.json";

export function classificationArtifactPath(runDir: string): string {
  return join(runDir, MODULE_CLASSIFICATION_FILENAME);
}

export function writeClassificationArtifact(
  runDir: string,
  artifact: ModuleClassificationArtifact,
): string {
  mkdirSync(runDir, { recursive: true });
  const path = classificationArtifactPath(runDir);
  const tmp = `${path}.tmp`;
  // stableStringify, not JSON.stringify: two semantically-equal artifacts serialize
  // to identical bytes, so a reproducibility check compares content, not key order.
  writeFileSync(tmp, `${stableStringify(artifact)}\n`);
  renameSync(tmp, path);
  return path;
}

/**
 * The stored artifact, or null if none is present. A file that is not valid JSON
 * or not this schema version returns null rather than throwing — a caller reads
 * this to decide whether it may skip re-classification, and an unreadable prior
 * result simply means it cannot.
 */
export function readClassificationArtifact(runDir: string): ModuleClassificationArtifact | null {
  const path = classificationArtifactPath(runDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ModuleClassificationArtifact;
    // A prior artifact a later run will reuse must be whole. A file with the right
    // schema version but a missing classifier or candidate list — external tampering,
    // never the atomic writer — is treated as absent, so reuse re-derives instead of
    // dereferencing a hole.
    if (parsed.schemaVersion !== MODULE_CLASSIFICATION_SCHEMA_VERSION) return null;
    if (parsed.classifier === undefined || typeof parsed.classifier.executor !== "string") return null;
    if (!Array.isArray(parsed.candidates)) return null;
    return parsed;
  } catch {
    return null;
  }
}
