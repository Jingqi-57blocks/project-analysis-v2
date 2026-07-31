import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { digestDirectory } from "../../engine/targets/digest.js";
import { resolveTarget } from "../support/targets/resolve.js";
import { walkRoot } from "../../engine/inventory/walk.js";
import { announceSkip } from "../support/targets.js";

/**
 * Verifies the classification design against the exact findings that shaped
 * it: a `build/` directory that is not build output, a real migrations
 * directory, and a real generated-file marker. These are concrete cases a
 * synthetic fixture would not have surfaced.
 */

const wcpV2 = resolveTarget("wcp-v2");
if (!wcpV2.ok) announceSkip("inventory on wcp-v2 roots", wcpV2.unavailable.reason);

describe.skipIf(!wcpV2.ok)("inventory on wcp-auth", () => {
  it("walks build/ rather than bulk-excluding it, and finds the real Dockerfile", () => {
    if (!wcpV2.ok) return;
    const authRoot = wcpV2.target.roots.find((r) => r.name === "wcp-auth");
    expect(authRoot?.present, "wcp-auth not present").toBe(true);

    const result = walkRoot(authRoot!.path);

    const buildExcluded = result.excluded.find((e) => e.relPath === "build");
    expect(buildExcluded, "build/ must not be bulk-excluded — it holds a real Dockerfile").toBeUndefined();

    const dockerfile = result.analyzed.find((f) => f.relPath === join("build", "Dockerfile"));
    expect(dockerfile).toBeDefined();
    expect(dockerfile?.classification).toBe("configuration");
  });

  it("classifies docs/docs.go as generated, using the marker confirmed in its real content", () => {
    if (!wcpV2.ok) return;
    const authRoot = wcpV2.target.roots.find((r) => r.name === "wcp-auth")!;
    const result = walkRoot(authRoot.path);

    const docsGo = result.analyzed.find((f) => f.relPath === join("docs", "docs.go"));
    expect(docsGo?.classification).toBe("generated");
  });

  it("gives every file exactly one disposition — accounting holds on a real root", () => {
    if (!wcpV2.ok) return;
    const authRoot = wcpV2.target.roots.find((r) => r.name === "wcp-auth")!;
    const result = walkRoot(authRoot.path);

    const discovered = result.analyzed.length + result.excluded.length + result.failed.length;
    expect(discovered).toBeGreaterThan(30); // the reference catalog counted 37 .go files alone
    expect(result.failed).toEqual([]); // a clean checkout should have nothing unreadable
  });

  it("leaves wcp-auth unchanged after walking it", () => {
    if (!wcpV2.ok) return;
    const authRoot = wcpV2.target.roots.find((r) => r.name === "wcp-auth")!;

    const before = digestDirectory(authRoot.path);
    walkRoot(authRoot.path);
    expect(digestDirectory(authRoot.path)).toBe(before);
  });
});

describe.skipIf(!wcpV2.ok)("inventory on wcp-service", () => {
  it("classifies files under migrations/ as schema-migration", () => {
    if (!wcpV2.ok) return;
    const svcRoot = wcpV2.target.roots.find((r) => r.name === "wcp-service");
    expect(svcRoot?.present, "wcp-service not present").toBe(true);

    const result = walkRoot(svcRoot!.path);
    const migrationFiles = result.analyzed.filter((f) => f.relPath.split(sep).includes("migrations"));

    expect(migrationFiles.length).toBeGreaterThan(0);
    expect(migrationFiles.every((f) => f.classification === "schema-migration")).toBe(true);
  });
});
