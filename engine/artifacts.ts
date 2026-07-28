/**
 * Directories this tool's own providers write into an analyzed root.
 *
 * Analyzed source is read-only with exactly one accepted exception: CodeGraph
 * creates `.codegraph/` inside whatever it indexes and offers no flag to
 * relocate it.
 *
 * Declared once, here, because two independent stages must agree about it and
 * for opposite reasons — content digests must ignore these (or indexing would
 * look like a source change and publishing would refuse with a drift error
 * naming our own output), while inventory must record them with a reason (or
 * they would vanish with no disposition at all). Two copies of the list would
 * eventually disagree, and the failure would look like drift on one machine
 * and a missing file on another.
 *
 * This is the only place outside `providers/codegraph/` that names the vendor,
 * and it names it as data rather than behaviour. Anything else knowing about
 * CodeGraph would be a genuine boundary leak.
 */
export const ANALYSIS_ARTIFACT_DIRECTORIES: ReadonlySet<string> = new Set([".codegraph"]);

export const ANALYSIS_ARTIFACT_REASON = "analysis index written by this tool, not project content";
