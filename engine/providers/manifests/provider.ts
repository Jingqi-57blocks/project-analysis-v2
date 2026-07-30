/**
 * Reads the dependency graph that lives above the symbol level, straight from
 * declarative manifests.
 *
 * A separate provider rather than a branch inside the CodeGraph adapter: the
 * stated principle is that a capability gap is filled by composing another
 * provider, and package dependencies are a gap CodeGraph declares outright.
 *
 * No code parsing happens here. Manifests are declarative, which is what keeps
 * this a small reader rather than per-language analysis.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import { emptyRecords } from "../../structural/kinds.js";
import { declared, fileRef } from "../../structural/provenance.js";
import {
  ANY_LANGUAGE,
  declaredKinds,
  type CapabilityGap,
  type ExtractionFailure,
  type ProviderCapabilities,
  type StructuralContribution,
  type StructuralProvider,
  type StructuralRootInput,
} from "../../structural/provider.js";
import type { PreflightResult } from "../types.js";
import type {
  BuildTargetRecord,
  ModuleContainmentRecord,
  PackageDependencyRecord,
} from "../../structural/dependencies.js";
import {
  KNOWN_UNREADABLE_MANIFESTS,
  MANIFEST_READERS,
  isKnownUnreadable,
  readerFor,
} from "./formats.js";
import {
  LOCKFILE_READERS,
  lockfileNames,
  lockfileReaderFor,
  pinnedByManifest,
} from "./lockfiles.js";

export const PROVIDER_ID = "manifests";
export const PROVIDER_VERSION = "1.0.0";

/**
 * Folder containment for every analyzed file.
 *
 * The one dependency-graph fact available for any project in any language,
 * whatever its build system — which makes it a useful floor. A project whose
 * manifest format nobody has written a reader for still gets a usable
 * containment graph rather than nothing at all.
 */
export function folderContainment(
  rootName: string,
  analyzedFiles: readonly string[],
): readonly ModuleContainmentRecord[] {
  const seen = new Set<string>();
  const records: ModuleContainmentRecord[] = [];

  for (const relPath of analyzedFiles) {
    const segments = relPath.split(sep);
    // Walk each ancestor so nested folders are related to their parents, not
    // only leaves to the root.
    for (let depth = 0; depth < segments.length; depth++) {
      const container = segments.slice(0, depth).join(sep);
      const member = segments.slice(0, depth + 1).join(sep);
      const key = `${container}>${member}`;
      if (seen.has(key)) continue;
      seen.add(key);

      records.push({
        rootName,
        containerPath: container === "" ? "." : container,
        memberPath: member,
        kind: "folder",
        provenance: declared(fileRef(rootName, member)),
      });
    }
  }

  return records;
}

export function manifestCapabilities(): ProviderCapabilities {
  const readerLimits = MANIFEST_READERS.flatMap((reader) =>
    reader.limits.map((limit) => `${reader.ecosystem}: ${limit}`),
  );

  return {
    declarations: [
      {
        kind: "package-dependency",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: [
          `readable formats: ${MANIFEST_READERS.flatMap((r) => r.filenames).join(", ")}`,
          `recognized but not yet readable: ${Object.keys(KNOWN_UNREADABLE_MANIFESTS).join(", ")}, *.csproj`,
          `exact versions are read from ${LOCKFILE_READERS.flatMap((r) => r.filenames).join(", ")}; a dependency whose lockfile is absent, unreadable, or contradicted by a second lockfile keeps its declared range and no exact version`,
          ...readerLimits,
        ],
      },
      {
        kind: "module-containment",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: ["folder containment only; language package and namespace structure is not read"],
      },
      {
        kind: "build-target",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: ["only executables a manifest declares outright are recorded"],
      },
    ],
  };
}

interface Collected {
  readonly dependencies: PackageDependencyRecord[];
  readonly targets: BuildTargetRecord[];
  readonly gaps: CapabilityGap[];
  readonly failures: ExtractionFailure[];
}

/** Every version a lockfile pins, by the directory the lockfile sits in. */
type LockIndex = Map<string, Map<string, Set<string>>>;

/**
 * Reads the lockfiles this root has, keyed by directory.
 *
 * Nothing new is opened on disk: lockfiles are in the file inventory already,
 * so this reads what the walk found. A malformed one is a failure against that
 * file, leaving every other lockfile's versions intact.
 */
