/**
 * DevEnvClean Public API
 *
 * The library surface, for embedding the scanner in other tooling without
 * shelling out to the CLI.
 *
 * I. Stability
 *
 * 1. Everything re-exported here is part of the published contract and follows
 *    semantic versioning.
 * 2. Report-shaped values carry their own `schemaVersion`, which is versioned
 *    independently from the package, so a consumer that pins the package may
 *    still need to check the report schema.
 *
 * @module index
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

export {
  ALL_MARKER_NAMES,
  type DetectionResult,
  detectInEntries,
  ECOSYSTEMS,
  type EcosystemDefinition,
  type EcosystemId,
  ecosystemName,
  getEcosystem,
  type NodePackageManager,
} from './core/detector.js';
export {
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
} from './core/format.js';
export { scanId, shortHash, targetId } from './core/ids.js';
export { countEntries, isDirectory, isWritable, measureDirectory } from './core/measure.js';
export {
  findContainingRoot,
  getDenylist,
  getGlobalCacheRoots,
  getHome,
  getPlatform,
  isProtectedPath,
  normalizeForCompare,
} from './core/platform.js';
// II. Core engine.
export { getToolVersion, mapWithConcurrency, scan, summarizeScan } from './core/scanner.js';
// I. Data contract.
export * from './core/types.js';

// III. Rules.
export { BUILTIN_RULE_COUNT, BUILTIN_RULES, indexRules } from './rules/builtin.js';
export {
  type CompiledGlob,
  type CompiledRule,
  compileGlob,
  compileRules,
  dedupeNestedMatches,
  escalateRisk,
  isWhitelisted,
  LAYER_ORDER,
  type MatchOptions,
  matchTargets,
  type RawMatch,
  type RootMatchResult,
} from './rules/engine.js';
