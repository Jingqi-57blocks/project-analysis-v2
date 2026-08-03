/**
 * Whether a fact is in effect — kept apart from how well it was identified.
 *
 * Configuration can exist, and code be reachable, without a behaviour being
 * enabled in the running system. Resolution says how surely we read the fact;
 * activation says whether it applies. Conflating them would report a wired-but-
 * disabled path as a live one.
 */

export type ActivationState =
  /** In effect unconditionally, on the evidence available. */
  | "active"
  /** In effect only under a condition (a flag, an environment, a role). */
  | "conditional"
  /** Cannot be determined from source alone — production state is unobservable. */
  | "unresolved";

export const ACTIVATION_STATES: readonly ActivationState[] = ["active", "conditional", "unresolved"];

/**
 * When production state cannot be observed, activation fails closed to
 * `unresolved` — never silently to `active`, which would assert a fact is live
 * without evidence.
 */
export function activationFromObservation(input: {
  readonly observable: boolean;
  readonly conditional: boolean;
}): ActivationState {
  if (!input.observable) return "unresolved";
  return input.conditional ? "conditional" : "active";
}
