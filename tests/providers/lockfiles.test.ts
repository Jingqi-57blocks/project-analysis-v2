import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createManifestProvider } from "../../engine/providers/manifests/provider.js";
import {
  lockfileReaderFor,
  pinnedByManifest,
} from "../../engine/providers/manifests/lockfiles.js";

let workDir: string;

function write(relPath: string, content: string): void {
  const full = join(workDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function extract(files: readonly string[]) {
  return createManifestProvider().extract({ name: "svc", path: workDir, analyzedFiles: files });
}

function versionOf(files: readonly string[], name: string): string | null {
  const dependency = extract(files).records["package-dependency"].find(
    (entry) => entry.name === name,
  );
  return dependency?.resolvedVersion ?? null;
}

/**
 * What a reader saw, as a map for the assertions that want one.
 *
 * A reader reports every version it finds, so a name with two of them appears
 * twice; `versionsOf` is how a test asks about that deliberately.
 */
function read(filename: string, content: string): ReadonlyMap<string, string> {
  return new Map(
    lockfileReaderFor(filename)!
      .read(content)
      .map(([name, version]) => [name, version] as const),
  );
}

/** Every entry a reader reported, with the directory it filed each under. */
function entries(filename: string, content: string) {
  return lockfileReaderFor(filename)!.read(content);
}

/** Every version a reader reported for one package, in order. */
function versionsOf(filename: string, content: string, name: string): string[] {
  return lockfileReaderFor(filename)!
    .read(content)
    .filter(([found]) => found === name)
    .map(([, version]) => version);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-lockfiles-"));
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

describe("reading an exact version out of a lockfile", () => {
  it("reads npm's install tree at the top level, where the project's own copy is", () => {
    const versions = read(
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          "node_modules/typescript": { version: "5.4.5" },
          "node_modules/@scope/pkg": { version: "2.1.0" },
          "node_modules/a/node_modules/b": { version: "0.3.0" },
        },
      }),
    );
    expect(versions.get("typescript")).toBe("5.4.5");
    expect(versions.get("@scope/pkg")).toBe("2.1.0");
    // A copy installed *for* another package is not what the project gets.
    expect(versions.has("b")).toBe(false);
  });

  it("is not fooled by a nested copy of a package the project depends on", () => {
    // Measured on wcp-ui: iteration order let `node_modules/x/node_modules/redux`
    // answer for redux, reporting 4.2.1 where 5.0.1 is installed.
    const versions = read(
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/legacy/node_modules/redux": { version: "4.2.1" },
          "node_modules/redux": { version: "5.0.1" },
        },
      }),
    );
    expect(versions.get("redux")).toBe("5.0.1");
  });

  it("reads a version-1 npm lockfile at its top level only", () => {
    const versions = read(
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          express: { version: "4.16.4", dependencies: { debug: { version: "4.3.2" } } },
          debug: { version: "2.6.9" },
        },
      }),
    );
    expect(versions.get("express")).toBe("4.16.4");
    // wcp-service depends on debug directly at 2.6.9; the copy nested under
    // express is 4.3.2, and walking the tree reported that one.
    expect(versions.get("debug")).toBe("2.6.9");
  });

  it("reports both versions when a lockfile holds two, rather than choosing", () => {
    // yarn writes a block per range. Which block a given constraint gets is a
    // question this reader cannot answer, so it hands back both and the caller
    // states no version.
    const versions = versionsOf(
      "yarn.lock",
      [
        'redux@^4.0.0:',
        '  version "4.2.1"',
        "",
        'redux@^5.0.1:',
        '  version "5.0.1"',
      ].join("\n"),
      "redux",
    );
    expect(versions).toEqual(["4.2.1", "5.0.1"]);
  });

  it("reports every version go.sum hashed, so file order cannot pick one", () => {
    const versions = versionsOf(
      "go.sum",
      [
        "golang.org/x/sys v0.1.0 h1:aaa=",
        "golang.org/x/sys v0.15.0 h1:bbb=",
      ].join("\n"),
      "golang.org/x/sys",
    );
    expect(versions).toEqual(["v0.1.0", "v0.15.0"]);
  });

  it("reads yarn's blocks, keeping the scope in a scoped name", () => {
    const versions = read(
      "yarn.lock",
      [
        "# yarn lockfile v1",
        "",
        '"@babel/runtime@^7.8.0":',
        '  version "7.8.0"',
        "",
        'react@^18.0.0, react@^18.2.0:',
        '  version "18.3.1"',
        "",
      ].join("\n"),
    );
    expect(versions.get("@babel/runtime")).toBe("7.8.0");
    // One block can be reached by several ranges; both name the same install.
    expect(versions.get("react")).toBe("18.3.1");
  });

  it("states no version for a dependency that does not come from a registry", () => {
    // A git or tarball dependency's `version` field is whatever the package
    // happens to declare — commonly `0.0.0` — so publishing it as the
    // installed version states something false rather than leaving a gap.
    const versions = read(
      "yarn.lock",
      [
        '"tool@https://github.com/a/b.git#v1.2.3":',
        '  version "0.0.0"',
        "",
        '"local@file:../local":',
        '  version "1.0.0"',
        "",
        '"real@^2.0.0":',
        '  version "2.1.0"',
      ].join("\n"),
    );
    expect(versions.has("tool")).toBe(false);
    expect(versions.has("local")).toBe(false);
    // And the registry dependency beside them is still read.
    expect(versions.get("real")).toBe("2.1.0");
  });

  it("refuses a workspace sibling and a pnpm entry that is not a release", () => {
    // `myapp@workspace:.` publishes the placeholder 0.0.0-use.local, and a
    // pnpm `file:` key was being read with the version "file".
    expect(read("yarn.lock", ['"myapp@workspace:.":', "  version: 0.0.0-use.local"].join("\n")).size).toBe(0);

    const pnpm = read(
      "pnpm-lock.yaml",
      ["packages:", "", "  local@file:../x:", "    resolution: {}", "", "  ok@1.2.3:", "    resolution: {}"].join("\n"),
    );
    expect([...pnpm.keys()]).toEqual(["ok"]);
  });

  it("refuses an npm entry installed from git or linked from disk", () => {
    const versions = read(
      "package-lock.json",
      JSON.stringify({
        packages: {
          "node_modules/from-git": { version: "0.0.0", resolved: "git+ssh://git@github.com/a/b.git#abc" },
          "node_modules/linked": { version: "1.0.0", link: true },
          // A registry release names a tarball URL, which is ordinary.
          "node_modules/real": { version: "2.0.0", resolved: "https://registry.npmjs.org/real/-/real-2.0.0.tgz" },
        },
      }),
    );
    expect([...versions.keys()]).toEqual(["real"]);
  });

  it("resolves an aliased dependency under the name that asks for it", () => {
    const versions = read(
      "yarn.lock",
      ['"left-pad@npm:@scope/other@^1.2.3":', '  version "1.2.3"'].join("\n"),
    );
    expect(versions.get("left-pad")).toBe("1.2.3");
  });

  it("tells a workspace member's own copy from a copy installed for a dependent", () => {
    // `packages/app` is a directory, not an install path — reading it put a
    // path where a package name belongs. `packages/app/node_modules/x` is the
    // member's own copy, kept and filed under the member so a manifest there
    // finds it. `node_modules/a/node_modules/x` is a copy for `a`, and reading
    // it let whichever came first answer for x.
    const found = entries(
      "package-lock.json",
      JSON.stringify({
        packages: {
          "": { name: "root" },
          "packages/app": { name: "app", version: "1.0.0" },
          "node_modules/lodash": { version: "4.17.21" },
          "packages/app/node_modules/lodash": { version: "3.10.1" },
          "node_modules/legacy/node_modules/lodash": { version: "2.4.2" },
        },
      }),
    );

    expect(found).toEqual([
      ["lodash", "4.17.21"],
      ["lodash", "3.10.1", "packages/app"],
    ]);
  });

  it("reads pnpm's keys in both the v6 and v9 spellings, dropping peer suffixes", () => {
    const versions = read(
      "pnpm-lock.yaml",
      [
        "lockfileVersion: '9.0'",
        "",
        "packages:",
        "",
        "  /typescript@5.4.5:",
        "    resolution: {integrity: sha512-x}",
        "",
        "  '@scope/pkg@2.1.0':",
        "    resolution: {integrity: sha512-y}",
        "",
        "  react@18.3.1(webpack@5.90.0):",
        "    resolution: {integrity: sha512-z}",
        "",
        "settings:",
        "  autoInstallPeers: true",
      ].join("\n"),
    );
    expect(versions.get("typescript")).toBe("5.4.5");
    expect(versions.get("@scope/pkg")).toBe("2.1.0");
    expect(versions.get("react")).toBe("18.3.1");
    // Outside `packages:`, nothing is a package.
    expect(versions.has("autoInstallPeers")).toBe(false);
  });

  it("reads a package list in the shape Cargo, Poetry and Bundler's locks share", () => {
    const cargo = read(
      "Cargo.lock",
      ['[[package]]', 'name = "serde"', 'version = "1.0.197"', "", '[[package]]', 'name = "tokio"', 'version = "1.36.0"'].join("\n"),
    );
    expect(cargo.get("serde")).toBe("1.0.197");
    expect(cargo.get("tokio")).toBe("1.36.0");

    const gems = read(
      "Gemfile.lock",
      ["GEM", "  specs:", "    rails (7.1.3)", "      activesupport (= 7.1.3)", "    rake (13.1.0)", ""].join("\n"),
    );
    expect(gems.get("rails")).toBe("7.1.3");
    // Six-space lines are a spec's own requirements — constraints, not installs.
    expect(gems.has("activesupport")).toBe(false);
  });

  it("reads composer's installed packages", () => {
    const versions = read(
      "composer.lock",
      JSON.stringify({
        packages: [{ name: "laravel/framework", version: "v10.48.2" }],
        "packages-dev": [{ name: "phpunit/phpunit", version: "10.5.11" }],
      }),
    );
    expect(versions.get("laravel/framework")).toBe("v10.48.2");
    expect(versions.get("phpunit/phpunit")).toBe("10.5.11");
  });

  it("skips go.sum's go.mod hash lines, which are not module versions", () => {
    const versions = read(
      "go.sum",
      [
        "github.com/gin-gonic/gin v1.7.7/go.mod h1:aaa=",
        "github.com/gin-gonic/gin v1.7.7 h1:bbb=",
      ].join("\n"),
    );
    expect(versions.get("github.com/gin-gonic/gin")).toBe("v1.7.7");
  });
});

