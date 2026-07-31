/**
 * The module-candidate classification contract (PI-79).
 *
 * Generic code forms a bounded, evidence-bearing list of module *candidates*; a
 * bounded classifier labels only that list; the input and the result persist as
 * one JSON artifact that is reused when the candidate set and the classifier
 * identity have not changed. This file fixes that artifact's shape, the identity
 * that governs reuse, and a fail-closed validator — an AI (or human override)
 * that returns an unknown id, a dropped id, a duplicate, an invalid label or a
 * classification with no evidence never lands as a module: it lands as
 * `unresolved` with a diagnostic.
 *
 * The four labels are deliberately coarse. Only `product-module` and
 * `technical-component` may become a canonical module scope (PI-76);
 * `external-system` stays a boundary entity with no module report; `unresolved`
 * is never silently promoted to a module.
 *
 * Nothing here names a vendor, a domain or an acceptance target — a classifier
 * decides from a candidate's structural and boundary evidence, never from a
 * keyword table.
 */

import { createHash } from "node:crypto";

import { stableStringify } from "../shared-fact/merge.js";

export const MODULE_CLASSIFICATION_SCHEMA_VERSION = "module-classification.v1";

export type ModuleClassification =
  | "product-module"
  | "technical-component"
  | "external-system"
  | "unresolved";

export const MODULE_CLASSIFICATIONS: readonly ModuleClassification[] = [
  "product-module",
  "technical-component",
  "external-system",
  "unresolved",
];

/** The labels allowed to become a canonical module scope. The rest are boundary/unknown. */
export const MODULE_SCOPE_CLASSIFICATIONS: readonly ModuleClassification[] = [
  "product-module",
  "technical-component",
];

/**
 * One bounded candidate. Generic code fills these deterministically from shared
 * facts; the classifier reads them and nothing else. `evidenceRefs` are the
 * citable fact references a classification must ground itself in.
 */
export interface ModuleCandidate {
  readonly candidateId: string;
  readonly displayNameCandidates: readonly string[];
  readonly memberSummary: string;
  readonly entrySummary: readonly string[];
  readonly relationSummary: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly reason: string;
}

/** Who produced a classification result — part of the reuse identity. */
export interface ClassifierIdentity {
  readonly executor: string;
  readonly model: string;
  readonly contractVersion: string;
}

export type ClassificationStatus = "classified" | "unresolved";

/**
 * A human decision layered over the classifier's. Explicit by construction — it
 * records its own source and is part of the result identity, so it can never
 * silently rewrite a classification.
 */
export interface ClassificationOverride {
  readonly source: string;
  readonly classification: ModuleClassification;
  readonly note: string;
}

export interface ClassifiedCandidate {
  readonly candidateId: string;
  readonly classification: ModuleClassification;
  readonly confidence: number;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  readonly status: ClassificationStatus;
  readonly override?: ClassificationOverride;
}

export interface ModuleClassificationArtifact {
  readonly schemaVersion: string;
  readonly sourceSnapshotId: string;
  readonly candidateSetDigest: string;
  readonly classifier: ClassifierIdentity;
  readonly candidates: readonly ClassifiedCandidate[];
}

/**
 * A content digest over the candidate set, order-independent across candidates
 * but preserving each candidate's own field order (a display-name list is ranked,
 * not a set). An edit to any candidate — a new member, a changed reason, an added
 * evidence ref — changes it, so a stale result is never reused.
 */
