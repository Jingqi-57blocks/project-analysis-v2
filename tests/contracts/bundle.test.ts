import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  computeLock,
  contractDescriptors,
  contractDigest,
  type ContractLock,
} from "../../engine/contracts/bundle.js";

const lock = JSON.parse(readFileSync("engine/contracts/lock.json", "utf8")) as ContractLock;

describe("M0 contract bundle", () => {
  it("matches the committed lock — no undeclared drift", () => {
    const fresh = computeLock();
    expect(fresh.bundleDigest, "a contract changed without regenerating engine/contracts/lock.json").toBe(
      lock.bundleDigest,
    );
    expect(fresh.contracts).toEqual(lock.contracts);
  });

  it("digests every M0 contract family", () => {
    const ids = contractDescriptors().map((d) => d.id);
    for (const id of ["shared-fact", "report-instructions", "truth-leave", "sentinel-angels-pizza", "targets", "rubric"]) {
      expect(ids, id).toContain(id);
    }
  });

  it("changes a contract's digest when its snapshot changes", () => {
    const first = contractDescriptors()[0]!;
    const mutated = { ...first, snapshot: { ...(first.snapshot as object), _mutated: true } };
    expect(contractDigest(mutated)).not.toBe(contractDigest(first));
  });
});
