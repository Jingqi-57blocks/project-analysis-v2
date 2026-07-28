/**
 * Cross-root links: an outbound call in one root resolved to a route in
 * another.
 *
 * This is the part of the product that is entirely ours. Structural providers
 * index one directory at a time; joining N roots into one connected picture is
 * what this tool adds on top of them.
 *
 * Consumes the assembled Structural Model and nothing else. It must not know
 * which provider produced any record, and must not read provider-native
 * fields — otherwise linking would silently depend on CodeGraph being the
 * provider, and replacing it would break a stage that never mentions it.
 */

import type { Provenance } from "../structural/provenance.js";
import type { SymbolId } from "../structural/identity.js";

export const CONVENTIONAL_LINK_KINDS = ["http-route", "queue", "rpc", "unknown"] as const;
export type LinkKind = (typeof CONVENTIONAL_LINK_KINDS)[number] | (string & {});

/**
 * Why a candidate was rejected, or why a call could not be linked at all.
 *
 * Recorded rather than discarded: an unlinked outbound call is a finding about
 * the system — a call to something outside the workspace, or to a route no
 * root declares — and dropping it would make the picture look more connected
 * than it is.
 */
export type UnlinkedReason =
  | "target-not-resolved"
  | "no-matching-route"
  | "ambiguous-match"
  | "external-destination";

export interface CrossRootLink {
  readonly fromRoot: string;
  readonly fromSymbolId: SymbolId | null;
  /** The outbound call's destination, as recorded by the detector. */
  readonly target: string;
  readonly toRoot: string;
  readonly toMethod: string | null;
  readonly toPath: string;
  readonly toHandlerSymbolId: SymbolId | null;
  readonly kind: LinkKind;
  readonly provenance: Provenance;
}

export interface UnlinkedCall {
  readonly fromRoot: string;
  readonly fromSymbolId: SymbolId | null;
  /** Null when the destination itself was never resolved. */
  readonly target: string | null;
  readonly reason: UnlinkedReason;
  /** Candidate routes that matched equally well, when the reason is ambiguity. */
  readonly candidates: readonly string[];
  readonly provenance: Provenance;
}

/**
 * Every outbound call is accounted for: linked, or unlinked with a reason.
 *
 * `linked + unlinked = outbound calls considered` holds by construction, the
 * same way inventory's file accounting does.
 */
export interface LinkResult {
  readonly links: readonly CrossRootLink[];
  readonly unlinked: readonly UnlinkedCall[];
  readonly considered: number;
}
