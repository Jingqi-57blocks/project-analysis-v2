export type { SourceRef, ResolutionClass, Confidence, Provenance } from "./provenance.js";
export {
  fileRef,
  lineRef,
  declared,
  resolved,
  inferred,
  unresolved,
  isDirectlyObserved,
} from "./provenance.js";

export type { SymbolId, SymbolIdParts } from "./identity.js";
export { symbolId, fileId } from "./identity.js";

export type {
  SymbolKind,
  ConventionalSymbolKind,
  Visibility,
  ReferenceKind,
  TypeRelation,
  SourceFileRecord,
  SymbolRecord,
  CallEdgeRecord,
  ImportRecord,
  ExportRecord,
  ReferenceRecord,
  TypeRelationRecord,
} from "./code.js";
export {
  CONVENTIONAL_SYMBOL_KINDS,
  CONVENTIONAL_VISIBILITIES,
  CONVENTIONAL_REFERENCE_KINDS,
  CONVENTIONAL_TYPE_RELATIONS,
} from "./code.js";

export type {
  Ecosystem,
  DependencyScope,
  Directness,
  BuildTargetKind,
  ContainmentKind,
  PackageDependencyRecord,
  BuildTargetRecord,
  ModuleContainmentRecord,
} from "./dependencies.js";
export {
  CONVENTIONAL_ECOSYSTEMS,
  CONVENTIONAL_DEPENDENCY_SCOPES,
  CONVENTIONAL_BUILD_TARGET_KINDS,
  CONVENTIONAL_CONTAINMENT_KINDS,
} from "./dependencies.js";

export type {
  OutboundKind,
  DataOperation,
  TestRelation,
  RouteRecord,
  OutboundCallRecord,
  ExternalCallRecord,
  DataAccessRecord,
  AuthAnnotationRecord,
  TestRelationRecord,
} from "./boundaries.js";
export {
  CONVENTIONAL_OUTBOUND_KINDS,
  CONVENTIONAL_DATA_OPERATIONS,
  CONVENTIONAL_TEST_RELATIONS,
} from "./boundaries.js";

export type {
  ErrorScope,
  ValidationRuleRecord,
  TransactionBoundaryRecord,
  ErrorHandlingRecord,
} from "./rules.js";
export { CONVENTIONAL_ERROR_SCOPES } from "./rules.js";

export type {
  StructuralKind,
  UniversalKind,
  ConditionalKind,
  StructuralRecords,
} from "./kinds.js";
export {
  STRUCTURAL_KINDS,
  UNIVERSAL_KINDS,
  CONDITIONAL_KINDS,
  emptyRecords,
  isUniversalKind,
  countRecords,
} from "./kinds.js";

export type {
  SupportLevel,
  CapabilityDeclaration,
  ProviderCapabilities,
  CapabilityGap,
  ExtractionFailure,
  StructuralRootInput,
  StructuralContribution,
  StructuralProvider,
} from "./provider.js";
export { ANY_LANGUAGE, declaredKinds, capabilityFor, supports } from "./provider.js";
