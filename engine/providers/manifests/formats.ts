/**
 * Readers for declarative manifests.
 *
 * One reader per format, registered in a list, so supporting a new ecosystem
 * is additive — a new entry, no change to anything already working. That is
 * the whole point: a tool meant to read any project in any language cannot
 * have its ecosystem list baked into a switch statement somewhere.
 *
 * A format nobody has written a reader for is a **declared capability gap**,
 * never a crash and never a silent zero. The difference matters: a project
 * whose dependencies are simply not readable yet must not look like a project
 * with no dependencies.
 */

import type { Ecosystem } from "../../structural/dependencies.js";

export interface RawDependency {
  readonly name: string;
  readonly versionConstraint: string | null;
  readonly scope: string;
}

export interface RawTarget {
  readonly name: string;
  readonly kind: string;
}

/**
 * The runtime a manifest says it needs — Node, Go, Python.
 *
 * Kept apart from dependencies because it answers a different question. "Which
 * Node does this run on" is the first thing a reader asks about a stack, and it
 * would be lost among two hundred packages.
 */
export interface RawPlatform {
  readonly name: string;
  readonly versionConstraint: string | null;
}

export interface ManifestReading {
  readonly dependencies: readonly RawDependency[];
  readonly targets: readonly RawTarget[];
  readonly platforms?: readonly RawPlatform[];
}

export interface ManifestReader {
  readonly ecosystem: Ecosystem;
  /** Exact filenames this reader claims. */
  readonly filenames: readonly string[];
  /** How completely this format is understood, surfaced as a capability limit. */
  readonly limits: readonly string[];
  read(content: string): ManifestReading;
}

const EMPTY: ManifestReading = { dependencies: [], targets: [] };

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function depsFromRecord(record: Record<string, unknown>, scope: string): RawDependency[] {
  return Object.entries(record).map(([name, constraint]) => ({
    name,
    versionConstraint: typeof constraint === "string" ? constraint : null,
    scope,
  }));
}

/** package.json — dependencies, their scopes, and any declared executables. */
const npmReader: ManifestReader = {
  ecosystem: "npm",
  filenames: ["package.json"],
  limits: ["a dependency is resolved to an exact version only where a lockfile beside the manifest states one"],
  read(content) {
    const parsed = jsonObject(JSON.parse(content));

    const dependencies = [
      ...depsFromRecord(jsonObject(parsed["dependencies"]), "runtime"),
      ...depsFromRecord(jsonObject(parsed["devDependencies"]), "development"),
      ...depsFromRecord(jsonObject(parsed["peerDependencies"]), "peer"),
      ...depsFromRecord(jsonObject(parsed["optionalDependencies"]), "optional"),
    ];

    // Only executables the manifest actually declares. Treating every package
    // as a build target would invent structure the project never stated.
    const bin = parsed["bin"];
    const targets: RawTarget[] =
      typeof bin === "string"
        ? [{ name: String(parsed["name"] ?? "bin"), kind: "binary" }]
        : Object.keys(jsonObject(bin)).map((name) => ({ name, kind: "binary" }));

    const platforms = Object.entries(jsonObject(parsed["engines"])).map(([name, constraint]) => ({
      name,
      versionConstraint: typeof constraint === "string" ? constraint : null,
    }));

    return { dependencies, targets, platforms };
  },
};

const composerReader: ManifestReader = {
  ecosystem: "composer",
  filenames: ["composer.json"],
  limits: ["resolved versions require composer.lock, which is not read"],
  read(content) {
    const parsed = jsonObject(JSON.parse(content));
    return {
      dependencies: [
        ...depsFromRecord(jsonObject(parsed["require"]), "runtime"),
        ...depsFromRecord(jsonObject(parsed["require-dev"]), "development"),
      ],
      targets: [],
    };
  },
};

/**
 * go.mod — a line-oriented format, so this is exact rather than approximate.
 *
 * Handles both the block form (`require (` … `)`) and single-line requires,
 * and marks anything carrying `// indirect` as transitive, which is the one
 * place a Go manifest states directness outright.
 */
