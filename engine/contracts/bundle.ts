/**
 * The M0 contract bundle.
 *
 * Assembles every versioned M0 contract — shared-fact, report, the WCP-V2 leave
 * truth set, the angels-pizza sentinels, the acceptance-target manifest and the
 * rubric — into one machine-readable descriptor set, and digests each. The
 * digests go into engine/contracts/lock.json; the verifier recomputes them, so
 * changing a contract without bumping its version and updating the lock fails
 * (drift detection). The bundle reads committed data only — never a target
 * folder — so it works whether or not the targets are present.
 */

import { createHash } from "node:crypto";

import { loadTargetManifest } from "./targets/manifest.js";
import { GATES, GOLDEN_SLICE_THRESHOLDS } from "./rubric/gates.js";
import { loadAngelsPizzaSentinels } from "./truth/sentinel.js";
import { loadLeaveTruthLedger } from "./truth/leave.js";
import { DOCUMENT_PRESETS } from "./report/presets.js";
import { SECTION_CATALOG } from "./report/catalog.js";
import { loadSpecRegistry } from "./report/specs.js";
import {
  KB_CONTRACT_ID,
  KB_CONTRACT_VERSION,
  KB_TABLES,
  LINE_ANCHORED_KINDS,
  READING_ORDER,
  SET_VALUED_KINDS,
  WORKSPACE_LEVEL_KINDS,
  loadKbContractGuide,
} from "./kb/index.js";
import { REPORT_CONTRACT_ID, REPORT_CONTRACT_VERSION } from "./report/version.js";
import { COVERAGE_STATES } from "./shared-fact/applicability.js";
import { FACT_FAMILIES } from "./shared-fact/families.js";
import { RESOLUTION_CLASSES } from "./shared-fact/provenance.js";
import { stableStringify } from "./shared-fact/merge.js";
import { SHARED_FACT_CONTRACT_ID, SHARED_FACT_CONTRACT_VERSION } from "./shared-fact/version.js";

export interface ContractDescriptor {
  readonly id: string;
  readonly version: string;
  /** The fixed shape whose change means the contract changed. */
  readonly snapshot: unknown;
}

/** Digest of a contract written as prose, whose text is itself load-bearing. */
function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Every M0 contract, with a canonical snapshot of its load-bearing shape. */
export function contractDescriptors(): readonly ContractDescriptor[] {
  const leave = loadLeaveTruthLedger();
  const sentinels = loadAngelsPizzaSentinels();
  const targets = loadTargetManifest();
  const specs = loadSpecRegistry();
  return [
    {
      id: SHARED_FACT_CONTRACT_ID,
      version: SHARED_FACT_CONTRACT_VERSION,
      snapshot: { families: FACT_FAMILIES, resolutions: RESOLUTION_CLASSES, coverageStates: COVERAGE_STATES },
    },
    {
      id: REPORT_CONTRACT_ID,
      version: REPORT_CONTRACT_VERSION,
      snapshot: {
        presets: DOCUMENT_PRESETS.map((p) => ({
          id: p.id,
          required: p.requiredSectionIds,
          optional: p.optionalSectionIds,
        })),
        sections: SECTION_CATALOG.map((s) => s.id),
        // Specs are prose contracts, so their text is load-bearing: the digest
        // makes an edit to any chapter fail the drift gate, not just an edit to
        // the frontmatter.
        writingContract: {
          id: specs.contract.id,
          version: specs.contract.version,
          digest: digestText(specs.contract.body),
        },
        specs: specs.specs.map((s) => ({
          id: s.id,
          scope: s.scope,
          audience: s.audience,
          version: s.version,
          inherits: s.inherits,
          requires: s.requires,
          digest: digestText(s.body),
        })),
      },
    },
    {
      id: "truth-leave",
      version: leave.manifest.version,
      snapshot: {
        items: leave.items.length,
        roots: leave.manifest.roots.map((r) => ({ name: r.name, sha: r.sha })),
      },
    },
    {
      id: "sentinel-angels-pizza",
      version: sentinels.manifest.version,
      snapshot: { items: sentinels.items.length },
    },
    {
      id: "targets",
      version: targets.version,
      snapshot: {
        targets: targets.targets.map((t) => ({
          id: t.id,
          roots: t.roots.map((r) => ({ name: r.name, rev: r.revision })),
        })),
      },
    },
    {
      id: KB_CONTRACT_ID,
      version: KB_CONTRACT_VERSION,
      snapshot: {
        tables: KB_TABLES.map((t) => ({
          table: t.table,
          identity: t.identityColumn,
          layer: t.layer,
          kinds: t.kinds,
          publicColumns: t.publicColumns,
        })),
        readingOrder: READING_ORDER,
        lineAnchored: LINE_ANCHORED_KINDS,
        setValued: SET_VALUED_KINDS,
        workspaceLevel: WORKSPACE_LEVEL_KINDS,
        // The reader-facing guide is prose, so its text is load-bearing too.
        guideDigest: digestText(loadKbContractGuide()),
      },
    },
    {
      id: "rubric",
      version: "1.0.0",
      snapshot: { gates: GATES.map((g) => g.id), golden: GOLDEN_SLICE_THRESHOLDS },
    },
  ];
}

export function contractDigest(descriptor: ContractDescriptor): string {
  return createHash("sha256")
    .update(stableStringify({ version: descriptor.version, snapshot: descriptor.snapshot }))
    .digest("hex");
}

export interface ContractLockEntry {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface ContractLock {
  readonly version: string;
  readonly contracts: readonly ContractLockEntry[];
  readonly bundleDigest: string;
}

export function computeLock(): ContractLock {
  const descriptors = contractDescriptors();
  const contracts = descriptors.map((d) => ({ id: d.id, version: d.version, digest: contractDigest(d) }));
  const hash = createHash("sha256");
  for (const c of contracts) {
    hash.update(c.id);
    hash.update("\0");
    hash.update(c.digest);
    hash.update("\0");
  }
  return { version: "1.0.0", contracts, bundleDigest: hash.digest("hex") };
}
