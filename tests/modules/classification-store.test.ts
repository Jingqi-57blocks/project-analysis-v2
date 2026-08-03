import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ModuleClassificationArtifact } from "../../engine/contracts/module-classification/schema.js";
import {
  MODULE_CLASSIFICATION_FILENAME,
  classificationArtifactPath,
  readClassificationArtifact,
  writeClassificationArtifact,
} from "../../engine/modules/classification-store.js";

const roots: string[] = [];
function freshRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi79-run-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  // best-effort; the OS temp dir is reclaimed regardless
});

const artifact: ModuleClassificationArtifact = {
  schemaVersion: "module-classification.v2",
  sourceSnapshotId: "snap-1",
  candidateSetDigest: "abc",
  classifier: { executor: "agent", model: "m", contractVersion: "v1" },
  candidates: [
    { candidateId: "a", classification: "product-module", confidence: 0.9, reason: "r", evidenceRefs: ["fact:module:a"], status: "classified" },
  ],
};

describe("classification store", () => {
  it("writes exactly one artifact into the given run dir and reads it back", () => {
    const runDir = freshRunDir();
    const path = writeClassificationArtifact(runDir, artifact);
    expect(path).toBe(join(runDir, MODULE_CLASSIFICATION_FILENAME));
    expect(readdirSync(runDir)).toEqual([MODULE_CLASSIFICATION_FILENAME]);
    expect(readClassificationArtifact(runDir)).toEqual(artifact);
  });

  it("leaves no temp file behind after an atomic write", () => {
    const runDir = freshRunDir();
    writeClassificationArtifact(runDir, artifact);
    expect(readdirSync(runDir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("returns null when no artifact is present", () => {
    expect(readClassificationArtifact(freshRunDir())).toBeNull();
  });

  it("returns null for a wrong schema version rather than reusing it", () => {
    const runDir = freshRunDir();
    writeFileSync(classificationArtifactPath(runDir), JSON.stringify({ ...artifact, schemaVersion: "module-classification.v0" }));
    expect(readClassificationArtifact(runDir)).toBeNull();
  });

  it("returns null for malformed JSON rather than throwing", () => {
    const runDir = freshRunDir();
    writeFileSync(classificationArtifactPath(runDir), "{ not json");
    expect(readClassificationArtifact(runDir)).toBeNull();
  });

  it("writes only inside the run dir, never a sibling (no analyzed-repo leakage)", () => {
    const parent = freshRunDir();
    const runDir = join(parent, "run");
    writeClassificationArtifact(runDir, artifact);
    // The parent contains only the run dir we created; the artifact is inside it.
    expect(readdirSync(parent)).toEqual(["run"]);
    expect(existsSync(join(runDir, MODULE_CLASSIFICATION_FILENAME))).toBe(true);
  });
});
