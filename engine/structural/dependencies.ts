/**
 * The dependency graph above the symbol level.
 *
 * This exists for its own sake, not only as an aid to tracing. It is what lets
 * technical components be identified *structurally* — from containment and
 * dependency clustering — rather than only as whatever behaviour fails to
 * explain itself. A later stage inferring components from residue would be
 * guessing at something the manifests state outright.
 */

import type { Provenance, SourceRef } from "./provenance.js";

/**
 * Conventional package ecosystems. Open, and importantly so: this is the
 * field most likely to meet something unplanned — Swift Package Manager,
 * CocoaPods, Gradle, Cargo, Hex, CPAN, Conan, an in-house resolver. A closed
 * union here would mean a new language requires an engine change, which is
 * precisely the coupling the provider architecture exists to prevent.
 */
export const CONVENTIONAL_ECOSYSTEMS = [
  "npm",
  "go",
  "pypi",
  "maven",
  "gradle",
  "cargo",
  "nuget",
  "rubygems",
  "composer",
  "swiftpm",
  "cocoapods",
  "hex",
  "pub",
  "unknown",
] as const;

export type Ecosystem = (typeof CONVENTIONAL_ECOSYSTEMS)[number] | (string & {});

export const CONVENTIONAL_DEPENDENCY_SCOPES = [
  "runtime",
  "development",
  "test",
  "build",
  "peer",
  "optional",
  "unknown",
] as const;

export type DependencyScope = (typeof CONVENTIONAL_DEPENDENCY_SCOPES)[number] | (string & {});

/**
 * Closed: whether a dependency is declared by this project or pulled in by
 * something else is our distinction, not a language's, and there is no third
 * case.
 */
export type Directness = "direct" | "transitive";

export interface PackageDependencyRecord {
  readonly rootName: string;
  readonly ecosystem: Ecosystem;
  readonly name: string;
  /** As written in the manifest — a range, not a resolved version. */
  readonly versionConstraint: string | null;
  /** From a lockfile where one exists. Null is honest; a constraint is not a version. */
  readonly resolvedVersion: string | null;
  readonly scope: DependencyScope;
  readonly directness: Directness;
  readonly declaredIn: SourceRef;
  readonly provenance: Provenance;
}

/**
 * Conventional build target kinds. Open: an iOS scheme, a container image, a
 * Bazel rule, a firmware artifact and a shared library are all build targets,
 * and no closed list survives contact with the next build system.
 */
export const CONVENTIONAL_BUILD_TARGET_KINDS = [
  "binary",
  "library",
  "application",
  "test",
  "container-image",
  "package",
  "unknown",
] as const;

export type BuildTargetKind = (typeof CONVENTIONAL_BUILD_TARGET_KINDS)[number] | (string & {});

export interface BuildTargetRecord {
  readonly rootName: string;
  readonly name: string;
  readonly kind: BuildTargetKind;
  /** Names of other targets this one needs. Unresolved names are kept as written. */
  readonly dependsOn: readonly string[];
  readonly declaredIn: SourceRef;
  readonly provenance: Provenance;
}

export const CONVENTIONAL_CONTAINMENT_KINDS = [
  "package",
  "namespace",
  "folder",
  "module",
  "crate",
  "assembly",
  "unknown",
] as const;

export type ContainmentKind = (typeof CONVENTIONAL_CONTAINMENT_KINDS)[number] | (string & {});

/**
 * How the code is organised into units.
 *
 * Folder containment is always available for any project in any language,
 * which makes this the one dependency-graph fact that never comes back empty
 * — a useful floor for a project whose build system nothing understands yet.
 */
export interface ModuleContainmentRecord {
  readonly rootName: string;
  /** The containing unit's path or qualified name. */
  readonly containerPath: string;
  readonly memberPath: string;
  readonly kind: ContainmentKind;
  readonly provenance: Provenance;
}