const goReader: ManifestReader = {
  ecosystem: "go",
  filenames: ["go.mod"],
  limits: ["replace and exclude directives are not applied"],
  read(content) {
    const dependencies: RawDependency[] = [];
    const platforms: RawPlatform[] = [];
    let inRequireBlock = false;

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("//")) continue;

      // `go 1.21` — the toolchain the module declares, which is the platform
      // version rather than a dependency on a module called "go".
      const toolchain = /^go\s+(\d[\w.-]*)$/.exec(line);
      if (toolchain) {
        platforms.push({ name: "go", versionConstraint: toolchain[1]! });
        continue;
      }

      if (line.startsWith("require (")) {
        inRequireBlock = true;
        continue;
      }
      if (inRequireBlock && line === ")") {
        inRequireBlock = false;
        continue;
      }

      const body = inRequireBlock ? line : line.startsWith("require ") ? line.slice(8).trim() : null;
      if (body === null) continue;

      const [name, version] = body.split(/\s+/);
      if (!name || name === "(") continue;

      dependencies.push({
        name,
        versionConstraint: version ?? null,
        scope: body.includes("// indirect") ? "transitive" : "runtime",
      });
    }

    return { dependencies, targets: [], platforms };
  },
};

/** requirements.txt — line-oriented, but expresses only names and constraints. */
const pipReader: ManifestReader = {
  ecosystem: "pypi",
  filenames: ["requirements.txt"],
  limits: ["environment markers, extras and -r includes are not followed"],
  read(content) {
    const dependencies: RawDependency[] = [];

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#") || line.startsWith("-")) continue;

      const match = /^([A-Za-z0-9._-]+)\s*(.*)$/.exec(line);
      if (!match) continue;
      dependencies.push({
        name: match[1]!,
        versionConstraint: match[2]!.trim() === "" ? null : match[2]!.trim(),
        scope: "runtime",
      });
    }

    return { dependencies, targets: [] };
  },
};

/**
 * Minimal TOML section reader for Cargo.toml and pyproject.toml.
 *
 * Deliberately not a TOML parser. It understands the two shapes dependencies
 * actually take — a table of `name = "constraint"` entries, and an array of
 * requirement strings — and declares everything else as a limit. Writing a
 * full parser to reach the remaining cases would be a large amount of code
 * that this stage does not need; claiming completeness without it would be
 * the dishonest option.
 */
function readTomlDependencies(content: string, tables: Readonly<Record<string, string>>): RawDependency[] {
  const dependencies: RawDependency[] = [];
  let currentTable = "";
  let arrayScope: string | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const section = /^\[+([^\]]+)\]+$/.exec(line);
    if (section) {
      currentTable = section[1]!.trim();
      arrayScope = null;
      continue;
    }

    // `dependencies = [` opens an array-of-requirements form (pyproject).
    const arrayStart = /^(dependencies|dev-dependencies|optional-dependencies)\s*=\s*\[$/.exec(line);
    if (arrayStart && (currentTable === "project" || currentTable.endsWith("dependencies"))) {
      arrayScope = arrayStart[1] === "dependencies" ? "runtime" : "development";
      continue;
    }
    if (arrayScope !== null) {
      if (line === "]") {
        arrayScope = null;
        continue;
      }
      const requirement = /^"([^"]+)"/.exec(line) ?? /^'([^']+)'/.exec(line);
      if (requirement) {
        const spec = requirement[1]!;
        const nameMatch = /^([A-Za-z0-9._-]+)\s*(.*)$/.exec(spec);
        if (nameMatch) {
          dependencies.push({
            name: nameMatch[1]!,
            versionConstraint: nameMatch[2]!.trim() === "" ? null : nameMatch[2]!.trim(),
            scope: arrayScope,
          });
        }
      }
      continue;
    }

    const scope = tables[currentTable];
    if (scope === undefined) continue;

    const entry = /^([A-Za-z0-9._-]+)\s*=\s*(.+)$/.exec(line);
    if (!entry) continue;

    const value = entry[2]!.trim();
    const quoted = /^"([^"]*)"$/.exec(value) ?? /^'([^']*)'$/.exec(value);
    // An inline table (`name = { version = "1" }`) keeps its version if one is stated.
    const inlineVersion = /version\s*=\s*"([^"]+)"/.exec(value);

    dependencies.push({
      name: entry[1]!,
      versionConstraint: quoted?.[1] ?? inlineVersion?.[1] ?? null,
      scope,
    });
  }

  return dependencies;
}

