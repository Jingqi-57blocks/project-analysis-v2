import { describe, expect, it } from "vitest";

import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import type { EvidenceRecord } from "../../engine/contracts/shared-fact/evidence.js";
import { factId } from "../../engine/contracts/shared-fact/identity.js";
import { lineRef } from "../../engine/contracts/shared-fact/provenance.js";
import type { BehaviorFact, BehaviorModel, BehaviorPayload } from "../../engine/contracts/behavior/schema.js";
import { persistBehaviorModel } from "../../engine/kb/behavior-persist.js";
import { queryBehaviorFacts, traverseBehaviorRelations } from "../../engine/kb/behavior-query.js";
import { exportBehaviorModel, recountBehaviorExport } from "../../engine/kb/behavior-export.js";

function ev(root = "svc", path = "a.go", resolution: "resolved" | "unresolved" = "resolved"): EvidenceRecord {
  return {
    attribution: { providerId: "logic", providerVersion: "1.0.0" },
    provenance:
      resolution === "resolved"
        ? { resolutionClass: "resolved", source: lineRef(root, path, 3), confidence: "high" }
        : { resolutionClass: "unresolved", source: lineRef(root, path, 3), unresolvedReason: "dynamic" },
  };
}

function fact(kind: string, disc: string, payload: Partial<BehaviorPayload>, evidence: EvidenceRecord[] = [ev()]): BehaviorFact {
  return {
    factId: factId({ family: "behavioral", kind, discriminators: [disc] }),
    family: "behavioral",
    kind,
    schemaVersion: "1.0.0",
    evidence,
    rawIdentities: [],
    payload: { scope: "symbol", activation: "always", ...payload },
  };
}

const decision = fact("decision", "d1", { scope: "module", activation: "conditional" });
const branch = fact("condition", "c1", { scope: "symbol" });
const stateA = fact("state", "A", { scope: "entity" });
const stateB = fact("state", "B", { scope: "entity" });
const trans = fact("transition", "A->B", { scope: "entity" });
const outbound = fact("outbound-call", "o1", { scope: "cross-root", activation: "always" }, [ev("web", "api.ts", "unresolved")]);
const teleport = fact("teleport", "x", { scope: "symbol" }); // unknown -> quarantined

function model(): BehaviorModel {
  return {
    schemaVersion: "1.0.0",
    facts: [decision, branch, stateA, stateB, trans, outbound, teleport],
    relations: [
      { kind: "decision-branch", from: decision.factId, to: branch.factId, role: "then" },
      { kind: "transition-endpoint", from: trans.factId, to: stateA.factId, role: "from-state" },
      { kind: "transition-endpoint", from: trans.factId, to: stateB.factId, role: "to-state" },
    ],
  };
}

function seeded(): { store: Store; snap: number } {
  const store = openStore(IN_MEMORY, { now: "t" });
  store.run("INSERT INTO workspaces (path, created_at) VALUES ('/w', 't')");
  const ws = store.get<{ id: number }>("SELECT id FROM workspaces WHERE path = '/w'")!;
  store.run("INSERT INTO snapshots (workspace_id, identity, created_at) VALUES (?, 's', 't')", [ws.id]);
  const snap = store.get<{ id: number }>("SELECT id FROM snapshots WHERE identity = 's'")!.id;
  persistBehaviorModel(store, snap, model());
  return { store, snap };
}

describe("queryBehaviorFacts", () => {
  it("queries by fact kind", () => {
    const { store, snap } = seeded();
    const r = queryBehaviorFacts(store, snap, { kind: "state" });
    expect(r.facts.map((f) => f.kind)).toEqual(["state", "state"]);
    expect(r.truncated).toBe(false);
    store.close();
  });

  it("queries by scope, activation and identity", () => {
    const { store, snap } = seeded();
    expect(queryBehaviorFacts(store, snap, { scope: "module" }).facts.map((f) => f.kind)).toEqual(["decision"]);
    expect(queryBehaviorFacts(store, snap, { activation: "conditional" }).facts.map((f) => f.kind)).toEqual(["decision"]);
    expect(queryBehaviorFacts(store, snap, { factId: outbound.factId }).returned).toBe(1);
    store.close();
  });

  it("queries by resolution and repository, derived from evidence", () => {
    const { store, snap } = seeded();
    expect(queryBehaviorFacts(store, snap, { resolution: "unresolved" }).facts.map((f) => f.kind)).toEqual(["outbound-call"]);
    expect(queryBehaviorFacts(store, snap, { rootName: "web" }).facts.map((f) => f.kind)).toEqual(["outbound-call"]);
    store.close();
  });

  it("can exclude quarantined facts", () => {
    const { store, snap } = seeded();
    const all = queryBehaviorFacts(store, snap, {});
    const known = queryBehaviorFacts(store, snap, { includeQuarantined: false });
    expect(all.total - known.total).toBe(1);
    expect(known.facts.some((f) => f.kind === "teleport")).toBe(false);
    store.close();
  });

  it("paginates with a stable order and reports truncation", () => {
    const { store, snap } = seeded();
    const page1 = queryBehaviorFacts(store, snap, {}, { limit: 3, offset: 0 });
    expect(page1.returned).toBe(3);
    expect(page1.truncated).toBe(true);
    expect(page1.total).toBe(7);
    const page3 = queryBehaviorFacts(store, snap, {}, { limit: 3, offset: 6 });
    expect(page3.truncated).toBe(false);
    // two identical queries return the same order
    const a = queryBehaviorFacts(store, snap, {}).facts.map((f) => f.factId);
    const b = queryBehaviorFacts(store, snap, {}).facts.map((f) => f.factId);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
    store.close();
  });

  it("clamps a negative offset instead of slicing from the end", () => {
    const { store, snap } = seeded();
    const clamped = queryBehaviorFacts(store, snap, {}, { offset: -2, limit: 3 });
    const zero = queryBehaviorFacts(store, snap, {}, { offset: 0, limit: 3 });
    expect(clamped.facts.map((f) => f.factId)).toEqual(zero.facts.map((f) => f.factId));
    store.close();
  });
});