function readLockfiles(root: StructuralRootInput, failures: ExtractionFailure[]): LockIndex {
  const index: LockIndex = new Map();

  for (const relPath of root.analyzedFiles) {
    const reader = lockfileReaderFor(basename(relPath));
    if (reader === null) continue;

    try {
      const versions = reader.read(readFileSync(join(root.path, relPath), "utf8"));
      const directory = dirname(relPath);
      const forDirectory = index.get(directory) ?? new Map<string, Set<string>>();
      for (const [name, version] of versions) {
        const seen = forDirectory.get(name) ?? new Set<string>();
        seen.add(version);
        forDirectory.set(name, seen);
      }
      index.set(directory, forDirectory);
    } catch (error) {
      failures.push({
        scope: relPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return index;
}

/**
 * The version a lockfile states for one package, or null.
 *
 * Searched from the manifest's own directory outwards, because a workspace
 * keeps one lockfile at its root for packages nested below it.
 *
 * Two coexisting lockfiles disagreeing — a project with both yarn.lock and
 * package-lock.json, which is commoner than it should be — resolves to null.
 * Picking one would state a version the project does not agree with itself
 * about, and the constraint is then shown as what it is.
 */
function versionFor(index: LockIndex, directory: string, name: string): string | null {
  let current = directory;
  for (;;) {
    const versions = index.get(current)?.get(name);
    if (versions !== undefined && versions.size === 1) return [...versions][0]!;
    if (versions !== undefined && versions.size > 1) return null;
    if (current === "." || current === "" || current === sep) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function collect(root: StructuralRootInput): Collected {
  const dependencies: PackageDependencyRecord[] = [];
  const targets: BuildTargetRecord[] = [];
  const gaps: CapabilityGap[] = [];
  const failures: ExtractionFailure[] = [];
  const reportedGaps = new Set<string>();
  const locks = readLockfiles(root, failures);
  /** Ecosystems whose versions no lockfile in this root could settle. */
  const unresolved = new Map<string, number>();
  const resolvedCounts = new Map<string, number>();

  for (const relPath of root.analyzedFiles) {
    const filename = basename(relPath);

    if (isKnownUnreadable(filename)) {
      const ecosystem = KNOWN_UNREADABLE_MANIFESTS[filename] ?? "nuget";
      if (!reportedGaps.has(ecosystem)) {
        reportedGaps.add(ecosystem);
        // A recognized manifest nobody can read yet is a declared gap, so the
        // project does not look like one without dependencies.
        gaps.push({
          kind: "package-dependency",
          language: ecosystem,
          reason: `${filename} declares dependencies but no reader supports this format yet`,
        });
      }
      continue;
    }

    const reader = readerFor(filename);
    if (!reader) continue;

    try {
      const content = readFileSync(join(root.path, relPath), "utf8");
      const reading = reader.read(content);
      const source = fileRef(root.name, relPath);

      for (const dependency of reading.dependencies) {
        // A constraint is not a version. The exact version comes from a
        // lockfile, or from a manifest that pins outright as Go's does; where
        // neither states one it stays honestly null.
        const resolvedVersion =
          versionFor(locks, dirname(relPath), dependency.name) ??
          pinnedByManifest(reader.ecosystem, dependency.versionConstraint);
        const counter = resolvedVersion === null ? unresolved : resolvedCounts;
        counter.set(reader.ecosystem, (counter.get(reader.ecosystem) ?? 0) + 1);

        dependencies.push({
          rootName: root.name,
          ecosystem: reader.ecosystem,
          name: dependency.name,
          versionConstraint: dependency.versionConstraint,
          resolvedVersion,
          scope: dependency.scope === "transitive" ? "runtime" : dependency.scope,
          directness: dependency.scope === "transitive" ? "transitive" : "direct",
          declaredIn: source,
          provenance: declared(source),
        });
      }

      // The runtime a manifest names — Node, Go, Python. Recorded as a
      // dependency with its own scope rather than a kind of its own: it is a
      // versioned thing the project declares it needs, which is what this
      // record already is, and `platform` keeps it separable from packages.
      for (const platform of reading.platforms ?? []) {
        dependencies.push({
          rootName: root.name,
          ecosystem: reader.ecosystem,
          name: platform.name,
          versionConstraint: platform.versionConstraint,
          resolvedVersion: null,
          scope: "platform",
          directness: "direct",
          declaredIn: source,
          provenance: declared(source),
        });
      }

      for (const target of reading.targets) {
        targets.push({
          rootName: root.name,
          name: target.name,
          kind: target.kind,
          dependsOn: [],
          declaredIn: source,
          provenance: declared(source),
        });
      }
    } catch (error) {
      // One malformed manifest must not discard every other manifest's
      // dependencies — the same per-item isolation used throughout.
      failures.push({
        scope: relPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // An ecosystem where nothing resolved is one whose lockfile is missing or
  // unreadable, and every version shown for it is a range. Reported once per
  // ecosystem, in words that do not name this root, so a workspace of ten
  // services states it once rather than ten times.
  for (const [ecosystem, count] of unresolved) {
    if ((resolvedCounts.get(ecosystem) ?? 0) > 0) continue;
    const names = lockfileNames(ecosystem);
    gaps.push({
      kind: "package-dependency",
      language: ecosystem,
      reason:
        names.length === 0
          ? `no lockfile reader supports ${ecosystem}, so its ${count} dependencies are shown with the ranges their manifest declares rather than installed versions`
          : `no readable ${names.join(" or ")} was found beside the ${ecosystem} manifests, so their dependency versions are the declared ranges rather than installed versions`,
    });
  }

  return { dependencies, targets, gaps, failures };
}

export function createManifestProvider(): StructuralProvider {
  const capabilities = manifestCapabilities();

  return {
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,

    capabilities: () => declaredKinds(capabilities),

    // Nothing external is needed — this reads files the run already has.
    preflight: (): PreflightResult => ({ available: true, version: PROVIDER_VERSION }),

    structuralCapabilities: () => capabilities,

    extract: (root: StructuralRootInput): StructuralContribution => {
      const collected = collect(root);

      return {
        providerId: PROVIDER_ID,
        providerVersion: PROVIDER_VERSION,
        rootName: root.name,
        records: {
          ...emptyRecords(),
          "package-dependency": collected.dependencies,
          "build-target": collected.targets,
          "module-containment": folderContainment(root.name, root.analyzedFiles),
        },
        gaps: collected.gaps,
        failures: collected.failures,
      };
    },
  };
}