const cargoReader: ManifestReader = {
  ecosystem: "cargo",
  filenames: ["Cargo.toml"],
  limits: ["workspace inheritance and target-specific dependency tables are not resolved"],
  read(content) {
    return {
      dependencies: readTomlDependencies(content, {
        dependencies: "runtime",
        "dev-dependencies": "development",
        "build-dependencies": "build",
      }),
      targets: [],
    };
  },
};

const pyprojectReader: ManifestReader = {
  ecosystem: "pypi",
  filenames: ["pyproject.toml"],
  limits: ["only PEP 621 and Poetry dependency tables are understood"],
  read(content) {
    const requiresPython = /^\s*requires-python\s*=\s*"([^"]+)"/m.exec(content)?.[1] ?? null;
    return {
      dependencies: readTomlDependencies(content, {
        "tool.poetry.dependencies": "runtime",
        "tool.poetry.dev-dependencies": "development",
        "tool.poetry.group.dev.dependencies": "development",
      }),
      targets: [],
      platforms: requiresPython === null ? [] : [{ name: "python", versionConstraint: requiresPython }],
    };
  },
};

/**
 * pom.xml — matched structurally rather than parsed as XML.
 *
 * Each `<dependency>` element is read for its coordinates. Property
 * interpolation (`${spring.version}`) is left as written rather than
 * substituted, since resolving it needs the full inheritance chain and a wrong
 * version is worse than a visibly unresolved one.
 */
const mavenReader: ManifestReader = {
  ecosystem: "maven",
  filenames: ["pom.xml"],
  limits: [
    "parent POM inheritance is not resolved",
    "property placeholders in versions are left uninterpolated",
  ],
  read(content) {
    const dependencies: RawDependency[] = [];
    const blocks = content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g);

    for (const block of blocks) {
      const body = block[1]!;
      const groupId = /<groupId>([^<]+)<\/groupId>/.exec(body)?.[1]?.trim();
      const artifactId = /<artifactId>([^<]+)<\/artifactId>/.exec(body)?.[1]?.trim();
      if (!artifactId) continue;

      dependencies.push({
        name: groupId ? `${groupId}:${artifactId}` : artifactId,
        versionConstraint: /<version>([^<]+)<\/version>/.exec(body)?.[1]?.trim() ?? null,
        scope: /<scope>([^<]+)<\/scope>/.exec(body)?.[1]?.trim() ?? "runtime",
      });
    }

    return { dependencies, targets: [] };
  },
};

/** Registered readers. Adding an ecosystem means adding an entry here and nothing else. */
export const MANIFEST_READERS: readonly ManifestReader[] = [
  npmReader,
  goReader,
  pipReader,
  pyprojectReader,
  cargoReader,
  mavenReader,
  composerReader,
];

export function readerFor(filename: string): ManifestReader | null {
  return MANIFEST_READERS.find((reader) => reader.filenames.includes(filename)) ?? null;
}

/**
 * Manifest filenames recognized as declaring dependencies but not yet
 * readable, each reported as a capability gap when encountered.
 *
 * Listing them is the honest middle ground between silently ignoring a
 * project's dependencies and pretending to support formats nobody has written
 * a reader for.
 */
export const KNOWN_UNREADABLE_MANIFESTS: Readonly<Record<string, Ecosystem>> = {
  "build.gradle": "gradle",
  "build.gradle.kts": "gradle",
  "Package.swift": "swiftpm",
  Podfile: "cocoapods",
  Gemfile: "rubygems",
  "pubspec.yaml": "pub",
  "mix.exs": "hex",
  "CMakeLists.txt": "unknown",
};

export function isKnownUnreadable(filename: string): boolean {
  return filename in KNOWN_UNREADABLE_MANIFESTS || filename.endsWith(".csproj");
}

export { EMPTY as EMPTY_READING };
