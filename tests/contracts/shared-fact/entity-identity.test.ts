import { describe, expect, it } from "vitest";

import {
  alignEndpoint,
  canonicalEntityId,
  canonicalRelation,
  type EntityRef,
  indexEntitiesByName,
} from "../../../engine/contracts/shared-fact/entity-identity.js";

const leaves: EntityRef = { repo: "api", schema: null, name: "wcp_leave" };
const leavesPublic: EntityRef = { repo: "api", schema: "public", name: "wcp_leave" };
const users: EntityRef = { repo: "api", schema: null, name: "users" };

describe("canonicalEntityId", () => {
  it("converges providers on one id for the same entity", () => {
    expect(canonicalEntityId(leaves)).toBe(canonicalEntityId({ repo: "api", schema: null, name: " wcp_leave " }));
  });

  it("separates by schema and by repo", () => {
    expect(canonicalEntityId(leaves)).not.toBe(canonicalEntityId(leavesPublic));
    expect(canonicalEntityId(leaves)).not.toBe(canonicalEntityId({ ...leaves, repo: "web" }));
  });
});

describe("alignEndpoint", () => {
  const byName = indexEntitiesByName([leaves, users]);

  it("resolves a unique name exactly", () => {
    expect(alignEndpoint("users", byName)).toEqual({ kind: "exact", id: canonicalEntityId(users) });
  });

  it("is unresolved for an unknown name", () => {
    expect(alignEndpoint("ghost", byName).kind).toBe("unresolved");
  });

  it("returns candidates for an ambiguous name across schemas, not a guess", () => {
    const ambiguous = indexEntitiesByName([leaves, leavesPublic]);
    const r = alignEndpoint("wcp_leave", ambiguous);
    expect(r.kind).toBe("candidate");
    if (r.kind === "candidate") expect(r.ids).toHaveLength(2);
  });
});

describe("canonicalRelation", () => {
  it("resolves both endpoints to canonical entity ids", () => {
    const rel = canonicalRelation(leaves, users);
    expect(rel.from).toBe(canonicalEntityId(leaves));
    expect(rel.to).toBe(canonicalEntityId(users));
  });
});
