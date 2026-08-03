/**
 * Lightweight sentinel truth for a generalization target.
 *
 * A full truth set (like the WCP-V2 leave ledger) is not built for every target.
 * Instead a small, source-verified set of sentinels checks precision and key
 * structural relations, so a fresh run that is internally consistent but
 * factually wrong cannot pass. Every set carries positive AND negative items
 * (and a clean-absence), because "produced a report" and "did not crash" are not
 * truth. Items flagged `noDedicatedReader` guard the case that matters most for
 * angels-pizza: a root no route reader covers must still yield useful structure,
 * not an empty or "no interface" conclusion.
 *
 * Revisions are pinned once in the acceptance-target manifest
 * (truth-set/targets.json); this set names the target and reads that.
 */

import { readFileSync } from "node:fs";

export type SentinelKind = "positive" | "negative" | "clean-absence";
export const SENTINEL_KINDS: readonly SentinelKind[] = ["positive", "negative", "clean-absence"];

export type SentinelStatus = "found" | "absent" | "unresolved";

export interface SentinelEvidence {
  readonly path: string;
  readonly lines?: string;
  readonly note?: string;
}

export interface SentinelItem {
  readonly id: string;
  readonly root: string;
  readonly kind: SentinelKind;
  readonly category: string;
  readonly claim: string;
  readonly evidence: readonly SentinelEvidence[];
  readonly expectedStatus: SentinelStatus;
  readonly criticality: "critical" | "normal";
  readonly mustFind: boolean;
  /** True when the root has no dedicated route reader — the generic path must carry it. */
  readonly noDedicatedReader: boolean;
  /** The false positive/negative this item guards against. */
  readonly prevents: string;
}

export interface SentinelManifest {
  readonly version: string;
  readonly target: string;
  readonly note: string;
}

export interface SentinelLedger {
  readonly manifest: SentinelManifest;
  readonly items: readonly SentinelItem[];
}

export type SentinelValidation = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

export function validateSentinelLedger(ledger: SentinelLedger): SentinelValidation {
  const reasons: string[] = [];
  const ids = new Set<string>();
  const kinds = new Set<SentinelKind>();

  for (const item of ledger.items) {
    if (ids.has(item.id)) reasons.push(`duplicate sentinel id: ${item.id}`);
    ids.add(item.id);
    kinds.add(item.kind);
    if (!SENTINEL_KINDS.includes(item.kind)) reasons.push(`${item.id}: unknown kind ${item.kind}`);
    if (item.evidence.length === 0) reasons.push(`${item.id}: no evidence`);
    for (const e of item.evidence) if (e.path.length === 0) reasons.push(`${item.id}: evidence missing path`);
    if (item.kind === "clean-absence" && item.expectedStatus !== "absent") {
      reasons.push(`${item.id}: a clean-absence sentinel must expect 'absent'`);
    }
    if (item.criticality === "critical" && !item.mustFind) reasons.push(`${item.id}: critical must be mustFind`);
    if (item.prevents.length === 0) reasons.push(`${item.id}: must state the false positive/negative it prevents`);
  }

  // Positive and negative must both exist — a report existing is not truth.
  if (!kinds.has("positive")) reasons.push("no positive sentinel");
  if (!kinds.has("negative")) reasons.push("no negative sentinel");
  // The no-reader case must be exercised.
  if (!ledger.items.some((i) => i.noDedicatedReader)) {
    reasons.push("no sentinel exercises a no-dedicated-reader root");
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

const ANGELS_PIZZA_URL = new URL("../../../truth-set/angels-pizza/sentinels.json", import.meta.url);

export function loadAngelsPizzaSentinels(): SentinelLedger {
  return JSON.parse(readFileSync(ANGELS_PIZZA_URL, "utf8")) as SentinelLedger;
}

export function sentinelsByKind(ledger: SentinelLedger, kind: SentinelKind): readonly SentinelItem[] {
  return ledger.items.filter((i) => i.kind === kind);
}

export function noReaderSentinels(ledger: SentinelLedger): readonly SentinelItem[] {
  return ledger.items.filter((i) => i.noDedicatedReader);
}
