/**
 * The generate-and-reuse orchestration for module classification (PI-79).
 *
 * This ties the pieces into one run: form candidates, and if a prior artifact for
 * the same candidate set and classifier identity is on disk, reuse it without
 * classifying again; otherwise run the classifier, validate its result fail-closed,
 * apply any human overrides, and persist the one artifact atomically.
 *
 * The classifier is a port, not a dependency: the caller passes a function that
 * runs the bounded model (or a human review) over the candidate list. This module
 * never calls a vendor, and a classifier that throws is caught and turned into an
 * all-`unresolved` artifact — a failed run scopes no module rather than none-run
 * scoping every module.
 */

import type {
  ClassificationDiagnostic,
  ClassificationOverride,
  ClassifiedCandidate,
  ClassifierIdentity,
  ModuleCandidate,
  ModuleClassificationArtifact,
} from "../contracts/module-classification/schema.js";
import {
  MODULE_CLASSIFICATION_SCHEMA_VERSION,
  artifactIdentity,
  candidateSetDigest,
  shouldReuse,
  unresolvedArtifact,
  validateClassificationResult,
} from "../contracts/module-classification/schema.js";
import { type CandidateInput, generateModuleCandidates } from "./candidates.js";
import { readClassificationArtifact, writeClassificationArtifact } from "./classification-store.js";

/** The bounded classifier: it sees only the candidate list, and returns a label per candidate. */
export type Classifier = (
  candidates: readonly ModuleCandidate[],
) => readonly ClassifiedCandidate[] | Promise<readonly ClassifiedCandidate[]>;

export interface OverrideEntry {
  readonly candidateId: string;
  readonly override: ClassificationOverride;
}

export interface ClassifyOptions {
  readonly runDir: string;
  readonly sourceSnapshotId: string;
  readonly classifier: ClassifierIdentity;
  readonly classify: Classifier;
  /** Human confirmations layered over the classifier — explicit and identity-bearing. */
  readonly overrides?: readonly OverrideEntry[];
}

export interface ClassifyOutcome {
  readonly artifact: ModuleClassificationArtifact;
  /** True when a prior artifact was reused and the classifier was not run. */
  readonly reused: boolean;
  readonly diagnostics: readonly ClassificationDiagnostic[];
}

/**
 * Apply human overrides on top of a validated result. An override records its own
 * source and sets the candidate's classification, so it never silently rewrites the
 * classifier — the change is visible and, via `artifactIdentity`, part of the
 * result's identity. An override for an id not in the set is ignored (it grounds
 * no candidate).
 */
function applyOverrides(
  artifact: ModuleClassificationArtifact,
  overrides: readonly OverrideEntry[],
): ModuleClassificationArtifact {
  if (overrides.length === 0) return artifact;
  const byId = new Map(overrides.map((o) => [o.candidateId, o.override] as const));
  return {
    ...artifact,
    candidates: artifact.candidates.map((c) => {
      const override = byId.get(c.candidateId);
      if (override === undefined) return c;
      const status = override.classification === "unresolved" ? "unresolved" : "classified";
      return { ...c, classification: override.classification, status, override };
    }),
  };
}

export async function classifyModuleCandidates(
  input: CandidateInput,
  options: ClassifyOptions,
): Promise<ClassifyOutcome> {
  const candidates = generateModuleCandidates(input);
  const digest = candidateSetDigest(candidates);

  const overrides = options.overrides ?? [];

  // Reuse governs only whether the classifier re-runs — the expensive step. Human
  // overrides are a cheap layer applied every run, so a reviewer who supplies an
  // override after an initial run still lands it without paying to re-classify. If
  // the override changes the result, the artifact is re-persisted; a pure reuse
  // rewrites nothing.
  const existing = readClassificationArtifact(options.runDir);
  if (existing !== null && shouldReuse(existing, digest, options.classifier)) {
    const artifact = applyOverrides(existing, overrides);
    if (artifactIdentity(artifact) !== artifactIdentity(existing)) {
      writeClassificationArtifact(options.runDir, artifact);
    }
    return { artifact, reused: true, diagnostics: [] };
  }

  let raw: ModuleClassificationArtifact;
  try {
    raw = {
      schemaVersion: MODULE_CLASSIFICATION_SCHEMA_VERSION,
      sourceSnapshotId: options.sourceSnapshotId,
      candidateSetDigest: digest,
      classifier: options.classifier,
      candidates: await options.classify(candidates),
    };
  } catch (error) {
    raw = unresolvedArtifact(
      candidates,
      options.sourceSnapshotId,
      options.classifier,
      `classifier failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const validated = validateClassificationResult(candidates, raw);
  // The run, not the classifier's echo, is authoritative about identity.
  const identified: ModuleClassificationArtifact = {
    ...validated.normalized,
    sourceSnapshotId: options.sourceSnapshotId,
    classifier: options.classifier,
  };
  const artifact = applyOverrides(identified, overrides);

  writeClassificationArtifact(options.runDir, artifact);
  return { artifact, reused: false, diagnostics: validated.diagnostics };
}
