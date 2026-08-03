import { describe, expect, it } from "vitest";

import {
  canonicalFileId,
  canonicalSymbolId,
  type CanonicalSymbolParts,
  detectCollisions,
} from "../../../engine/contracts/shared-fact/canonical.js";
import { canonicalEntityId, type EntityRef } from "../../../engine/contracts/shared-fact/entity-identity.js";
import type { FactId } from "../../../engine/contracts/shared-fact/identity.js";
import {
  canonicalModuleId,
  type ModuleRegistry,
  resolveModule,
} from "../../../engine/contracts/shared-fact/module-identity.js";
import {
  identityDrift,
  identityStable,
  sameIdentitySet,
} from "../../../engine/contracts/shared-fact/stability.js";
import { SHARED_FACT_CONTRACT_VERSION } from "../../../engine/contracts/shared-fact/version.js";

const sym: CanonicalSymbolParts = {
  repo: "api",
  path: "leave/service.go",
  kind: "function",
  qualifiedName: "Service.Approve",
  signature: "func()",
  scopePath: null,
};
const entity: EntityRef = { repo: "api", schema: null, name: "wcp_leave" };

const builders: readonly (() => FactId)[] = [
  () => canonicalFileId("api", "leave/service.go"),
  () => canonicalSymbolId(sym),
  () => canonicalModuleId("api", "leave"),
  () => canonicalEntityId(entity),
];

function identitiesFrom(order: readonly number[]): FactId[] {
  return order.map((i) => builders[i]!());
}

describe("identity stability across runs and batches", () => {
  it("produces the same identity set regardless of order — no drift", () => {
    const runA = identitiesFrom([0, 1, 2, 3]);
    const runB = identitiesFrom([3, 2, 1, 0]);
    const runC = identitiesFrom([2, 0, 3, 1]);
    expect(sameIdentitySet(runA, runB)).toBe(true);
    expect(identityDrift([runA, runB, runC])).toEqual([]);
    expect(identityStable([runA, runB, runC])).toBe(true);
  });

  it("detects drift when a run is missing an identity", () => {
    const full = identitiesFrom([0, 1, 2, 3]);
    const partial = identitiesFrom([0, 1, 2]);
    expect(identityStable([full, partial])).toBe(false);
    expect(identityDrift([full, partial])).toContain(canonicalEntityId(entity));
  });

  it("keeps identity stable across a contract version bump", () => {
    const id = canonicalSymbolId(sym);
    expect(id).not.toContain(SHARED_FACT_CONTRACT_VERSION);
    expect(canonicalSymbolId(sym)).toBe(id);
  });

  it("flags a genuine collision", () => {
    const id = canonicalSymbolId(sym);
    expect(detectCollisions([{ id, distinct: "A" }, { id, distinct: "B" }])).toHaveLength(1);
  });

  it("migrates an old module id to the current one without drift", () => {
    const oldId = canonicalModuleId("api", "leave");
    const newId = canonicalModuleId("api", "leave-v2");
    const reg: ModuleRegistry = {
      modules: [newId],
      lineage: [{ from: oldId, to: [newId], relation: "supersede", reason: "renamed" }],
    };
    const r = resolveModule(oldId, reg);
    expect(r.kind).toBe("aliased");
    if (r.kind === "aliased") expect(r.id).toBe(newId);
  });
});
