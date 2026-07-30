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
 *
 * **A reader reports every version it sees, and never chooses between them.**
 * These formats hold several versions of one package: npm nests a shadowed copy
 * under a dependent, yarn writes a block per range, go.sum keeps every version
 * a build ever hashed. Keeping only the first meant publishing whichever the
 * file happened to mention first — measured on WCP, `redux` was reported as
 * 4.2.1 against its own `^5.0.1` constraint. Reporting both lets the caller see
 * the ambiguity and state no version, which is the honest answer.
 */

import type { Ecosystem } from "../../structural/dependencies.js";

/**
 * Every (package, version) a lockfile states, in the order it states them.
 *
 * A list rather than a map: two entries for one name is the information that
 * matters, and a map is where that information used to be lost.
 */
export type ResolvedVersions = readonly (readonly [
  name: string,
  version: string,
  /**
   * Where this copy is installed, relative to the lockfile — set only for a
   * workspace member's own copy of a package. Absent means the top level.
   */
  directory?: string,
])[];

export interface LockfileReader {
  readonly ecosystem: Ecosystem;
  /** Exact filenames this reader claims, in the manifest's own directory. */
  readonly filenames: readonly string[];
  read(content: string): ResolvedVersions;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A source that is not a registry — a git URL, a tarball, a local path, a
 * workspace sibling.
 *
 * Such an entry's `version` is whatever that package declares, commonly
 * `0.0.0` or `0.0.0-use.local`, so publishing it states something false.
 */
function isNotFromRegistry(range: string): boolean {
  return /:\/\/|^git|^file:|^link:|^portal:|^workspace:|\.tgz/.test(range.replace(/^npm:/, ""));
}

/**
 * The same question asked of npm's `resolved` field, which is a URL even for an
 * ordinary release.
 *
 * `https://registry.npmjs.org/redux/-/redux-5.0.1.tgz` is exactly what a
 * registry install looks like, so the range test above — which treats `://` and
 * `.tgz` as suspicious because a *descriptor* containing them is a direct
 * download — rejected nearly every npm package when applied here. Only a
 * source that is not a release at all disqualifies an entry.
 */
function isNotAReleaseSource(resolved: string): boolean {
  return /^(git|git\+|file:|link:|portal:|workspace:)/.test(resolved);
}

/**
 * npm's install tree, read at the top level and at each workspace member.
 *
 * Two kinds of nested key look alike and mean opposite things.
 * `node_modules/a/node_modules/b` is a copy installed *for* package `a`, and
 * reading it let whichever came first answer for `b` — on wcp-ui that reported
 * `redux` 4.2.1 where 5.0.1 is installed. But `packages/b/node_modules/x` is
 * workspace member `b`'s own copy, installed there precisely because it needs a
 * different version from the hoisted one; dropping it published the root's
 * version as the member's. It is filed under its directory, and the lookup's
 * walk outwards from a manifest finds the nearest copy first.
 */
function npmLock(content: string): ResolvedVersions {
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  const found: ([string, string] | [string, string, string])[] = [];

  const INSTALL = /^(?:(.+)\/)?node_modules\/((?:@[^/]+\/)?[^/]+)$/;
  for (const [path, value] of Object.entries(asObject(record["packages"]))) {
    const install = INSTALL.exec(path);
    if (install === null) continue;
    const [, directory, name] = install;
    // A prefix that is itself inside node_modules is a copy for a dependent.
    if (directory !== undefined && directory.includes("node_modules")) continue;
    const entry = asObject(value);
    const version = entry["version"];
    const resolved = entry["resolved"];
    if (typeof version !== "string" || name === undefined) continue;
    // `resolved` names where it came from; a git or file source makes the
    // version field a placeholder rather than a release.
    if (typeof resolved === "string" && isNotAReleaseSource(resolved)) continue;
    if (entry["link"] === true) continue;
    found.push(directory === undefined ? [name, version] : [name, version, directory]);
  }

  // Lockfile v1 has no `packages`, only a `dependencies` tree. Its top level is
  // the hoisted install; a nested `dependencies` is again a copy for a
  // dependent, so it is not read — the same reason as above.
  if (found.length === 0) {
    for (const [name, value] of Object.entries(asObject(record["dependencies"]))) {
      const version = asObject(value)["version"];
      if (typeof version === "string") found.push([name, version]);
    }
  }

  return found;
}

/**
 * yarn.lock — its own format, but a line-oriented one.
 *
 * An entry heads a block with one or more `name@range` descriptors and states
 * `version "1.2.3"` inside it. A package depended on at two ranges gets two
 * blocks, and both are reported: which one a given manifest constraint gets is
 * a question this reader cannot answer, so it does not pretend to.
 */
function yarnLock(content: string): ResolvedVersions {
  const found: [string, string][] = [];
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
    for (const name of new Set(names)) found.push([name, version]);
    names = [];
  }

