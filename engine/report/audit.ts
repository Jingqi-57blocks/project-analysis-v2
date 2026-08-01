/**
 * The cross-document consistency audit (PI-18).
 *
 * Two documents built from one knowledge base can still drift: a shared claim can be
 * rewritten, a claim can escape its slice, an authored block's prose can bleed from
 * one audience into another, or a required block can go missing. This audits the
 * assembled report for those, machine-readably and fail-closed — a finding blocks
 * the run rather than shipping an inconsistent pair.
 *
 * It works over the assembled structure only (identities, slice digests, validation
 * outcomes), not rendered prose: the value/citation content audit against the live
 * facts is the M4 fresh run. What it can prove structurally, it proves — a shared
 * claim resolves to one identity in every document, a deterministic block is reused
 * by digest, an authored block never crosses audiences, every slice stays in its
 * document's scope, and no required block is missing.
 *
 * The boundary is precise for an authored shared claim (e.g. `known-issues.impact`):
 * this checks the two documents read the *same* slice identity, not that their
 * authored prose agrees — two audiences authoring contradictory text over one slice
 * is a content divergence the M4 fresh-run content match owns, not a structural one.
 */

import { createHash } from "node:crypto";

import { stableStringify } from "../contracts/shared-fact/merge.js";
import { joinKey } from "../contracts/shared-fact/serialization.js";
import type { AssembledBlock, AssembledDocument, AssembledReport } from "./assemble.js";

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export type AuditFindingKind =
  | "shared-claim-divergent"
  | "authored-block-cross-audience"
  | "slice-out-of-scope"
  | "incomplete-document";

export interface AuditFinding {
  readonly kind: AuditFindingKind;
  readonly detail: string;
}

export interface AuditReport {
  /** False if any finding was raised — the run must not complete. */
  readonly ok: boolean;
  readonly findings: readonly AuditFinding[];
  /** Shared-claim blocks whose identity was checked across documents. */
  readonly sharedClaimBlocks: number;
  /** Deterministic blocks reused across documents by identical digest. */
  readonly deterministicReuse: number;
  readonly digest: string;
}

type BlockAt = { readonly documentId: string; readonly block: AssembledBlock };

function scopeId(scope: AssembledBlock["sliceScope"]): string {
  return scope.kind === "project" ? "project" : `module:${scope.moduleId}`;
}

/** The identity a shared claim must hold across every document that carries it. */
function sharedIdentity(block: AssembledBlock): string {
  return joinKey([block.blockId, block.outputSchemaId, block.sliceKey, block.sliceDigest]);
}

export function auditReport(report: AssembledReport): AuditReport {
  const findings: AuditFinding[] = [];
  const allBlocks: BlockAt[] = report.documents.flatMap((doc) =>
    doc.sections.flatMap((s) => s.blocks.map((block) => ({ documentId: doc.documentId, block }))),
  );

  // 1. A shared claim resolves to one identity across the audiences of a scope. It
  //    is shared across audiences (product vs developer), not across scopes — the
  //    same block reads a scope-specific slice, so a project and a module document
  //    legitimately differ. Partition by (blockId, scope) so a cross-scope request
  //    is not flagged, while a genuine cross-audience divergence within a scope is.
  const sharedByGroup = new Map<string, BlockAt[]>();
  for (const at of allBlocks) {
    if (!at.block.carriesSharedClaim) continue;
    const key = joinKey([at.block.blockId, scopeId(at.block.sliceScope)]);
    const list = sharedByGroup.get(key) ?? [];
    list.push(at);
    sharedByGroup.set(key, list);
  }
  for (const [key, group] of [...sharedByGroup.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const identities = new Set(group.map((g) => sharedIdentity(g.block)));
    if (identities.size > 1) {
      findings.push({ kind: "shared-claim-divergent", detail: `${group[0]!.block.blockId} resolves to ${identities.size} identities within ${key}` });
    }
  }

  // 2. An authored block never crosses audiences: its task id folds the document, so
  //    a task id appearing in more than one document is a reuse bug.
  const byTask = new Map<string, Set<string>>();
  for (const at of allBlocks) {
    if (at.block.taskId === null) continue;
    const docs = byTask.get(at.block.taskId) ?? new Set<string>();
    docs.add(at.documentId);
    byTask.set(at.block.taskId, docs);
  }
  for (const [taskId, docs] of [...byTask.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (docs.size > 1) {
      findings.push({ kind: "authored-block-cross-audience", detail: `task ${taskId} appears in ${[...docs].sort().join(", ")}` });
    }
  }

  // 3. Every block's slice stays in its document's scope.
  const scopeByDoc = new Map(report.documents.map((d) => [d.documentId, d.scope] as const));
  for (const at of allBlocks) {
    const docScope = scopeByDoc.get(at.documentId);
    if (docScope !== undefined && scopeId(docScope) !== scopeId(at.block.sliceScope)) {
      findings.push({ kind: "slice-out-of-scope", detail: `${at.documentId}/${at.block.blockId} reads a ${scopeId(at.block.sliceScope)} slice` });
    }
  }

  // 4. A required authored block that never validated blocks the run.
  for (const doc of report.documents) {
    if (!doc.complete) {
      findings.push({ kind: "incomplete-document", detail: `${doc.documentId} is missing ${doc.missingRequired.join(", ")}` });
    }
  }

  // Deterministic blocks reused by identical (blockId, sliceDigest) across documents.
  const detSeen = new Map<string, number>();
  for (const at of allBlocks) {
    if (at.block.kind !== "deterministic") continue;
    const key = joinKey([at.block.blockId, at.block.sliceDigest]);
    detSeen.set(key, (detSeen.get(key) ?? 0) + 1);
  }
  const deterministicReuse = [...detSeen.values()].filter((n) => n > 1).length;

  return {
    ok: findings.length === 0,
    findings,
    sharedClaimBlocks: sharedByGroup.size,
    deterministicReuse,
    digest: digest(findings),
  };
}

function documentBlockCount(doc: AssembledDocument): number {
  return doc.sections.reduce((n, s) => n + s.blocks.length, 0);
}

/** A compact per-document accounting: printed (validated) vs missing (gap) blocks. */
export interface DocumentAccounting {
  readonly documentId: string;
  readonly blocks: number;
  readonly printed: number;
  readonly missing: number;
}

export function accountDocuments(report: AssembledReport): readonly DocumentAccounting[] {
  return report.documents.map((doc) => {
    const blocks = documentBlockCount(doc);
    const printed = doc.sections.reduce((n, s) => n + s.blocks.filter((b) => b.validated).length, 0);
    return { documentId: doc.documentId, blocks, printed, missing: blocks - printed };
  });
}
