import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { announceSkip, targetAvailability } from "../support/targets.js";

interface RouteReference {
  readonly target: string;
  readonly root: string;
  readonly pin: { readonly kind: string; readonly commit: string };
  readonly routes: readonly { method: string; path: string; handler: string | null }[];
}

const reference = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../references/wcp-auth/routes.json"), "utf8"),
) as RouteReference;

describe("wcp-auth route reference", () => {
  it("has no duplicate method+path pairs", () => {
    const keys = reference.routes.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every route a method and a path", () => {
    for (const route of reference.routes) {
      expect(route.method, JSON.stringify(route)).toMatch(/^[A-Z]+$/);
      expect(route.path, JSON.stringify(route)).toMatch(/^\//);
    }
  });

  it("names a handler for every route except the one inline closure", () => {
    const anonymous = reference.routes.filter((r) => r.handler === null);
    expect(anonymous.map((r) => r.path)).toEqual(["/health"]);
  });
});

const { available, target, reason } = targetAvailability(reference.target);
if (!available) announceSkip("wcp-auth route reference drift", reason);

describe.skipIf(!available)("wcp-auth route reference drift", () => {
  /**
   * The reference was verified by reading the source at a specific commit. If
   * the working tree has moved, the hand-verified facts may no longer hold —
   * better to fail loudly here than to grade a later stage against stale truth.
   */
  it("is pinned to the commit currently checked out", () => {
    const root = target!.roots.find((r) => r.name === reference.root);
    expect(root?.present, `${reference.root} missing from ${target!.path}`).toBe(true);

    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root!.path,
      encoding: "utf8",
    }).trim();

    expect(
      head,
      `${reference.root} has moved to ${head}. Re-verify references/wcp-auth/routes.json ` +
        "by reading the source, then update the pin.",
    ).toBe(reference.pin.commit);
  });
});
