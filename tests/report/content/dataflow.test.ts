import { describe, expect, it } from "vitest";

import { lineRef, type SourceRef } from "../../../engine/contracts/shared-fact/provenance.js";
import { SECTION_CATALOG } from "../../../engine/contracts/report/catalog.js";
import {
  CONTROL_NOTES_BLOCK,
  DATAFLOW_SCHEMA_BLOCKS,
  DEV_DATAFLOW_AUTHORED_BLOCKS,
  MODULE_ERROR_NOTES_BLOCK,
  type ControlRecord,
  type DataAccessRecord,
  type EntityRecord,
  type EntityRelationRecord,
  type ExternalInteractionRecord,
  renderControlBoundaries,
  renderDataModel,
  renderExternalInteractions,
  validateControls,
  validateDataModel,
  validateInteractions,
} from "../../../engine/report/content/dataflow.js";

const ROOT = "wcp-service-v2";
const cite = (path: string, line = 1): SourceRef => lineRef(ROOT, path, line);

const entities: EntityRecord[] = [
  { id: "e:leaves", name: "leaves", datastore: "postgres", citation: cite("internal/leave/model.go", 1) },
  { id: "e:users", name: "users", datastore: "postgres", citation: cite("internal/user/model.go", 1) },
];
const relations: EntityRelationRecord[] = [
  { id: "r:leave-user", fromEntity: "e:leaves", toEntity: "e:users", kind: "belongs-to", citation: cite("internal/leave/model.go", 5) },
];
const accesses: DataAccessRecord[] = [
  { id: "a:1", entity: "e:leaves", operation: "write", mechanism: "gorm", transactional: true, triggeredBy: "s:Approve", citation: cite("svc/repo.go", 30) },
  { id: "a:2", entity: "e:leaves", operation: "read", mechanism: "gorm", transactional: false, triggeredBy: "s:List", citation: cite("svc/repo.go", 10) },
  { id: "a:3", entity: "e:users", operation: "unknown", mechanism: "raw-sql", transactional: false, triggeredBy: null, citation: cite("svc/repo.go", 40) },
];

describe("renderDataModel — read/write/unknown never swapped", () => {
  it("counts operations distinctly and preserves each verbatim", () => {
    const m = renderDataModel(entities, relations, accesses);
    expect(m.counts).toEqual({ read: 1, write: 1, unknown: 1 });
    // the write stays a write, the read stays a read
    expect(m.accesses.find((a) => a.id === "a:1")!.operation).toBe("write");
    expect(m.accesses.find((a) => a.id === "a:2")!.operation).toBe("read");
    expect(m.transactionalAccesses).toBe(1);
    expect(m.datastores).toEqual(["postgres"]);
    expect(validateDataModel(m, accesses)).toEqual({ ok: true });
  });
});

const interactions: ExternalInteractionRecord[] = [
  { id: "i:1", kind: "http", target: "payments-api", operation: "POST /charge", resolution: "resolved", activation: "reachable", triggeredBy: "s:Pay", citation: cite("svc/pay.go", 5) },
  { id: "i:2", kind: "http", target: "config:webhookUrl", operation: "POST", resolution: "heuristic", activation: "declared-config", triggeredBy: null, citation: cite("config.yaml", 3) },
  { id: "i:3", kind: "notification", target: "", operation: "send", resolution: "unresolved", activation: "unconfirmed", triggeredBy: "s:Notify", citation: cite("svc/notify.go", 9) },
];

describe("renderExternalInteractions — config dependency vs reachable call", () => {
  it("counts by kind, resolution and activation, keeping declared-config distinct from reachable", () => {
    const set = renderExternalInteractions(interactions);
    expect(set.total).toBe(3);
    expect(set.byKind.http).toBe(2);
    expect(set.byActivation).toEqual({ "declared-config": 1, reachable: 1, unconfirmed: 1 });
    expect(set.byResolution).toEqual({ resolved: 1, heuristic: 1, unresolved: 1 });
    expect(validateInteractions(set)).toEqual({ ok: true });
  });

  it("rejects an unresolved interaction with no target or trigger", () => {
    const orphan: ExternalInteractionRecord = { id: "i:x", kind: "http", target: "", operation: "GET", resolution: "unresolved", activation: "unconfirmed", triggeredBy: null, citation: cite("x.go", 1) };
    expect(validateInteractions(renderExternalInteractions([orphan])).ok).toBe(false);
  });
});

const controls: ControlRecord[] = [
  { id: "c:1", kind: "authentication", subject: "session", requirement: "logged-in", guardedBranch: null, discarded: false, citation: cite("svc/mw.go", 1) },
  { id: "c:2", kind: "authorization", subject: "Approve", requirement: "manager", guardedBranch: "reject", discarded: false, citation: cite("svc/mw.go", 5) },
  { id: "c:3", kind: "exception-handling", subject: "notify", requirement: null, guardedBranch: null, discarded: true, citation: cite("svc/notify.go", 12) },
];

describe("renderControlBoundaries — auth, validation, exceptions and discarded errors", () => {
  it("counts by kind and surfaces discarded errors, keeping authn distinct from authz", () => {
    const set = renderControlBoundaries(controls);
    expect(set.byKind).toEqual({ authentication: 1, authorization: 1, validation: 0, "exception-handling": 1 });
    expect(set.discardedErrors).toBe(1); // the swallowed error is surfaced, not hidden
    expect(validateControls(set)).toEqual({ ok: true });
  });
});

describe("blocks agree with the section catalog", () => {
  const catalogBlocks = new Map(SECTION_CATALOG.flatMap((s) => s.blocks).map((b) => [b.id, b.outputSchemaId]));

  it("every authored block matches its catalog block", () => {
    for (const block of DEV_DATAFLOW_AUTHORED_BLOCKS) {
      expect(catalogBlocks.get(block.blockId)).toBe(block.outputSchemaId);
      expect(block.citationRule).toBe("required");
    }
    expect(CONTROL_NOTES_BLOCK.blockId).toBe("project-control-boundaries.notes");
    expect(MODULE_ERROR_NOTES_BLOCK.blockId).toBe("module-data-control-errors.notes");
  });

  it("every deterministic renderer schema matches its catalog block", () => {
    for (const { blockId, outputSchemaId } of DATAFLOW_SCHEMA_BLOCKS) {
      expect(catalogBlocks.get(blockId), blockId).toBe(outputSchemaId);
    }
  });
});
