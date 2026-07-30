/**
 * Readers for lockfiles — the only place a project states the version it
 * actually runs.
 *
 * A manifest states a range: `^5.0.0` says a family of versions is acceptable,
 * not which one is installed. A reader asking "which TypeScript is this" is
 * asking about the lockfile, and answering from the manifest instead means
 * publishing a range as if it were a fact.
 *
 * Same registry shape as `formats.ts`, for the same reason: a new ecosystem is
 * a new entry. A lockfile format nobody has written a reader for leaves the
 * resolved version null, which the report shows as an unresolved constraint —
 * never as a version.
 */

import type { Ecosystem } from "../../structural/dependencies.js";

/** Package name → the exact version the lockfile pins it to. */
export type ResolvedVersions = ReadonlyMap<string, string>;

export interface LockfileReader {
  readonly ecosystem: Ecosystem;
  /** Exact filenames this reader claims, in the manifest's own directory. */
  readonly filenames: readonly string[];
  read(content: string): ResolvedVersions;
}

/** Reads `"version": "1.2.3"` out of npm's nested package trees. */
function npmLock(content: string): ResolvedVersions {
  const parsed: unknown = JSON.parse(content);
  const versions = new Map<string, string>();
  if (typeof parsed !== "object" || parsed === null) return versions;

  const record = parsed as Record<string, unknown>;

  // Lockfile v2/v3: keys are install paths, so the name is the segment after
  // the last `node_modules/`. A workspace's own package sits at "" and has no
  // version worth reporting as a dependency's.
  for (const [path, value] of Object.entries(asObject(record["packages"]))) {
    const name = path.split("node_modules/").pop();
    const version = asObject(value)["version"];
    if (name === undefined || name === "" || typeof version !== "string") continue;
    if (!versions.has(name)) versions.set(name, version);
  }

  // Lockfile v1 kept a `dependencies` tree instead. Read both: a v2 file
  // carries the legacy section too, and `packages` wins because it is the one
  // the installer uses.
  const walk = (tree: Record<string, unknown>): void => {
    for (const [name, value] of Object.entries(tree)) {
      const entry = asObject(value);
      const version = entry["version"];
      if (typeof version === "string" && !versions.has(name)) versions.set(name, version);
      walk(asObject(entry["dependencies"]));
    }
  };
  walk(asObject(record["dependencies"]));

  return versions;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * yarn.lock — its own format, but a line-oriented one.
 *
 * An entry heads a block with one or more `name@range` descriptors and states
 * `version "1.2.3"` inside it. Scoped names carry a second `@`, so the name is
 * everything before the last one.
 */
function yarnLock(content: string): ResolvedVersions {
  const versions = new Map<string, string>();
  let names: string[] = [];

  for (const rawLine of content.split("\n")) {
    if (rawLine.trim() === "" || rawLine.startsWith("#")) continue;

    if (!rawLine.startsWith(" ") && !rawLine.startsWith("\t")) {
      names = rawLine
        .replace(/:$/, "")
        .split(",")
        .map((descriptor) => nameOfDescriptor(descriptor.trim().replaceAll('"', "")))
        .filter((name): name is string => name !== null);
      continue;
    }

    const version = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(rawLine)?.[1];
    if (version === undefined) continue;
    for (const name of names) if (!versions.has(name)) versions.set(name, version);
    names = [];
  }

  return versions;
}

/** `@scope/pkg@^1.2.3` → `@scope/pkg`; `pkg@npm:other@1` keeps the asking name. */
function nameOfDescriptor(descriptor: string): string | null {
  const at = descriptor.lastIndexOf("@");
  if (at <= 0) return descriptor === "" ? null : descriptor;
  return descriptor.slice(0, at);
}

/**
 * pnpm-lock.yaml — read as lines rather than as YAML.
 *
 * The versions live in `packages:`/`snapshots:` keys of the form
 * `/name@1.2.3:` (v6 and earlier) or `name@1.2.3:` (v9), so a small line
 * reader gets them without a YAML dependency. Peer-suffixed keys
 * (`react@18.2.0(webpack@5)`) keep only the version before the bracket.
 */
function pnpmLock(content: string): ResolvedVersions {
  const versions = new Map<string, string>();
  let inPackages = false;

  for (const rawLine of content.split("\n")) {
    if (/^[a-zA-Z]/.test(rawLine)) {
      inPackages = /^(packages|snapshots):/.test(rawLine);
      continue;
    }
    if (!inPackages) continue;

    const key = /^ {2}'?\/?((?:@[^@/]+\/)?[^@'\s]+)@([^:'()\s]+)/.exec(rawLine.replace(/:$/, ""));
    if (key === null) continue;
    const [, name, version] = key;
    if (name === undefined || version === undefined) continue;
    if (!versions.has(name)) versions.set(name, version);
  }

  return versions;
}

/**
 * A `[[package]]` list with `name` and `version` fields — the shape Cargo,
 * Poetry and Bundler's own lock formats share closely enough that one reader
 * serves all three honestly.
 */
function tomlPackageList(content: string): ResolvedVersions {
  const versions = new Map<string, string>();
  let name: string | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[[")) {
      name = null;
      continue;
    }
    const nameMatch = /^name\s*=\s*"([^"]+)"/.exec(line);
    if (nameMatch) {
      name = nameMatch[1]!;
      continue;
    }
    const versionMatch = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (versionMatch && name !== null && !versions.has(name)) {
      versions.set(name, versionMatch[1]!);
      name = null;
    }
  }

  return versions;
}

