/**
 * Canonical serialization for every identity in the shared-fact contract.
 *
 * The delimiter is escaped inside each part: without it the parts `a|b` + `c`
 * and `a` + `b|c` serialize to the same string, and two unrelated facts merge
 * silently — a collision nothing downstream could detect.
 */

export const DELIMITER = "|";

function escape(part: string): string {
  return part.replaceAll("\\", "\\\\").replaceAll(DELIMITER, `\\${DELIMITER}`);
}

/** Joins parts into one collision-free key. Null and undefined encode as "". */
export function joinKey(parts: readonly (string | number | null | undefined)[]): string {
  return parts.map((part) => escape(part == null ? "" : String(part))).join(DELIMITER);
}
