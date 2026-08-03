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
import {
  DOCUMENT_PRESETS,
  ILLEGAL_REQUEST_EXAMPLES,
  LEGAL_COMBINATION_EXAMPLES,
  loadSpecRegistry,
  validatePreset,
  validateRequest,
  validateSpecRegistry,
} from "../engine/contracts/report/index.js";
import { INVALID_CLAIM_EXAMPLES, VALID_CLAIM_EXAMPLES, validateClaim } from "../engine/contracts/claim/index.js";
import { validateKbContract } from "../engine/contracts/kb/index.js";
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
for (const preset of DOCUMENT_PRESETS) {
  const v = validatePreset(preset);
  check(`report preset ${preset.id}`, v.ok, v.ok ? "" : v.reason);
}
const specs = validateSpecRegistry(loadSpecRegistry());
check("output specs", specs.ok, specs.ok ? "" : specs.reasons.join("; "));
const kb = validateKbContract();
check("knowledge-base read contract", kb.ok, kb.ok ? "" : kb.reasons.join("; "));
for (const example of VALID_CLAIM_EXAMPLES) {
  const v = validateClaim(example.claim);
  check(`valid claim (${example.name})`, v.ok, v.ok ? "" : v.reasons.join("; "));
}
for (const example of INVALID_CLAIM_EXAMPLES) {
  check(`invalid claim rejected (${example.why})`, !validateClaim(example.claim).ok);
}

// 3. Positive / negative fixtures behave as specified.
for (const ex of LEGAL_COMBINATION_EXAMPLES) check(`legal combination ${ex.name}`, validateRequest(ex.request).ok);
for (const ex of ILLEGAL_REQUEST_EXAMPLES) check(`illegal request rejected (${ex.why})`, !validateRequest(ex.request).ok);
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
