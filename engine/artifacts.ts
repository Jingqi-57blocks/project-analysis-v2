import { isAbsolute } from "node:path";

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
export const DEFAULT_CODE_INDEX_DIRECTORY = ".codegraph";

/**
 * The index directory's name, as this process will see it.
 *
 * CodeGraph honours a `CODEGRAPH_DIR` override, because two environments
 * sharing one working tree — Windows-native and WSL — must not share one index:
 * the lock file records a platform-specific pid and socket, and SQLite locking
 * across that boundary is unreliable. Hard-coding the default meant CodeGraph
 * indexed happily into `.codegraph-win` while this tool looked for a database
 * that was not there, and — worse — digested and inventoried the index it had
 * just written as though it were the project's own source.
 *
 * Read live rather than captured at load, and validated the same way CodeGraph
 * validates it: an override that is not a plain directory name is ignored by
 * both, and disagreeing about that would put the two on different paths.
 */
export function codeIndexDirName(): string {
  const raw = process.env["CODEGRAPH_DIR"]?.trim();
  if (!raw) return DEFAULT_CODE_INDEX_DIRECTORY;
  const invalid = raw === "." || raw.includes("..") || raw.includes("/") || raw.includes("\\") || isAbsolute(raw);
  return invalid ? DEFAULT_CODE_INDEX_DIRECTORY : raw;
}

/**
 * Whether a directory entry is an index this tool's own analysis wrote.
 *
 * Sibling `.codegraph-*` directories count, not only the active one. They are
 * what the override exists to create, and the machine that did not write one
 * still must not digest it: a directory left by the other environment is this
 * tool's output either way, and treating it as source makes the digest depend
 * on which environment last indexed.
 */
export function isAnalysisArtifactDirectory(name: string): boolean {
  return name === DEFAULT_CODE_INDEX_DIRECTORY || name === codeIndexDirName() || name.startsWith(`${DEFAULT_CODE_INDEX_DIRECTORY}-`);
}

export const ANALYSIS_ARTIFACT_REASON = "analysis index written by this tool, not project content";
