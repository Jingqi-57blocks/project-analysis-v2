import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createManifestProvider,
  folderContainment,
  manifestCapabilities,
} from "../../engine/providers/manifests/provider.js";
import { isKnownUnreadable, readerFor } from "../../engine/providers/manifests/formats.js";
import { capabilityFor, ANY_LANGUAGE } from "../../engine/structural/provider.js";

let workDir: string;

function write(relPath: string, content: string): void {
  const full = join(workDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function extract(files: readonly string[]) {
  return createManifestProvider().extract({ name: "svc", path: workDir, analyzedFiles: files });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-manifests-"));
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

describe("npm manifests", () => {
  it("reads dependencies with their scopes", () => {
    write(
      "package.json",
      JSON.stringify({
        name: "app",
        dependencies: { vue: "^3.4.0" },
        devDependencies: { vitest: "^4.0.0" },
        peerDependencies: { react: "18" },
      }),
    );

    const deps = extract(["package.json"]).records["package-dependency"];
    expect(deps.map((d) => [d.name, d.scope])).toEqual([
      ["vue", "runtime"],
      ["vitest", "development"],
      ["react", "peer"],
    ]);
  });

  it("keeps the constraint but leaves the resolved version null", () => {
    // A constraint is not a version; resolving needs a lockfile, which is
    // deliberately not read.
    write("package.json", JSON.stringify({ dependencies: { vue: "^3.4.0" } }));

    const dep = extract(["package.json"]).records["package-dependency"][0]!;
    expect(dep.versionConstraint).toBe("^3.4.0");
    expect(dep.resolvedVersion).toBeNull();
  });

  it("records only executables the manifest declares outright", () => {
    write("package.json", JSON.stringify({ name: "app", bin: { mycli: "./cli.js" } }));
    expect(extract(["package.json"]).records["build-target"].map((t) => t.name)).toEqual(["mycli"]);
  });

  it("records no build target for a package declaring none", () => {
    // Treating every package as a target would invent structure the project
    // never stated.
    write("package.json", JSON.stringify({ name: "lib", dependencies: {} }));
    expect(extract(["package.json"]).records["build-target"]).toEqual([]);
  });
});

describe("go manifests", () => {
  it("reads a require block and marks indirect dependencies as transitive", () => {
    write(
      "go.mod",
      `module example.com/svc

go 1.21

require (
	github.com/gin-gonic/gin v1.9.1
	golang.org/x/sys v0.15.0 // indirect
)
`,
    );

    // The `go` directive is the toolchain, recorded with scope `platform`, so
    // the packages are the entries that are not it.
    const deps = extract(["go.mod"]).records["package-dependency"].filter(
      (d) => d.scope !== "platform",
    );
    expect(deps.map((d) => [d.name, d.directness])).toEqual([
      ["github.com/gin-gonic/gin", "direct"],
      ["golang.org/x/sys", "transitive"],
    ]);
  });

  it("reads a single-line require", () => {
    write("go.mod", "module x\n\nrequire github.com/pkg/errors v0.9.1\n");
    expect(extract(["go.mod"]).records["package-dependency"][0]?.name).toBe("github.com/pkg/errors");
  });

  it("ignores comments and the module line", () => {
    write("go.mod", "// a comment\nmodule example.com/x\n\ngo 1.21\n");
    const records = extract(["go.mod"]).records["package-dependency"];
    expect(records.filter((d) => d.scope !== "platform")).toEqual([]);
    expect(records.map((d) => d.name)).toEqual(["go"]);
  });
});

describe("other ecosystems", () => {
  it("reads requirements.txt", () => {
    write("requirements.txt", "# comment\nDjango>=4.2\nrequests\n-r other.txt\n");
    const deps = extract(["requirements.txt"]).records["package-dependency"];
    expect(deps.map((d) => [d.name, d.versionConstraint])).toEqual([
      ["Django", ">=4.2"],
      ["requests", null],
    ]);
  });

  it("reads a Cargo dependency table, including the inline-table form", () => {
    write(
      "Cargo.toml",
      `[package]
name = "app"

[dependencies]
serde = "1.0"
tokio = { version = "1.35", features = ["full"] }

[dev-dependencies]
criterion = "0.5"
`,
    );

    const deps = extract(["Cargo.toml"]).records["package-dependency"];
    expect(deps.map((d) => [d.name, d.versionConstraint, d.scope])).toEqual([
      ["serde", "1.0", "runtime"],
      ["tokio", "1.35", "runtime"],
      ["criterion", "0.5", "development"],
    ]);
  });

  it("reads a PEP 621 dependency array", () => {
    write(
      "pyproject.toml",
      `[project]
name = "app"
dependencies = [
  "fastapi>=0.109",
  "pydantic",
]
`,
    );

    const deps = extract(["pyproject.toml"]).records["package-dependency"];
    expect(deps.map((d) => d.name)).toEqual(["fastapi", "pydantic"]);
  });

  it("reads maven coordinates and leaves property placeholders uninterpolated", () => {
    // A wrong version is worse than a visibly unresolved one.
    write(
      "pom.xml",
      `<project><dependencies>
        <dependency>
          <groupId>org.springframework</groupId>
          <artifactId>spring-core</artifactId>
          <version>\${spring.version}</version>
        </dependency>
      </dependencies></project>`,
    );

    const dep = extract(["pom.xml"]).records["package-dependency"][0]!;
    expect(dep.name).toBe("org.springframework:spring-core");
    expect(dep.versionConstraint).toBe("${spring.version}");
  });
});

describe("formats nobody can read yet", () => {
  it("reports a declared gap rather than a silent zero", () => {
    // A project whose dependencies are unreadable must not look like a project
    // with no dependencies.
    write("build.gradle", "dependencies { implementation 'a:b:1' }");

    const contribution = extract(["build.gradle"]);
    expect(contribution.records["package-dependency"]).toEqual([]);
    expect(contribution.gaps).toEqual([
      {
        kind: "package-dependency",
        language: "gradle",
        reason: "build.gradle declares dependencies but no reader supports this format yet",
      },
    ]);
  });

  it("recognizes a .csproj by extension", () => {
    expect(isKnownUnreadable("App.csproj")).toBe(true);
    expect(isKnownUnreadable("Package.swift")).toBe(true);
    expect(isKnownUnreadable("random.txt")).toBe(false);
  });

  it("reports each unreadable ecosystem once, not once per file", () => {
    write("a/build.gradle", "x");
    write("b/build.gradle", "y");
    expect(extract(["a/build.gradle", "b/build.gradle"]).gaps).toHaveLength(1);
  });
});

describe("malformed manifests", () => {
  it("records a failure without discarding other manifests' dependencies", () => {
    write("bad/package.json", "{ not json");
    write("good/package.json", JSON.stringify({ dependencies: { vue: "3" } }));

    const contribution = extract(["bad/package.json", "good/package.json"]);
    expect(contribution.records["package-dependency"].map((d) => d.name)).toEqual(["vue"]);
    expect(contribution.failures).toHaveLength(1);
    expect(contribution.failures[0]!.scope).toBe("bad/package.json");
  });
});

describe("folder containment", () => {
  it("relates every ancestor, not only leaves to the root", () => {
    const records = folderContainment("svc", ["a/b/c.go"]);
    expect(records.map((r) => [r.containerPath, r.memberPath])).toEqual([
      [".", "a"],
      ["a", "a/b"],
      ["a/b", "a/b/c.go"],
    ]);
  });

  it("does not repeat a shared ancestor", () => {
    const records = folderContainment("svc", ["a/x.go", "a/y.go"]);
    expect(records.filter((r) => r.memberPath === "a")).toHaveLength(1);
  });

  it("is available for a project with no manifest at all", () => {
    // The floor: a project whose build system nothing understands still gets a
    // usable containment graph.
    write("src/main.c", "int main(){}");
    const contribution = extract(["src/main.c"]);

    expect(contribution.records["package-dependency"]).toEqual([]);
    expect(contribution.records["module-containment"].length).toBeGreaterThan(0);
  });
});

describe("declared capabilities", () => {
  it("claims partial support, listing both readable and unreadable formats", () => {
    const declaration = capabilityFor(manifestCapabilities(), "package-dependency", ANY_LANGUAGE);
    expect(declaration?.support).toBe("partial");
    expect(declaration?.limits.join(" ")).toContain("package.json");
    expect(declaration?.limits.join(" ")).toContain("not yet readable");
  });

  it("is available without any external tool", () => {
    expect(createManifestProvider().preflight()).toEqual({ available: true, version: "1.0.0" });
  });

  it("claims a format only when a reader exists for it", () => {
    expect(readerFor("package.json")).not.toBeNull();
    expect(readerFor("build.gradle")).toBeNull();
  });
});
