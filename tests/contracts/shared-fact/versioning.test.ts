import { describe, expect, it } from "vitest";

import type { FactEnvelope } from "../../../engine/contracts/shared-fact/envelope.js";
import { factId } from "../../../engine/contracts/shared-fact/identity.js";
import { declared, lineRef } from "../../../engine/contracts/shared-fact/provenance.js";
import { stableStringify } from "../../../engine/contracts/shared-fact/merge.js";
import {
  applyMigrations,
  compareSemver,
  isCompatible,
  isKnownKind,
  type Migration,
  MigrationError,
  parseSemver,
} from "../../../engine/contracts/shared-fact/versioning.js";

function envelope(version: string, kind: string, payload: unknown): FactEnvelope {
  return {
    factId: factId({ family: "structural", kind, discriminators: ["api", "x"] }),
    family: "structural",
    kind,
    schemaVersion: version,
    evidence: [
      {
        attribution: { providerId: "p", providerVersion: "1.0.0" },
        provenance: declared(lineRef("api", "x.go", 1)),
      },
    ],
    rawIdentities: [],
    payload,
  };
}

describe("semver", () => {
  it("parses and rejects", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(() => parseSemver("1.2")).toThrow();
  });

  it("orders versions", () => {
    expect(compareSemver("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.2.0", "1.2.0")).toBe(0);
  });

  it("is compatible within a major when the reader is at least as new in minor", () => {
    expect(isCompatible("1.2.0", "1.1.0")).toBe(true);
    expect(isCompatible("1.1.0", "1.2.0")).toBe(false);
    expect(isCompatible("2.0.0", "1.9.9")).toBe(false);
  });
});

describe("applyMigrations", () => {
  it("carries a fact across versions, preserving factId and provenance", () => {
    const start = envelope("1.0.0", "entity", { table: "leaves", legacy: true });
    const migration: Migration = {
      from: "1.0.0",
      to: "2.0.0",
      migrate: (e) => ({ ...e, schemaVersion: "2.0.0", payload: { table: "leaves" } }),
    };
    const result = applyMigrations(start, "2.0.0", [migration]);
    expect(result.schemaVersion).toBe("2.0.0");
    expect(result.factId).toBe(start.factId);
    expect(result.evidence).toEqual(start.evidence);
    expect(result.payload).toEqual({ table: "leaves" });
  });

  it("refuses a migration that changes the fact identity", () => {
    const start = envelope("1.0.0", "entity", {});
    const bad: Migration = {
      from: "1.0.0",
      to: "2.0.0",
      migrate: (e) => ({ ...e, schemaVersion: "2.0.0", factId: factId({ family: "structural", kind: "entity", discriminators: ["other"] }) }),
    };
    expect(() => applyMigrations(start, "2.0.0", [bad])).toThrow(MigrationError);
  });

  it("refuses a migration that alters the provenance chain", () => {
    const start = envelope("1.0.0", "entity", {});
    const bad: Migration = {
      from: "1.0.0",
      to: "2.0.0",
      migrate: (e) => ({ ...e, schemaVersion: "2.0.0", evidence: [] }),
    };
    expect(() => applyMigrations(start, "2.0.0", [bad])).toThrow(MigrationError);
  });

  it("fails closed when no migration path exists", () => {
    const start = envelope("1.0.0", "entity", {});
    expect(() => applyMigrations(start, "2.0.0", [])).toThrow(MigrationError);
  });
});

describe("unknown kinds", () => {
  it("round-trip an unknown kind unchanged", () => {
    const exotic = envelope("1.0.0", "quantum-edge", { spin: "up" });
    const roundTripped = JSON.parse(stableStringify(exotic)) as FactEnvelope;
    expect(roundTripped.kind).toBe("quantum-edge");
    expect(roundTripped.payload).toEqual({ spin: "up" });
  });

  it("recognizes known kinds and admits unknown ones as gaps", () => {
    const known = new Set(["entity", "symbol", "route"]);
    expect(isKnownKind("entity", known)).toBe(true);
    expect(isKnownKind("quantum-edge", known)).toBe(false);
  });
});
