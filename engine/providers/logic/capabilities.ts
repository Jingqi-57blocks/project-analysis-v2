/**
 * What this reader attempts, and what it declares it cannot do.
 *
 * Its own module: the declarations are the longest thing in the provider and the
 * part most often corrected — three reviews found a limit here that was false about
 * the code it documents. A move, not a rewrite.
 */

import { MAX_BRANCHES, MAX_DEPTH } from "./decisions.js";
import { ANY_LANGUAGE, type ProviderCapabilities } from "../../structural/provider.js";

export function logicCapabilities(): ProviderCapabilities {
  return {
    declarations: [
      {
        kind: "decision",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: [
          "if/else chains and switch statements are read as trees; branching expressed another way — early returns in sequence, a lookup table, polymorphism — is not a decision this reports",
          "a branch records where its body is, not what it does; tables and calls are joined from their own readers by line",
          `nesting deeper than ${MAX_DEPTH} levels or wider than ${MAX_BRANCHES} branches is recorded as truncated rather than dropped`,
          "languages without a grammar in this run are not read at all",
        ],
      },
      {
        kind: "condition",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: [
          "comparisons against a literal are read; a rule expressed through a named constant on both sides is not a condition this reports",
          "a rule spread across several statements, or decided by a function call, is out of reach",
          "counters and bounds checks are excluded by shape, so a genuine rule named like an index is missed",
          "languages without a grammar in this run are not read at all",
        ],
      },
      {
        kind: "guard",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: [
          "an `if` that rejects is read as a rule, by the message it states or by the name of the error constant it *throws*; the text behind such a constant lives in a message catalogue this run does not read, so the rule is named rather than quoted",
          "a branch that leaves with a message is read the same way whether it throws or returns, because a rejection in Express or Go states its message by building a response body; a branch that returns a value rather than refusing — one subject line per language, a label, a formatted heading — is therefore read as a rule too, and only the recorded exit distinguishes them",
          "a named error must be the thrown expression or its first argument, and its parts must be capitalised — so `raise PermissionDenied`, `return ErrNotFound` and `throw new ForbiddenException()` are all missed, and a gate that rejects through one of those is absent rather than reported",
          "the message is the rule as the code states it, not a resolution of what it means; two gates with the same message on different values read alike",
          "a message built from a template is quoted as the first run of its text that reads like a sentence, which may begin or end at an interpolation: `Already have a work log for ${proj.name}` is reported as `Already have a work log for`, and `entries[${i}].date must be YYYY-MM-DD` as `].date must be YYYY-MM-DD`. A message longer than 160 characters is cut. The rule is real in each case and its sentence is incomplete",
          "error-propagation guards (`if err != nil`) are filtered by shape, so a genuine rule that happens to test a variable named like an error is missed",
          "a styling attribute is never read as a message, so a rule stated only through a class name is missed — and one stated in a component's other props is read as though it were a rejection",
          "languages without a grammar in this run are not read at all",
        ],
      },
      {
        kind: "discarded-error",
        language: ANY_LANGUAGE,
        support: "partial",
        limits: [
          "the shape of the dispatch is read, not the callee's signature, so a call that returns nothing is reported alongside one that returns an error",
          "only a method dispatched as a goroutine, or an un-awaited method call, is recognised; an anonymous goroutine handles its own result and is not reported",
          "a JavaScript call counts only where the same method is awaited elsewhere in its file, so an asynchronous call never awaited anywhere is missed",
        ],
      },
    ],
  };
}

