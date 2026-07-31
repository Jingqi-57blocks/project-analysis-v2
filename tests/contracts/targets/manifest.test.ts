import { describe, expect, it } from "vitest";

import {
  loadTargetManifest,
  noReaderRoots,
  rootsForGate,
  targetById,
} from "../../../engine/contracts/targets/manifest.js";
import { validateManifest } from "../../../engine/contracts/targets/schema.js";

const manifest = loadTargetManifest();

describe("acceptance-target manifest", () => {
  it("validates structurally", () => {
    const result = validateManifest(manifest);
    expect(result.ok, result.ok ? "" : result.reasons.join("; ")).toBe(true);
  });

  it("pins WCP-V2's git roots by 40-char SHA", () => {
    const wcp = targetById(manifest, "wcp-v2");
    expect(wcp?.vcs).toBe("git");
    expect(wcp?.roots.length).toBe(5);
    for (const root of wcp!.roots) {
      expect(root.revisionKind).toBe("git-sha");
      expect(root.revision, root.name).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(wcp?.noDedicatedReader).toBe(false);
  });

  it("pins angels-pizza's no-VCS roots by 64-char content digest", () => {
    const ap = targetById(manifest, "angels-pizza");
    expect(ap?.vcs).toBe("none");
    for (const root of ap!.roots) {
      expect(root.vcs).toBe("none");
      expect(root.revisionKind).toBe("content-digest");
      expect(root.revision, root.name).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(ap?.noDedicatedReader).toBe(true);
  });

  it("exposes roots no route reader covers, all in angels-pizza", () => {
    const refs = noReaderRoots(manifest);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref.target.id).toBe("angels-pizza");
  });

  it("scopes the M4 golden slice to WCP-V2, and M5 generalization to both", () => {
    const m4 = new Set(rootsForGate(manifest, "M4").map((r) => r.target.id));
    const m5 = new Set(rootsForGate(manifest, "M5").map((r) => r.target.id));
    expect([...m4]).toEqual(["wcp-v2"]);
    expect(m5.has("wcp-v2")).toBe(true);
    expect(m5.has("angels-pizza")).toBe(true);
  });

  it("is deterministic — a reload yields the same targets", () => {
    const again = loadTargetManifest();
    expect(again.targets.map((t) => t.id)).toEqual(manifest.targets.map((t) => t.id));
  });
});
