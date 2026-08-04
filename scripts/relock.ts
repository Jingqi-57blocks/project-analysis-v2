/**
 * Regenerate engine/contracts/lock.json from the current contracts.
 *
 * The drift gate exists so that changing a contract without noticing fails CI.
 * Regenerating is therefore a deliberate act with its own command, run after the
 * contract version was bumped on purpose — never a fix for a red build.
 */

import { writeFileSync } from "node:fs";

import { computeLock } from "../engine/contracts/bundle.js";

writeFileSync("engine/contracts/lock.json", JSON.stringify(computeLock(), null, 2) + "\n");
console.log("engine/contracts/lock.json regenerated");