  return found;
}

/**
 * The package a descriptor asks for: `@scope/pkg@^1.2.3` → `@scope/pkg`.
 *
 * An alias (`pkg@npm:other@1.2.3`) keeps the asking name, since that is the
 * name the manifest depends on and the version resolved is what it gets.
 * Anything not from a registry is refused — see `isNotFromRegistry`.
 */
function nameOfDescriptor(descriptor: string): string | null {
  const alias = descriptor.indexOf("@npm:");
  const at = alias > 0 ? alias : descriptor.lastIndexOf("@");
  if (at <= 0) return descriptor === "" ? null : descriptor;
  if (isNotFromRegistry(descriptor.slice(at + 1))) return null;
  return descriptor.slice(0, at);
}

/**
 * pnpm-lock.yaml — read as lines rather than as YAML.
 *
 * The versions live in `packages:`/`snapshots:` keys of the form
 * `/name@1.2.3:` (v6 and earlier) or `name@1.2.3:` (v9), so a small line
 * reader gets them without a YAML dependency. Peer-suffixed keys
 * (`react@18.2.0(webpack@5)`) keep only the version before the bracket, and a
 * key naming anything but a registry release is skipped — a `file:` entry was
 * being reported with the version "file".
 */
function pnpmLock(content: string): ResolvedVersions {
  const found: [string, string][] = [];
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
    if (isNotFromRegistry(version) || !/^\d/.test(version)) continue;
    found.push([name, version]);
  }

  return found;
}

/**
 * A `[[package]]` list with `name` and `version` fields — the shape Cargo,
 * Poetry and Bundler's own lock formats share closely enough that one reader
 * serves all three honestly.
 */
function tomlPackageList(content: string): ResolvedVersions {
  const found: [string, string][] = [];
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
    if (versionMatch && name !== null) {
      found.push([name, versionMatch[1]!]);
      name = null;
    }
  }

  return found;
}

/** composer.lock — a JSON document listing installed packages with versions. */
function composerLock(content: string): ResolvedVersions {
  const parsed = asObject(JSON.parse(content));
  const found: [string, string][] = [];

  for (const section of ["packages", "packages-dev"]) {
    const list = parsed[section];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const record = asObject(entry);
      const name = record["name"];
      const version = record["version"];
      if (typeof name !== "string" || typeof version !== "string") continue;
      found.push([name, version]);
    }
  }

  return found;
}

/**
 * Gemfile.lock — indented `name (1.2.3)` entries under `specs:`.
 *
 * Bundler's format is neither JSON nor TOML, and the outer `GEM`/`PATH`
 * sections repeat the same shape, so the reader keys off the `specs:` marker
 * rather than the section name.
 */
function gemfileLock(content: string): ResolvedVersions {
  const found: [string, string][] = [];
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
    found.push([name, version]);
  }

  return found;
}

/**
 * go.sum — every module version the build has hashes for.
 *
 * Go pins exact versions in go.mod itself, so this reader exists for the case
 * go.mod does not cover. It reports every version it finds: a module upgraded
 * over the project's life has several, and choosing between them by file order
 * would have preferred `v0.1.0` over `v0.15.0`. Several versions leave the
 * lookup ambiguous, and the manifest's own pin then answers.
 *
 * `/go.mod` lines are skipped; they hash the manifest, not the module.
 */
function goSum(content: string): ResolvedVersions {
  const found: [string, string][] = [];

  for (const rawLine of content.split("\n")) {
    const [name, version] = rawLine.trim().split(/\s+/);
    if (name === undefined || version === undefined) continue;
    if (version.endsWith("/go.mod")) continue;
    found.push([name, version]);
  }

  return found;
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

/**
 * Whether a version could be what a constraint asked for.
 *
 * Not a semver implementation — a last check against publishing a version the
 * manifest visibly rules out. `^5.0.1` and `4.2.1` disagree about the major, so
 * whatever produced that pairing was wrong, and no version is better than one
 * the project's own manifest contradicts.
 *
 * Anything this cannot read — a tag, an `||` union, a wildcard major — passes,
 * because refusing what it does not understand would lose true versions.
 */
export function agreesWithConstraint(constraint: string | null, version: string): boolean {
  if (constraint === null) return true;
  const wanted = /^\s*[\^~>=]*\s*v?(\d+)\./.exec(constraint);
  const got = /^\s*v?(\d+)\./.exec(version);
  if (wanted === null || got === null) return true;
  if (/\|\||\s-\s/.test(constraint)) return true;
  // `>=4` admits 5; only a caret, a tilde, or a bare version fixes the major.
  if (/^\s*>/.test(constraint)) return true;
  return wanted[1] === got[1];
}
