import { describe, expect, it } from "vitest";

import type { FactEnvelope } from "../../../engine/contracts/shared-fact/envelope.js";
import { factId } from "../../../engine/contracts/shared-fact/identity.js";
import { mergeFacts } from "../../../engine/contracts/shared-fact/merge.js";
import { declared, inferred, lineRef, resolved } from "../../../engine/contracts/shared-fact/provenance.js";
import { SHARED_FACT_CONTRACT_VERSION } from "../../../engine/contracts/shared-fact/version.js";

const entityA = factId({ family: "structural", kind: "entity", discriminators: ["api", "leaves"] });
const entityB = factId({ family: "structural", kind: "entity", discriminators: ["api", "users"] });

type Cls = "declared" | "resolved" | "inferred";

function env(id: typeof entityA, payload: unknown, provider: string, cls: Cls): FactEnvelope {
  const src = lineRef("api", "model.go", 1);
  const provenance =
    cls === "declared" ? declared(src) : cls === "resolved" ? resolved(src, "high") : inferred(src, "medium");
  return {
    factId: id,
    family: "structural",
    kind: "entity",
    schemaVersion: SHARED_FACT_CONTRACT_VERSION,
    evidence: [{ attribution: { providerId: provider, providerVersion: "1.0.0" }, provenance }],
    rawIdentities: [{ providerId: provider, nativeId: `${provider}:1` }],
    payload,
  };
}

describe("mergeFacts", () => {
  it("is a pure function of the input set — order does not change the result", () => {
    const input: FactEnvelope[] = [
      env(entityA, { table: "leaves", columns: 7 }, "codegraph", "resolved"),
      env(entityA, { table: "leaves", columns: 8 }, "sql", "inferred"),
      env(entityB, { table: "users", columns: 3 }, "sql", "declared"),
      env(entityA, { table: "leaves", columns: 7 }, "gostructs", "declared"),
    ];
    const forward = mergeFacts(input);
    const reversed = mergeFacts([...input].reverse());
    const rotated = mergeFacts([input[2]!, input[0]!, input[3]!, input[1]!]);
    expect(reversed).toEqual(forward);
    expect(rotated).toEqual(forward);
  });

  it("merges identical facts from two providers into one, with both attributions", () => {
    const merged = mergeFacts([
      env(entityA, { table: "leaves" }, "codegraph", "resolved"),
      env(entityA, { table: "leaves" }, "sql", "resolved"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.envelope.evidence.map((e) => e.attribution.providerId).sort()).toEqual([
      "codegraph",
      "sql",
    ]);
    expect(merged[0]!.conflicts).toEqual([]);
  });

  it("keeps a value by evidence directness, never by provider, and retains the loser", () => {
    // Provider "zzz" declares columns:7; provider "aaa" infers columns:8.
    // Declared beats inferred regardless of provider name ordering.
    const merged = mergeFacts([
      env(entityA, { columns: 8 }, "aaa", "inferred"),
      env(entityA, { columns: 7 }, "zzz", "declared"),
    ]);
    expect(merged).toHaveLength(1);
    expect((merged[0]!.envelope.payload as { columns: number }).columns).toBe(7);
    expect(merged[0]!.precedenceReason).toContain("declared");
    const conflict = merged[0]!.conflicts.find((c) => c.field === "columns");
    expect(conflict?.values.map((v) => v.value).sort()).toEqual(["7", "8"]);
  });

  it("at equal directness keeps the canonical-order value and retains the other, not silently", () => {
    const merged = mergeFacts([
      env(entityA, { name: "b" }, "p1", "resolved"),
      env(entityA, { name: "a" }, "p2", "resolved"),
    ]);
    expect(merged[0]!.precedenceReason).toContain("equal directness");
    // "a" sorts before "b" in the canonical value order.
    expect((merged[0]!.envelope.payload as { name: string }).name).toBe("a");
    expect(merged[0]!.conflicts.find((c) => c.field === "name")?.values).toHaveLength(2);
  });
});