describe("traverseBehaviorRelations", () => {
  it("walks forward from a seed within the bounds", () => {
    const { store, snap } = seeded();
    const r = traverseBehaviorRelations(store, snap, [trans.factId], { maxDepth: 5, maxNodes: 100 });
    expect(r.reached).toEqual([stateA.factId, stateB.factId, trans.factId].sort());
    expect(r.edges).toHaveLength(2);
    expect(r.truncated).toBe(false);
    expect(r.affected).toBe(0);
    store.close();
  });

  it("reports truncation and affected count when the node bound is hit", () => {
    const { store, snap } = seeded();
    const r = traverseBehaviorRelations(store, snap, [trans.factId], { maxDepth: 5, maxNodes: 1 });
    expect(r.truncated).toBe(true);
    expect(r.affected).toBeGreaterThan(0);
    store.close();
  });

  it("reports truncation when the depth bound stops an unexpanded frontier", () => {
    const { store, snap } = seeded();
    const r = traverseBehaviorRelations(store, snap, [decision.factId], { maxDepth: 0, maxNodes: 100 });
    expect(r.reached).toEqual([decision.factId]);
    expect(r.truncated).toBe(true);
    expect(r.affected).toBe(1);
    store.close();
  });
});

describe("scale and bounds", () => {
  function bigModel(nFacts: number, chain: number): BehaviorModel {
    const facts: BehaviorFact[] = [];
    for (let i = 0; i < nFacts; i += 1) facts.push(fact("condition", `c${i}`, { scope: "symbol" }));
    // A linear guard chain g0 -> g1 -> ... to exercise bounded traversal.
    const guards: BehaviorFact[] = [];
    for (let i = 0; i < chain; i += 1) guards.push(fact("guard", `g${i}`, { scope: "symbol" }));
    const relations = [];
    for (let i = 0; i < chain - 1; i += 1) {
      relations.push({ kind: "guard-subject" as const, from: guards[i]!.factId, to: guards[i + 1]!.factId, role: "constrains" });
    }
    return { schemaVersion: "1.0.0", facts: [...facts, ...guards], relations };
  }

  it("pages a large fact set with a stable order and honest total", () => {
    const store = openStore(IN_MEMORY, { now: "t" });
    store.run("INSERT INTO workspaces (path, created_at) VALUES ('/w', 't')");
    store.run("INSERT INTO snapshots (workspace_id, identity, created_at) VALUES (1, 's', 't')");
    persistBehaviorModel(store, 1, bigModel(1000, 100));

    const page = queryBehaviorFacts(store, 1, { kind: "condition" }, { limit: 50, offset: 0 });
    expect(page.returned).toBe(50);
    expect(page.total).toBe(1000);
    expect(page.truncated).toBe(true);
    store.close();
  });

  it("caps a long traversal and reports how much it left", () => {
    const store = openStore(IN_MEMORY, { now: "t" });
    store.run("INSERT INTO workspaces (path, created_at) VALUES ('/w', 't')");
    store.run("INSERT INTO snapshots (workspace_id, identity, created_at) VALUES (1, 's', 't')");
    const m = bigModel(0, 100);
    persistBehaviorModel(store, 1, m);

    const seed = m.facts[0]!.factId;
    const r = traverseBehaviorRelations(store, 1, [seed], { maxDepth: 1000, maxNodes: 10 });
    expect(r.truncated).toBe(true);
    expect(r.reached.length).toBeLessThanOrEqual(11);
    expect(r.affected).toBeGreaterThan(0);
    store.close();
  });
});

describe("exportBehaviorModel", () => {
  it("exports facts, relations, evidence, capability and denominator", () => {
    const { store, snap } = seeded();
    const doc = exportBehaviorModel(store, snap);
    expect(doc.version).toBe("1.0");
    expect(doc.facts).toHaveLength(7);
    expect(doc.relations).toHaveLength(3);
    expect(doc.capability.state).toBe(2);
    expect(doc.denominator).toEqual({ facts: 7, relations: 3, quarantined: 1, kinds: 6 });
    // evidence carried through
    const ob = doc.facts.find((f) => f.kind === "outbound-call")!;
    expect(ob.evidence[0]!.resolution).toBe("unresolved");
    expect(ob.evidence[0]!.source).toBe("web/api.ts:3");
    store.close();
  });

  it("has a reproducible digest and a denominator an independent recount confirms", () => {
    const { store, snap } = seeded();
    const a = exportBehaviorModel(store, snap);
    const b = exportBehaviorModel(store, snap);
    expect(a.digest).toBe(b.digest);
    expect(recountBehaviorExport(a)).toEqual(a.denominator);
    store.close();
  });

  it("orders facts and relations stably", () => {
    const { store, snap } = seeded();
    const doc = exportBehaviorModel(store, snap);
    expect(doc.facts.map((f) => f.factId)).toEqual([...doc.facts.map((f) => f.factId)].sort());
    store.close();
  });
});
