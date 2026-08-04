/**
 * Prints a refusal as a refusal, and a bug as a bug.
 *
 * The reader-side commands refuse for reasons that are not faults: a `--db`
 * that names nothing, a run id that never published, a base holding several
 * workspaces. Those deserve the sentence the error already carries, not a stack
 * trace through the SQLite driver — a trace reads as "the tool broke" and sends
 * the reader looking in the wrong place.
 *
 * Anything else keeps its trace. Swallowing every error to make output tidy
 * would hide the failures that are worth the noise.
 */

const REFUSALS = new Set([
  "NoSuchStoreError",
  "SnapshotNotFoundError",
  "AmbiguousWorkspaceError",
  "ManifestError",
  "SchemaTooNewError",
]);

export function reportRefusals(): void {
  process.on("uncaughtException", (error: unknown) => {
    if (error instanceof Error && REFUSALS.has(error.name)) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  });
}
