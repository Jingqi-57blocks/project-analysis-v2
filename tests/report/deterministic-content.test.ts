import { describe, expect, it } from "vitest";

import { moduleScope, type Scope } from "../../engine/contracts/report/target.js";
import { SECTION_CATALOG } from "../../engine/contracts/report/catalog.js";
import type { SectionApplicabilityDecision } from "../../engine/report/applicability.js";
import type { AssembledBlock } from "../../engine/report/assemble.js";
import { type DecisionIndex, deterministicContent } from "../../engine/report/deterministic-content.js";
import { createSliceReaders } from "../../engine/report/slice-resolve.js";
import { SNAPSHOT_ID, insertBehaviorFact, membershipOf, seedStore } from "./helpers/seed-resolver-kb.js";

const IN_MODULE = ["handlers/leave/service.go"];
const DOC = "module:leave|product";

/** A full AssembledBlock for a real catalog block, with the fields the renderer ignores stubbed. */
function assembledBlock(blockId: string, scope: Scope): AssembledBlock {
  const block = SECTION_CATALOG.flatMap((s) => s.blocks).find((b) => b.id === blockId)!;
  return {
    blockId,
    kind: block.kind,
    outputSchemaId: block.outputSchemaId,
    carriesSharedClaim: block.carriesSharedClaim,
    taskId: block.kind === "authored-required" ? `task:${blockId}` : null,
    sliceScope: scope,
    sliceKey: "k",
    sliceDigest: "d",
    validated: true,
    artifactRef: null,
  };
}

function decisionFor(sectionId: string, applicability: SectionApplicabilityDecision["applicability"], reason: string): DecisionIndex {
  const decision: SectionApplicabilityDecision = { sectionId, applicability, state: applicability === "unknown" ? "unknown" : "found", reason, evidence: [] };
  return new Map([[DOC, new Map([[sectionId, decision]])]]);
}

describe("deterministicContent — cited-fact digest, or a structured reason when empty", () => {
  it("renders a cited bullet per fact: `- [factId] «value» (kind) — root/relPath:line`", () => {
    const store = seedStore();
    insertBehaviorFact(store, { factId: "behavioral|data-access|r1|handlers/leave/service.go:42|d1", kind: "data-access", relPath: "handlers/leave/service.go", startLine: 42, payload: { scope: "module", activation: "always", table: "wcp_leave" } });
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const content = deterministicContent({ readers, decisions: new Map() });

    // module-notifications-data.effects reads [outbound-call, notification-call, data-access].
    const text = content(DOC, assembledBlock("module-notifications-data.effects", moduleScope("leave")));
    expect(text).toContain("deterministic fact digest: 1 cited fact for module:leave");
    expect(text).toContain("- [behavioral|data-access|r1|handlers/leave/service.go:42|d1]");
    expect(text).toContain("(data-access)");
    expect(text).toContain("— r1/handlers/leave/service.go:42");
    expect(text).toContain('"table":"wcp_leave"');
  });

  it("renders the section's structured reason when the block's slice resolves nothing", () => {
    const store = seedStore(); // no facts at all
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const decisions = decisionFor("module-responsibility", "unknown", "capability, resolution or evidence is insufficient to establish module");
    const content = deterministicContent({ readers, decisions });

    // module-responsibility.summary is authored and reads ["module"], which this resolver cannot read.
    const text = content(DOC, assembledBlock("module-responsibility.summary", moduleScope("leave")));
    expect(text).toContain("resolved no cited facts for module:leave");
    expect(text).toContain("structured unknown:");
    // An authored block is labelled as a digest whose prose is deferred — never a plain blank.
    expect(text).toContain("prose deferred to the LLM authoring phase");
  });

  it("labels a deterministic block a fact digest, without the deferred-prose note", () => {
    const store = seedStore();
    insertBehaviorFact(store, { factId: "behavioral|data-access|r1|handlers/leave/service.go:7|d2", kind: "data-access", relPath: "handlers/leave/service.go", startLine: 7 });
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const content = deterministicContent({ readers, decisions: new Map() });
    const text = content(DOC, assembledBlock("module-notifications-data.effects", moduleScope("leave")));
    expect(text).toContain("deterministic fact digest");
    expect(text).not.toContain("prose deferred to the LLM authoring phase");
  });

  it("is deterministic — the same block renders byte-identical text twice", () => {
    const store = seedStore();
    for (let i = 0; i < 3; i += 1) {
      insertBehaviorFact(store, { factId: `behavioral|data-access|r1|handlers/leave/service.go:${i}|d${i}`, kind: "data-access", relPath: "handlers/leave/service.go", startLine: i });
    }
    const readers = createSliceReaders(store, SNAPSHOT_ID, membershipOf("leave", IN_MODULE));
    const content = deterministicContent({ readers, decisions: new Map() });
    const block = assembledBlock("module-notifications-data.effects", moduleScope("leave"));
    expect(content(DOC, block)).toEqual(content(DOC, block));
  });
});
