export { readGitInfo, type GitInfo } from "./gitinfo.js";
export { snapshotRoot, type RootInput, type RootSnapshot } from "./rootsnapshot.js";
export { workspaceIdentity } from "./identity.js";
export { checkDrift, type DriftCheck } from "./drift.js";
export {
  beginSnapshot,
  publishOrRefuse,
  DriftDetectedError,
  type SnapshotHandle,
  type PersistedRoot,
} from "./persist.js";
