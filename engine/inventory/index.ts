export {
  classifyPath,
  looksGenerated,
  DEPENDENCY_DIRECTORIES,
  type Classification,
} from "./classify.js";
export {
  walkRoot,
  type WalkResult,
  type AnalyzedFile,
  type ExcludedEntry,
  type FailedFile,
} from "./walk.js";
export { recordInventory, type InventoryCounts } from "./persist.js";
