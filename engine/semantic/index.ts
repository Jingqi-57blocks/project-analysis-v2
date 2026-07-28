export type {
  EvidenceKind,
  EvidenceItem,
  CollectorCapability,
  CollectorCapabilities,
  EvidenceGap,
  CollectionFailure,
  SemanticRootInput,
  SemanticContribution,
  SemanticCollector,
} from "./types.js";
export { CONVENTIONAL_EVIDENCE_KINDS } from "./types.js";

export type { EvidenceAttribution, AssembledEvidence, AssembledEvidenceSet } from "./assemble.js";
export { assembleEvidence, collectAll, evidenceKey } from "./assemble.js";

export type { EvidenceCounts, StoredEvidence } from "./persist.js";
export { recordEvidence, readEvidence, readEvidenceConflicts } from "./persist.js";
