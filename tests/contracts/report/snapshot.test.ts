import { describe, expect, it } from "vitest";

import {
  type AnalysisSnapshotIdentity,
  canReuseSnapshot,
} from "../../../engine/contracts/report/snapshot.js";

const base: AnalysisSnapshotIdentity = {
  sourceIdentity: "s1",
  codeGraphIdentity: "g1",
  providerIdentity: "p1",
  schemaVersion: "1.0.0",
  configIdentity: "c1",
};

describe("canReuseSnapshot", () => {
  it("reuses when every identity input matches — so one analysis serves many documents", () => {
    expect(canReuseSnapshot(base, { ...base })).toBe(true);
  });

  it("invalidates reuse when any single identity input differs", () => {
    for (const key of Object.keys(base) as (keyof AnalysisSnapshotIdentity)[]) {
      expect(canReuseSnapshot(base, { ...base, [key]: "changed" }), key).toBe(false);
    }
  });
});
