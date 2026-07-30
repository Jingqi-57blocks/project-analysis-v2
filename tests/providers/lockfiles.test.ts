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

function read(filename: string, content: string): ReadonlyMap<string, string> {
  return lockfileReaderFor(filename)!.read(content);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-lockfiles-"));
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

describe("reading an exact version out of a lockfile", () => {
  it("reads npm's install tree, taking the name after the last node_modules", () => {
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
    expect(versions.get("b")).toBe("0.3.0");
  });

  it("reads a version-1 npm lockfile, which has no packages section", () => {
    const versions = read(
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: { express: { version: "4.16.4", dependencies: { debug: { version: "2.6.9" } } } },
      }),
    );
    expect(versions.get("express")).toBe("4.16.4");
    expect(versions.get("debug")).toBe("2.6.9");
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
