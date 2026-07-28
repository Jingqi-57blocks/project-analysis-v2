/**
 * Extracts declarative rules and boundary facts by matching stated patterns.
 *
 * A third provider, composed alongside the others rather than branching inside
 * them. CodeGraph declares these kinds unsupported; this fills that gap in the
 * way the architecture prescribes.
 *
 * Every record it produces is an inference, never a declaration — see
 * `patterns.ts` for why.
 */

import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { emptyRecords } from "../../structural/kinds.js";
import { inferred, lineRef } from "../../structural/provenance.js";
import {
  ANY_LANGUAGE,
  declaredKinds,
  type ExtractionFailure,
  type ProviderCapabilities,
  type StructuralContribution,
  type StructuralProvider,
  type StructuralRootInput,
} from "../../structural/provider.js";
import type { PreflightResult } from "../types.js";
import type {
  AuthAnnotationRecord,
  DataAccessRecord,
} from "../../structural/boundaries.js";
import type {
  ErrorHandlingRecord,
  TransactionBoundaryRecord,
  ValidationRuleRecord,
} from "../../structural/rules.js";
import { patternsFor, SUPPORTED_KINDS } from "./patterns.js";

export const PROVIDER_ID = "conventions";
export const PROVIDER_VERSION = "1.0.0";

/**
 * Files above this size are skipped and reported as failures.
 *
 * Scanning a multi-megabyte bundle for declarative patterns costs real time
 * and yields matches from generated code that describe nothing a reader cares
 * about. The limit is declared, and skipped files are recorded rather than
 * silently passed over.
 */
const MAX_FILE_BYTES = 1_000_000;

export function conventionCapabilities(): ProviderCapabilities {
  const shared = [
    "matches declared patterns only; logic expressed in control flow is not reached",
    "matches are textual, so occurrences in comments or strings are possible",
    `files larger than ${MAX_FILE_BYTES} bytes are skipped`,
  ];

  /** Limits specific to one kind, on top of the shared ones. */
  const perKind: Partial<Record<(typeof SUPPORTED_KINDS)[number], readonly string[]>> = {
    "auth-annotation": [
      // Measured, not guessed: 60 matches across 44 files of a real Go auth
      // service. Stated so a consumer counts these as weak evidence rather
      // than as a list of protected endpoints.
      "languages without auth annotations are matched by name alone, which over-matches heavily in auth-centric codebases",
    ],
    "data-access": [
      "ORM method names are matched without resolving the receiver, so unrelated methods of the same name match",
      "the entity touched is not resolved and is always null",
    ],
  };

  return {
    declarations: SUPPORTED_KINDS.map((kind) => ({
      kind,
      language: ANY_LANGUAGE,
      support: "partial" as const,
      limits: [...shared, ...(perKind[kind] ?? [])],
    })),
  };
}

interface Found {
  readonly validation: ValidationRuleRecord[];
  readonly transactions: TransactionBoundaryRecord[];
  readonly errors: ErrorHandlingRecord[];
  readonly auth: AuthAnnotationRecord[];
  readonly data: DataAccessRecord[];
  readonly failures: ExtractionFailure[];
}

/** The 1-based line a character offset falls on. */
function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}

function scanFile(root: StructuralRootInput, relPath: string, content: string, found: Found): void {
  const extension = extname(relPath).toLowerCase();

  for (const pattern of patternsFor(extension)) {
    // A fresh regex per file: a shared global regex carries lastIndex between
    // calls and would skip matches in every file after the first.
    const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const source = lineRef(root.name, relPath, lineAt(content, match.index));
      const provenance = inferred(source, pattern.confidence);
      const detail = pattern.detailGroup ? (match[pattern.detailGroup] ?? null) : null;

      switch (pattern.kind) {
        case "validation-rule":
          found.validation.push({
            rootName: root.name,
            subjectSymbolId: null,
            field: null,
            rule: pattern.label,
            expression: detail,
            source,
            provenance,
          });
          break;
        case "transaction-boundary":
          found.transactions.push({
            rootName: root.name,
            symbolId: null,
            mechanism: pattern.label,
            propagation: detail,
            source,
            provenance,
          });
          break;
        case "error-handling":
          found.errors.push({
            rootName: root.name,
            symbolId: null,
            handles: [],
            scope: "call-site",
            source,
            provenance,
          });
          break;
        case "auth-annotation":
          found.auth.push({
            rootName: root.name,
            symbolId: null,
            mechanism: pattern.label,
            requirement: detail,
            source,
            provenance,
          });
          break;
        case "data-access":
          found.data.push({
            rootName: root.name,
            // The entity is rarely recoverable from the call site alone, and
            // guessing it would attach operations to tables that may not exist.
            entity: null,
            operation: "unknown",
            mechanism: detail ?? pattern.label,
            symbolId: null,
            provenance,
          });
          break;
      }

      // A zero-width match would loop forever otherwise.
      if (match.index === regex.lastIndex) regex.lastIndex += 1;
    }
  }
}

export function createConventionsProvider(): StructuralProvider {
  const capabilities = conventionCapabilities();

  return {
    id: PROVIDER_ID,
    version: PROVIDER_VERSION,

    capabilities: () => declaredKinds(capabilities),

    preflight: (): PreflightResult => ({ available: true, version: PROVIDER_VERSION }),

    structuralCapabilities: () => capabilities,

    extract: (root: StructuralRootInput): StructuralContribution => {
      const found: Found = {
        validation: [],
        transactions: [],
        errors: [],
        auth: [],
        data: [],
        failures: [],
      };

      for (const relPath of root.analyzedFiles) {
        const full = join(root.path, relPath);
        try {
          if (statSync(full).size > MAX_FILE_BYTES) {
            found.failures.push({ scope: relPath, reason: "file exceeds the scan size limit" });
            continue;
          }
          scanFile(root, relPath, readFileSync(full, "utf8"), found);
        } catch (error) {
          // One unreadable file must not discard every other file's matches.
          found.failures.push({
            scope: relPath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        providerId: PROVIDER_ID,
        providerVersion: PROVIDER_VERSION,
        rootName: root.name,
        records: {
          ...emptyRecords(),
          "validation-rule": found.validation,
          "transaction-boundary": found.transactions,
          "error-handling": found.errors,
          "auth-annotation": found.auth,
          "data-access": found.data,
        },
        gaps: [],
        failures: found.failures,
      };
    },
  };
}