/** composer.lock — a JSON document listing installed packages with versions. */
function composerLock(content: string): ResolvedVersions {
  const parsed = asObject(JSON.parse(content));
  const versions = new Map<string, string>();

  for (const section of ["packages", "packages-dev"]) {
    const list = parsed[section];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const record = asObject(entry);
      const name = record["name"];
      const version = record["version"];
      if (typeof name !== "string" || typeof version !== "string") continue;
      if (!versions.has(name)) versions.set(name, version);
    }
  }

  return versions;
}

/**
 * Gemfile.lock — indented `name (1.2.3)` entries under `specs:`.
 *
 * Bundler's format is neither JSON nor TOML, and the outer `GEM`/`PATH`
 * sections repeat the same shape, so the reader keys off the `specs:` marker
 * rather than the section name.
 */
function gemfileLock(content: string): ResolvedVersions {
  const versions = new Map<string, string>();
  let inSpecs = false;

  for (const rawLine of content.split("\n")) {
    if (/^\s*specs:\s*$/.test(rawLine)) {
      inSpecs = true;
      continue;
    }
    if (rawLine.trim() === "") {
      inSpecs = false;
      continue;
    }
    if (!inSpecs) continue;

    // Four spaces is a spec; six is one of its dependencies, whose parenthesis
    // holds a constraint rather than an installed version.
    const spec = /^ {4}(\S+) \(([^)]+)\)/.exec(rawLine);
    if (spec === null) continue;
    const [, name, version] = spec;
    if (name === undefined || version === undefined) continue;
    if (!versions.has(name)) versions.set(name, version);
  }

  return versions;
}

/**
 * go.sum — every module version the build has hashes for.
 *
 * Go pins exact versions in go.mod itself, so this reader exists for the case
 * go.mod does not cover: a version reached through a `replace` directive or an
 * upgrade recorded only in the sum file. `/go.mod` lines are skipped; they
 * hash the manifest, not the module.
 */
function goSum(content: string): ResolvedVersions {
  const versions = new Map<string, string>();

  for (const rawLine of content.split("\n")) {
    const parts = rawLine.trim().split(/\s+/);
    const [name, version] = parts;
    if (name === undefined || version === undefined) continue;
    if (version.endsWith("/go.mod")) continue;
    if (!versions.has(name)) versions.set(name, version);
  }

  return versions;
}

/** Registered readers. A new ecosystem is a new entry and nothing else. */
export const LOCKFILE_READERS: readonly LockfileReader[] = [
  { ecosystem: "npm", filenames: ["pnpm-lock.yaml"], read: pnpmLock },
  { ecosystem: "npm", filenames: ["yarn.lock"], read: yarnLock },
  { ecosystem: "npm", filenames: ["package-lock.json", "npm-shrinkwrap.json"], read: npmLock },
  { ecosystem: "go", filenames: ["go.sum"], read: goSum },
  { ecosystem: "composer", filenames: ["composer.lock"], read: composerLock },
  { ecosystem: "pypi", filenames: ["poetry.lock"], read: tomlPackageList },
  { ecosystem: "cargo", filenames: ["Cargo.lock"], read: tomlPackageList },
  { ecosystem: "rubygems", filenames: ["Gemfile.lock"], read: gemfileLock },
];

export function lockfileReaderFor(filename: string): LockfileReader | null {
  return LOCKFILE_READERS.find((reader) => reader.filenames.includes(filename)) ?? null;
}

/** Lockfile names an ecosystem's readers claim, for a capability's limits. */
export function lockfileNames(ecosystem: Ecosystem): readonly string[] {
  return LOCKFILE_READERS.filter((reader) => reader.ecosystem === ecosystem).flatMap(
    (reader) => reader.filenames,
  );
}

/**
 * A version stated exactly by the manifest itself.
 *
 * Go modules record `v1.9.1`, not a range — a lockfile adds nothing there, and
 * treating the manifest's text as unresolved would lose a version the project
 * states outright. Anything carrying range syntax is a constraint and stays one.
 */
export function pinnedByManifest(ecosystem: Ecosystem, constraint: string | null): string | null {
  if (constraint === null) return null;
  const value = constraint.trim();
  if (ecosystem === "go") return /^v\d+\.\d+\.\d+/.test(value) ? value : null;
  // `==1.2.3` is pip's way of pinning exactly one version.
  if (ecosystem === "pypi") return /^==\s*\d[\w.!+-]*$/.test(value) ? value.replace(/^==\s*/, "") : null;
  return null;
}
