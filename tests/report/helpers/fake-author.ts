/**
 * A deterministic fake `ProseAuthor` for the authoring-host contract tests. It
 * satisfies the same seam a real (model-backed) author does, records its calls so a
 * test can prove each task was authored the expected number of times, and can be
 * configured to return grounded prose, deliberately ungrounded prose (a foreign
 * citation), or nothing at all — the three outcomes the host must handle.
 *
 * The grounded default builds clean prose from the request's own facts: one cited
 * sentence per fact, `[n]` markers only, no quoted values — so grounding passes
 * without depending on any particular fact's shape.
 */

import type { AuthoringRequest } from "../../../engine/report/author-prompt.js";
import type { ProseAuthor } from "../../../engine/report/authoring-host.js";
import type { CitedFact } from "../../../engine/report/slice-resolve.js";

/** Clean, grounded prose from a request's facts: cites every fact by its `[n]` index. */
export function groundedProse(facts: readonly CitedFact[]): string {
  return facts.map((_fact, i) => `Cited fact ${i + 1} is recorded [${i + 1}].`).join(" ");
}

/** Ungrounded prose: cites a marker past the end of the digest — a foreign citation. */
export function ungroundedProse(facts: readonly CitedFact[]): string {
  return `A fabricated claim cites nothing real [${facts.length + 1}].`;
}

export interface FakeAuthorConfig {
  /** taskIds whose prose is deliberately ungrounded (foreign citation) — every attempt. */
  readonly ungrounded?: ReadonlySet<string>;
  /** taskIds the author declines (returns null) — every attempt. */
  readonly nulls?: ReadonlySet<string>;
  /** taskId → exact prose to return, overriding the grounded default. */
  readonly proseByTask?: Readonly<Record<string, string>>;
}

export interface RecordingAuthor {
  readonly author: ProseAuthor;
  /** taskIds in call order — a duplicate here is a retry. */
  readonly calls: readonly string[];
  callCount(taskId: string): number;
}

/** A fake author. By default it returns clean grounded prose for every request. */
export function fakeAuthor(config: FakeAuthorConfig = {}): RecordingAuthor {
  const calls: string[] = [];
  const author: ProseAuthor = (request: AuthoringRequest) => {
    calls.push(request.taskId);
    if (config.nulls?.has(request.taskId)) return null;
    const override = config.proseByTask?.[request.taskId];
    if (override !== undefined) return { prose: override };
    if (config.ungrounded?.has(request.taskId)) return { prose: ungroundedProse(request.facts) };
    return { prose: groundedProse(request.facts) };
  };
  return { author, calls, callCount: (taskId) => calls.filter((t) => t === taskId).length };
}
