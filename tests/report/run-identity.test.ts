import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RUN_ID_TIME_ZONE,
  allocateRunDirectory,
  buildManifest,
  displayStamp,
  normalizeLabel,
  runStamp,
  validateManifest,
  writeManifest,
  type TargetRecord,
} from "../../engine/report/run-identity.js";

/** 2026-08-03T06:22:00Z is 14:22 in the fixed zone. */
const INSTANT = new Date("2026-08-03T06:22:00.000Z");

const target: TargetRecord = {
  scope: "project",
  audience: "product",
  module: null,
  specId: "project-product",
  specVersion: "1.0.0",
  directory: "project-overview",
  auditPassed: true,
};

describe("run stamps", () => {
  it("uses UTC+8 with no year, dashes on disk", () => {
    expect(runStamp(INSTANT)).toBe("08-03_14-22");
  });

  it("shows the same moment with a colon for the reader", () => {
    expect(displayStamp(INSTANT)).toBe("08-03 14:22");
  });

  it("does not depend on the machine's zone", () => {
    // The zone is fixed in code; reading the local one would make ids
    // incomparable the moment the work moved machines.
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      expect(runStamp(INSTANT)).toBe("08-03_14-22");
      process.env.TZ = "UTC";
      expect(runStamp(INSTANT)).toBe("08-03_14-22");
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    expect(RUN_ID_TIME_ZONE).toBe("Asia/Shanghai");
  });

  it("folds a label into something safe without losing it", () => {
    expect(normalizeLabel("project product zh-CN")).toBe("project-product-zh-CN");
    expect(normalizeLabel("  ")).toBe("run");
  });
});

describe("run directories", () => {
  it("allocates one directory per run", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const first = allocateRunDirectory(root, "project-product-zh-CN", INSTANT);
    expect(first.runId).toBe("08-03_14-22_project-product-zh-CN");
    expect(existsSync(first.path)).toBe(true);
  });

  it("never writes into an existing run, suffixing instead", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const first = allocateRunDirectory(root, "p", INSTANT);
    const second = allocateRunDirectory(root, "p", INSTANT);
    expect(second.runId).toBe(`${first.runId}-2`);
    expect(second.path).not.toBe(first.path);
  });

  it("steps past a directory someone else created", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    mkdirSync(join(root, "08-03_14-22_p"), { recursive: true });
    expect(allocateRunDirectory(root, "p", INSTANT).runId).toBe("08-03_14-22_p-2");
  });

  it("keeps the earlier run's artefacts", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    const first = allocateRunDirectory(root, "p", INSTANT);
    writeManifest(first.path, buildManifest({
      runId: first.runId, instant: INSTANT, snapshotIdentity: "s", language: "zh-CN",
      modelTier: "sonnet", targets: [target],
    }));
    allocateRunDirectory(root, "p", INSTANT);
    expect(existsSync(join(first.path, "manifest.json"))).toBe(true);
  });
});

describe("manifest", () => {
  const manifest = buildManifest({
    runId: "08-03_14-22_p", instant: INSTANT, snapshotIdentity: "run-1",
    language: "zh-CN", modelTier: "sonnet", targets: [target],
  });

  it("records the local wall clock and the UTC instant for the same moment", () => {
    expect(manifest.startedAtLocal).toBe("08-03 14:22");
    expect(manifest.startedAtUtc).toBe("2026-08-03T06:22:00.000Z");
    expect(manifest.timeZone).toBe("Asia/Shanghai");
  });

  it("validates when every field a comparison needs is present", () => {
    const result = validateManifest(manifest);
    expect(result.ok ? [] : result.reasons).toEqual([]);
  });

  it("refuses a manifest with no model tier", () => {
    const result = validateManifest({ ...manifest, modelTier: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toContain("unattributable");
  });

  it("refuses a local stamp that is not the recorded instant", () => {
    const result = validateManifest({ ...manifest, startedAtLocal: "01-01 00:00" });
    expect(result.ok).toBe(false);
  });

  it("refuses a scoped target that names no module", () => {
    const result = validateManifest({
      ...manifest,
      targets: [{ ...target, scope: "module", module: null }],
    });
    expect(result.ok).toBe(false);
  });

  it("fails the run when any target failed its audit", () => {
    const mixed = buildManifest({
      runId: "r", instant: INSTANT, snapshotIdentity: "s", language: "zh-CN", modelTier: "sonnet",
      targets: [target, { ...target, directory: "module-leave", auditPassed: false }],
    });
    expect(mixed.auditPassed).toBe(false);
  });

  it("leaves the verdict open while a target is unaudited", () => {
    const pending = buildManifest({
      runId: "r", instant: INSTANT, snapshotIdentity: "s", language: "zh-CN", modelTier: "sonnet",
      targets: [{ ...target, auditPassed: null }],
    });
    expect(pending.auditPassed).toBeNull();
  });

  it("writes a manifest that reads back", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"));
    writeManifest(root, manifest);
    expect(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).runId).toBe("08-03_14-22_p");
  });
});
