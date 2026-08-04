/**
 * Unified M0 contract verification.
 *
 * One offline command that loads every M0 contract, runs its validator, checks
 * the positive/negative fixtures, and — the drift gate — recomputes the bundle
 * digest and compares it to engine/contracts/lock.json. Any mismatch, failed
 * validator, or fixture that does not behave as specified fails the command with
 * a machine-readable receipt. Reads committed data only; never touches a target
 * folder, so it runs in CI without the targets present.
 */

import { readFileSync } from "node:fs";

import { computeLock, type ContractLock } from "../engine/contracts/bundle.js";
import { CHECKLIST_IDS } from "../engine/contracts/report/checklist.js";
import { validateKbContract } from "../engine/contracts/kb/index.js";
import { MODULE_CATEGORIES, categorize } from "../engine/contracts/module/index.js";
import { INVALID_PROVENANCE_EXAMPLES, validateProvenance } from "../engine/contracts/shared-fact/index.js";
import { loadTargetManifest, validateManifest } from "../engine/contracts/targets/index.js";
import { loadAngelsPizzaSentinels, validateSentinelLedger } from "../engine/contracts/truth/sentinel.js";
import { loadLeaveTruthLedger } from "../engine/contracts/truth/leave.js";
import { validateLedger } from "../engine/contracts/truth/schema.js";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
}

// 1. Drift gate: the recomputed bundle digest must equal the committed lock.
const lock = JSON.parse(readFileSync("engine/contracts/lock.json", "utf8")) as ContractLock;
const fresh = computeLock();
check(
  "contract-lock drift",
  fresh.bundleDigest === lock.bundleDigest,
  fresh.bundleDigest === lock.bundleDigest
    ? ""
    : `bundle digest changed (${lock.bundleDigest.slice(0, 12)} -> ${fresh.bundleDigest.slice(0, 12)}); bump the contract version(s) and regenerate lock.json`,
);

// 2. Validators.
const leave = validateLedger(loadLeaveTruthLedger());
check("leave truth ledger", leave.ok, leave.ok ? "" : leave.reasons.join("; "));
const sentinels = validateSentinelLedger(loadAngelsPizzaSentinels());
check("angels-pizza sentinels", sentinels.ok, sentinels.ok ? "" : sentinels.reasons.join("; "));
const targets = validateManifest(loadTargetManifest());
check("target manifest", targets.ok, targets.ok ? "" : targets.reasons.join("; "));
// The checklist ids the audit enforces must match the table the author reads.
// They live in two places because one is instruction and the other is a check;
// drifting apart would silently stop enforcing an item.
const rules = readFileSync("skills/project-report/references/writing-rules.md", "utf8");
const checklistSection = rules.split(/^## /m).find((s) => s.startsWith("Checklist")) ?? "";
const documented = [...checklistSection.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]);
check(
  "checklist ids match writing-rules.md",
  documented.length === CHECKLIST_IDS.length && documented.every((id, i) => id === CHECKLIST_IDS[i]),
  `documented [${documented.join(", ")}] vs enforced [${CHECKLIST_IDS.join(", ")}]`,
);
const kb = validateKbContract();
check("knowledge-base read contract", kb.ok, kb.ok ? "" : kb.reasons.join("; "));
check(
  "module categorization is total",
  MODULE_CATEGORIES.includes(
    categorize({ endpointCount: 0, dataEntityCount: 0, outboundTargetCount: 0, symbolCount: 0, dependentCount: 0 }),
  ),
);

// 3. Positive / negative fixtures behave as specified.
for (const ex of INVALID_PROVENANCE_EXAMPLES) {
  check(`invalid provenance rejected (${ex.why})`, !validateProvenance(ex.value).ok);
}

if (failures.length > 0) {
  console.error("M0 CONTRACT VERIFICATION FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `M0 contracts verified: ${fresh.contracts.length} contracts, bundle ${fresh.bundleDigest.slice(0, 12)}`,
);
for (const c of fresh.contracts) console.log(`  ${c.id}@${c.version} ${c.digest.slice(0, 12)}`);