describe("what the provider does with those versions", () => {
  it("resolves a dependency against the lockfile beside its manifest", () => {
    write("package.json", JSON.stringify({ dependencies: { typescript: "^5.0.0" } }));
    write("package-lock.json", JSON.stringify({ packages: { "node_modules/typescript": { version: "5.4.5" } } }));

    const dependency = extract(["package.json", "package-lock.json"]).records[
      "package-dependency"
    ][0]!;
    expect(dependency.versionConstraint).toBe("^5.0.0");
    expect(dependency.resolvedVersion).toBe("5.4.5");
  });

  it("finds the workspace's lockfile from a package nested below it", () => {
    write("packages/app/package.json", JSON.stringify({ dependencies: { react: "^18.0.0" } }));
    write("pnpm-lock.yaml", ["packages:", "  react@18.3.1:", "    resolution: {integrity: sha512-a}"].join("\n"));

    expect(versionOf(["packages/app/package.json", "pnpm-lock.yaml"], "react")).toBe("18.3.1");
  });

  it("states no version when two lockfiles disagree about one", () => {
    // A project holding both yarn.lock and package-lock.json is commoner than
    // it should be, and picking a winner would publish a version the project
    // does not agree with itself about.
    write("package.json", JSON.stringify({ dependencies: { express: "^4.16.0", cors: "^2.8.5" } }));
    write("yarn.lock", ['express@^4.16.0:', '  version "4.16.4"', "", 'cors@^2.8.5:', '  version "2.8.5"'].join("\n"));
    write("package-lock.json", JSON.stringify({
      packages: {
        "node_modules/express": { version: "4.18.2" },
        "node_modules/cors": { version: "2.8.5" },
      },
    }));

    const files = ["package.json", "yarn.lock", "package-lock.json"];
    expect(versionOf(files, "express")).toBeNull();
    // Where they agree there is no disagreement to report.
    expect(versionOf(files, "cors")).toBe("2.8.5");
  });

  it("states no version where the lockfile holds two for one package", () => {
    write("package.json", JSON.stringify({ dependencies: { redux: "^5.0.1" } }));
    write(
      "yarn.lock",
      ['redux@^4.0.0:', '  version "4.2.1"', "", 'redux@^5.0.1:', '  version "5.0.1"'].join("\n"),
    );

    expect(versionOf(["package.json", "yarn.lock"], "redux")).toBeNull();
  });

  it("refuses a version its own manifest rules out", () => {
    // The last check against publishing a false fact: whatever produced this
    // pairing was wrong, and ^5.0.1 cannot be satisfied by 4.2.1.
    write("package.json", JSON.stringify({ dependencies: { redux: "^5.0.1" } }));
    write("yarn.lock", ['redux@^4.0.0:', '  version "4.2.1"'].join("\n"));

    expect(versionOf(["package.json", "yarn.lock"], "redux")).toBeNull();
  });

  it("gives a workspace member its own version, not the root's", () => {
    // The root hoists 4.16.4 for one member; this member needs ^4.18.0 and npm
    // nests its copy. Reading only the top level published 4.16.4 as what the
    // member runs, and the major-only constraint check waved it through.
    write("packages/b/package.json", JSON.stringify({ dependencies: { express: "^4.18.0" } }));
    write(
      "package-lock.json",
      JSON.stringify({
        packages: {
          "node_modules/express": { version: "4.16.4" },
          "packages/b/node_modules/express": { version: "4.18.2" },
        },
      }),
    );

    expect(versionOf(["packages/b/package.json", "package-lock.json"], "express")).toBe("4.18.2");
  });

  it("prefers the manifest's exact pin over a stale lockfile", () => {
    // A go.sum holding one older version answered before go.mod's own pin, and
    // Go majors are nearly always 0 or 1, so the constraint check could not see
    // the difference. No lockfile is more authoritative than a manifest that
    // names the version outright.
    write("go.mod", "module m\n\nrequire golang.org/x/sys v0.15.0\n");
    write("go.sum", "golang.org/x/sys v0.1.0 h1:stale=\n");

    expect(versionOf(["go.mod", "go.sum"], "golang.org/x/sys")).toBe("v0.15.0");
  });

  it("keeps a version a loose constraint admits", () => {
    write("package.json", JSON.stringify({ dependencies: { a: ">=4.0.0", b: "*", c: "^2.1.0" } }));
    write(
      "yarn.lock",
      [
        'a@>=4.0.0:', '  version "5.1.0"', "",
        'b@*:', '  version "9.9.9"', "",
        'c@^2.1.0:', '  version "2.7.0"',
      ].join("\n"),
    );

    const files = ["package.json", "yarn.lock"];
    // `>=4` admits a later major; `*` says nothing; `^2.1.0` fixes the major.
    expect(versionOf(files, "a")).toBe("5.1.0");
    expect(versionOf(files, "b")).toBe("9.9.9");
    expect(versionOf(files, "c")).toBe("2.7.0");
  });

  it("falls back to the manifest's own pin when go.sum is ambiguous", () => {
    write("go.mod", "module m\n\nrequire golang.org/x/sys v0.15.0\n");
    write(
      "go.sum",
      ["golang.org/x/sys v0.1.0 h1:a=", "golang.org/x/sys v0.15.0 h1:b="].join("\n"),
    );

    expect(versionOf(["go.mod", "go.sum"], "golang.org/x/sys")).toBe("v0.15.0");
  });

  it("keeps a Go module's version, which the manifest states exactly", () => {
    write("go.mod", "module example.com/svc\n\ngo 1.21\n\nrequire github.com/gin-gonic/gin v1.9.1\n");

    expect(versionOf(["go.mod"], "github.com/gin-gonic/gin")).toBe("v1.9.1");
    expect(pinnedByManifest("go", "v1.9.1")).toBe("v1.9.1");
    expect(pinnedByManifest("npm", "^5.0.0")).toBeNull();
  });

  it("records the runtime a manifest declares, apart from its packages", () => {
    write("package.json", JSON.stringify({ engines: { node: ">=20" }, dependencies: { react: "18" } }));
    write("go.mod", "module m\n\ngo 1.21\n");

    const platforms = extract(["package.json", "go.mod"]).records["package-dependency"].filter(
      (entry) => entry.scope === "platform",
    );
    expect(platforms.map((entry) => [entry.name, entry.versionConstraint])).toEqual([
      ["node", ">=20"],
      ["go", "1.21"],
    ]);
  });

  it("says an ecosystem's versions are ranges when no lockfile settled any of them", () => {
    write("package.json", JSON.stringify({ dependencies: { react: "^18.0.0" } }));

    const gaps = extract(["package.json"]).gaps;
    expect(gaps.map((gap) => gap.kind)).toContain("package-dependency");
    expect(gaps[0]!.reason).toMatch(/declared ranges rather than installed versions/);
  });

  it("says nothing about ranges when the lockfile did resolve them", () => {
    write("package.json", JSON.stringify({ dependencies: { react: "^18.0.0" } }));
    write("package-lock.json", JSON.stringify({ packages: { "node_modules/react": { version: "18.3.1" } } }));

    expect(extract(["package.json", "package-lock.json"]).gaps).toEqual([]);
  });

  it("keeps every other lockfile's versions when one is malformed", () => {
    write("package.json", JSON.stringify({ dependencies: { react: "^18.0.0" } }));
    write("package-lock.json", "{ not json");
    write("yarn.lock", ['react@^18.0.0:', '  version "18.3.1"'].join("\n"));

    const contribution = extract(["package.json", "package-lock.json", "yarn.lock"]);
    expect(contribution.failures.map((failure) => failure.scope)).toEqual(["package-lock.json"]);
    expect(contribution.records["package-dependency"][0]!.resolvedVersion).toBe("18.3.1");
  });
});
