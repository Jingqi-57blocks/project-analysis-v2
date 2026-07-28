import { randomBytes } from "node:crypto";

/**
 * Identity for one invocation, as distinct from identity of what was analyzed.
 *
 * `snapshots.identity` is a content digest: two runs over unchanged source
 * produce the same identity, which is exactly what makes drift detection work.
 * That makes it useless for telling runs apart — and runs need telling apart,
 * because a user analyzes the same project repeatedly and because an overview
 * and a module report generated separately must be recognizable as belonging
 * to the same run rather than being silently mixed across two.
 *
 * Time-ordered so runs sort chronologically as strings, with a random suffix
 * because two runs can start within the same second.
 */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `run-${stamp}-${randomBytes(3).toString("hex")}`;
}

const RUN_ID_PATTERN = /^run-\d{8}T\d{6}Z-[0-9a-f]{6}$/;

export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}