export function candidateSetDigest(candidates: readonly ModuleCandidate[]): string {
  const canonical = [...candidates]
    .sort((a, b) => (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0))
    .map((c) => stableStringify(c));
  const hash = createHash("sha256");
  for (const entry of canonical) {
    hash.update(entry);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function sameClassifier(a: ClassifierIdentity, b: ClassifierIdentity): boolean {
  return a.executor === b.executor && a.model === b.model && a.contractVersion === b.contractVersion;
}

/**
 * Whether an existing artifact may be reused instead of re-running the classifier.
 * Reuse only when the candidate set, the schema version and the classifier
 * identity all match; any change re-classifies the whole set (V1 does no
 * fine-grained incremental re-classification).
 */
export function shouldReuse(
  existing: ModuleClassificationArtifact,
  digest: string,
  classifier: ClassifierIdentity,
): boolean {
  return (
    existing.schemaVersion === MODULE_CLASSIFICATION_SCHEMA_VERSION &&
    existing.candidateSetDigest === digest &&
    sameClassifier(existing.classifier, classifier)
  );
}

/**
 * The identity of a *result*, including any overrides. Two artifacts with the
 * same candidate input and classifier but different overrides are different
 * results — an override change is never mistaken for the same conclusion.
 */
export function artifactIdentity(artifact: ModuleClassificationArtifact): string {
  const overrides = [...artifact.candidates]
    .filter((c) => c.override !== undefined)
    .sort((a, b) => (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0))
    .map((c) => ({ candidateId: c.candidateId, override: c.override }));
  return createHash("sha256")
    .update(
      stableStringify({
        schemaVersion: artifact.schemaVersion,
        candidateSetDigest: artifact.candidateSetDigest,
        classifier: artifact.classifier,
        overrides,
      }),
    )
    .digest("hex");
}

export interface ClassificationDiagnostic {
  readonly candidateId: string;
  readonly reason: string;
}

export interface ClassificationValidation {
  readonly ok: boolean;
  readonly diagnostics: readonly ClassificationDiagnostic[];
  /** The artifact with every offending or missing entry coerced to `unresolved`. */
  readonly normalized: ModuleClassificationArtifact;
}

function coerceUnresolved(candidateId: string, reason: string): ClassifiedCandidate {
  return {
    candidateId,
    classification: "unresolved",
    confidence: 0,
    reason,
    evidenceRefs: [],
    status: "unresolved",
  };
}

/**
 * Validate a classifier's result against the exact candidate set it was given,
 * failing closed. A result is rejected — and the offending entry rewritten to
 * `unresolved` — when it invents a candidate id, drops one, repeats one, uses a
 * label outside the enum, or classifies with no evidence refs (or refs the
 * candidate never carried). The returned artifact is always safe to persist and
 * hand downstream: no malformed entry survives as a module.
 */
export function validateClassificationResult(
  candidates: readonly ModuleCandidate[],
  artifact: ModuleClassificationArtifact,
): ClassificationValidation {
  const diagnostics: ClassificationDiagnostic[] = [];
  const byCandidateId = new Map(candidates.map((c) => [c.candidateId, c] as const));
  const digest = candidateSetDigest(candidates);

  if (artifact.schemaVersion !== MODULE_CLASSIFICATION_SCHEMA_VERSION) {
    diagnostics.push({ candidateId: "*", reason: `schemaVersion ${artifact.schemaVersion} != ${MODULE_CLASSIFICATION_SCHEMA_VERSION}` });
  }
  if (artifact.candidateSetDigest !== digest) {
    diagnostics.push({ candidateId: "*", reason: "candidateSetDigest does not match the candidate set given" });
  }

  const seen = new Set<string>();
  const normalizedById = new Map<string, ClassifiedCandidate>();

  for (const result of artifact.candidates) {
    const input = byCandidateId.get(result.candidateId);
    if (input === undefined) {
      diagnostics.push({ candidateId: result.candidateId, reason: "classified an id that is not in the candidate set" });
      continue; // an invented id is dropped, never retained as a module
    }
    if (seen.has(result.candidateId)) {
      diagnostics.push({ candidateId: result.candidateId, reason: "duplicate classification for one candidate" });
      normalizedById.set(result.candidateId, coerceUnresolved(result.candidateId, "duplicate classification"));
      continue;
    }
    seen.add(result.candidateId);

    const problems: string[] = [];
    if (!MODULE_CLASSIFICATIONS.includes(result.classification)) {
      problems.push(`invalid classification ${String(result.classification)}`);
    }
    if (!(typeof result.confidence === "number" && result.confidence >= 0 && result.confidence <= 1)) {
      problems.push("confidence must be within [0,1]");
    }
    // A decision must be grounded; `unresolved` is the absence of a decision, so
    // it need not (and typically cannot) cite evidence. Any refs it does carry must
    // still belong to the candidate. A classifier that omits the array entirely
    // fails closed here rather than throwing.
    const refs = Array.isArray(result.evidenceRefs) ? result.evidenceRefs : [];
    const allowed = new Set(input.evidenceRefs);
    const foreign = refs.filter((ref) => !allowed.has(ref));
    if (foreign.length > 0) problems.push(`evidence refs not on the candidate: ${foreign.join(", ")}`);
    if (result.classification !== "unresolved" && refs.length === 0) {
      problems.push("classification carries no evidence refs");
    }

    if (problems.length > 0) {
      diagnostics.push({ candidateId: result.candidateId, reason: problems.join("; ") });
      normalizedById.set(result.candidateId, coerceUnresolved(result.candidateId, problems.join("; ")));
    } else {
      normalizedById.set(result.candidateId, result);
    }
  }

  for (const candidate of candidates) {
    if (!normalizedById.has(candidate.candidateId)) {
      diagnostics.push({ candidateId: candidate.candidateId, reason: "candidate was not classified" });
      normalizedById.set(candidate.candidateId, coerceUnresolved(candidate.candidateId, "not classified by the result"));
    }
  }

  const normalized: ModuleClassificationArtifact = {
    schemaVersion: MODULE_CLASSIFICATION_SCHEMA_VERSION,
    sourceSnapshotId: artifact.sourceSnapshotId,
    candidateSetDigest: digest,
    classifier: artifact.classifier,
    candidates: candidates.map((c) => normalizedById.get(c.candidateId)!),
  };

  return { ok: diagnostics.length === 0, diagnostics, normalized };
}

/**
 * The fail-closed artifact for a classifier that never produced a result — an AI
 * call that errored or timed out. Every candidate is `unresolved` with the same
 * reason, so a failed run scopes no module rather than defaulting to one.
 */
export function unresolvedArtifact(
  candidates: readonly ModuleCandidate[],
  sourceSnapshotId: string,
  classifier: ClassifierIdentity,
  reason: string,
): ModuleClassificationArtifact {
  return {
    schemaVersion: MODULE_CLASSIFICATION_SCHEMA_VERSION,
    sourceSnapshotId,
    candidateSetDigest: candidateSetDigest(candidates),
    classifier,
    candidates: candidates.map((c) => coerceUnresolved(c.candidateId, reason)),
  };
}

/**
 * The candidates that may become a canonical module scope (PI-76): a classified
 * product-module or technical-component. An external-system is a boundary entity
 * and an unresolved candidate is neither — both are excluded, never defaulted in.
 */
export function moduleScopeCandidates(
  artifact: ModuleClassificationArtifact,
): readonly ClassifiedCandidate[] {
  return artifact.candidates.filter(
    (c) => c.status === "classified" && MODULE_SCOPE_CLASSIFICATIONS.includes(c.classification),
  );
}
