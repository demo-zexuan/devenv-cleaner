/**
 * Core Barrel
 *
 * The single internal entry point for the headless engine.
 *
 * I. Why a barrel inside `core/`
 *
 * 1. Everything above the engine — commands, reporters, the TUI container —
 *    depends on the engine as a whole rather than on its internal file layout,
 *    so a module can be split or renamed without touching a dozen imports.
 * 2. It also makes the dependency direction checkable by inspection: a file that
 *    imports from `../core/index.js` is a consumer, and a file that imports a
 *    sibling directly is engine-internal.
 *
 * II. What is deliberately NOT re-exported
 *
 * 1. `ids.ts` helpers stay out of the surface: id generation is an engine
 *    implementation detail, not something a front-end should call.
 *
 * @module core/index
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

/**
 * The display order of lifecycle layers, re-exported so a front-end does not
 * have to reach into `rules/engine.js` for a presentation constant.
 */
export { LAYER_ORDER } from '../rules/engine.js';
export {
  ALL_MARKER_NAMES,
  type DetectionResult,
  detectInEntries,
  ECOSYSTEMS,
  type EcosystemDefinition,
  type EcosystemId,
  ecosystemName,
  getEcosystem,
  type MarkerDefinition,
  type NodePackageManager,
} from './detector.js';
export {
  type CleanExecutionReport,
  type ExecuteOptions,
  executePlan,
  formatExecutionSummary,
} from './executor.js';
export {
  displayWidth,
  ellipsizePath,
  formatAge,
  formatBar,
  formatBytes,
  formatCount,
  formatDuration,
  formatPercent,
  formatSignedBytes,
  formatTimestamp,
  pad,
  truncateToWidth,
} from './format.js';
export { scanId, shortHash, targetId } from './ids.js';
export {
  countEntries,
  emptyMeasurement,
  isDirectory,
  isWritable,
  type Measurement,
  type MeasureOptions,
  measureDirectory,
} from './measure.js';
export {
  buildPlan,
  formatPlanPreview,
  type PlanOptions,
  type PlanResult,
  planFromReport,
  summarizePlan,
} from './planner.js';
export {
  canonicalizeRoots,
  findContainingRoot,
  type GlobalCacheRoots,
  getDenylist,
  getGlobalCacheRoots,
  getHome,
  getLibraryDirNames,
  getPlatform,
  isProtectedPath,
  isProtectedResolvedPath,
  normalizeForCompare,
  pathFlavour,
  type SupportedPlatform,
} from './platform.js';
export { getToolVersion, mapWithConcurrency, scan, summarizeScan } from './scanner.js';
export * from './types.js';
