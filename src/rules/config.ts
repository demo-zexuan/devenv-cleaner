/**
 * Configuration Loading, Validation and Defaults
 *
 * Locates, validates and resolves `dvc.config.json` into the single
 * `ResolvedConfig` the scanner, the planner and the reporters consume.
 *
 * I. Why this is one module
 *
 * 1. Discovery, validation and defaulting are three views of the same decision:
 *    which file wins, whether it is well formed, and what it means once the
 *    gaps are filled. Splitting them would let `dvc config validate` and the
 *    scanner disagree about one file, which a config system must never do.
 * 2. `resolveConfig` is pure apart from `process.cwd()`, so a report can echo
 *    the exact configuration that produced it and stay reproducible.
 *
 * II. Precedence
 *
 * 1. Exactly one file is used — nothing is deep-merged across layers, because
 *    "which rules am I actually running?" has to stay answerable.
 * 2. Search order, highest precedence first:
 *    (1) `<cwd>/dvc.config.json`
 *    (2) each ancestor of `cwd`, nearest first, up to the filesystem root
 *    (3) `${XDG_CONFIG_HOME:-~/.config}/devenvclean/config.json`
 *        (`%APPDATA%/devenvclean/config.json` on Windows)
 *    (4) `~/.dvc.config.json`
 * 3. CLI flags are layered on by the command layer *after* this module
 *    returns, so a flag always beats the file.
 *
 * III. Validation contract
 *
 * 1. Bad user input never throws out of `parseUserConfig`: it returns messages
 *    that name the offending key and the shape that was expected.
 * 2. Out-of-range numbers are clamped rather than rejected. A user who writes
 *    `maxDepth: 200` means "very deep", and failing the whole run over a number
 *    that can be bounded safely would be user-hostile. The clamp is reported by
 *    `loadConfig` and `validateConfigFile` through `warnings`.
 * 3. `loadConfig` is the one function here that throws, because its signature
 *    has no error channel; the command layer turns that throw into exit code 1.
 *
 * @module rules/config
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { ECOSYSTEMS } from '../core/detector.js';
import type { SupportedPlatform } from '../core/platform.js';
import {
  findContainingRoot,
  getGlobalCacheRoots,
  getHome,
  getPlatform,
  normalizeForCompare,
} from '../core/platform.js';
import type {
  ResolvedConfig,
  ResolvedConfigSnapshot,
  ResolvedLimits,
  RiskLevel,
  UserConfig,
} from '../core/types.js';
import { SCHEMA_VERSION } from '../core/types.js';
import { indexRules } from './builtin.js';

// ===========================================================================
// I. Constants
// ===========================================================================

/** Name of the configuration file, at every level of the search path. */
export const CONFIG_FILE_NAME = 'dvc.config.json';

/**
 * Numeric guard rails applied when the user does not override them.
 *
 * I. Rationale
 *
 * 1. `highRiskBytes` is 5 GiB: above it a single deletion deserves a deliberate
 *    confirmation, not a bulk-select default.
 * 2. `lightNodeModulesEntries` is 500 — the entry count below which a
 *    `node_modules` is treated as a stub rather than a real install.
 * 3. `concurrency` is 24, which keeps the size walker inside the libuv thread
 *    pool without starving the event loop that drives the TUI.
 * 4. `maxDirectories` is the runaway guard for a scan aimed at a filesystem
 *    root by mistake.
 */
export const DEFAULT_LIMITS: ResolvedLimits = {
  highRiskBytes: 5 * 1024 ** 3,
  lightNodeModulesEntries: 500,
  concurrency: 24,
  maxDirectories: 400_000,
};

/** Depth walked below each root when the file does not say. */
const DEFAULT_MAX_DEPTH = 6;

/** Minimum target size, 1 MiB, when the file does not say. */
const DEFAULT_MIN_SIZE_BYTES = 1_048_576;

/** Retention window default; the field is reserved and inert in v1. */
const DEFAULT_RETENTION_DAYS = 0;

/** Directory reports are written to, relative to where `dvc report` runs. */
const DEFAULT_REPORT_DIR = '.devenvclean';

/** Default report format. */
const DEFAULT_REPORT_FORMAT = 'json';

/** Risk levels a rule override may carry, tied to the `RiskLevel` union. */
const RISK_LEVELS = ['safe', 'low', 'medium', 'high'] as const satisfies readonly RiskLevel[];

/**
 * Inclusive bounds for one numeric configuration field.
 *
 * A `null` bound means "unbounded on that side"; integer fields are truncated
 * before the bounds are applied so `maxDepth: 6.9` becomes 6 rather than
 * leaking a fractional depth into the walker.
 */
interface NumericBound {
  /** Lowest accepted value, or null when there is no floor. */
  readonly min: number | null;
  /** Highest accepted value, or null when there is no ceiling. */
  readonly max: number | null;
  /** Whether a fractional value is truncated to an integer. */
  readonly integer: boolean;
  /** Value used when the field is absent or unusable. */
  readonly fallback: number;
}

/** Bounds for the top-level numeric fields. */
const TOP_LEVEL_BOUNDS: Readonly<Record<'maxDepth' | 'minSizeBytes' | 'retentionDays', NumericBound>> = {
  maxDepth: { min: 1, max: 32, integer: true, fallback: DEFAULT_MAX_DEPTH },
  minSizeBytes: { min: 0, max: null, integer: true, fallback: DEFAULT_MIN_SIZE_BYTES },
  retentionDays: { min: 0, max: 3650, integer: true, fallback: DEFAULT_RETENTION_DAYS },
};

/**
 * Bounds for every `limits` field.
 *
 * Keyed by `keyof ResolvedLimits` so the resolver, the clamp warnings and the
 * interface cannot drift apart: adding a limit without a bound is a type error.
 */
const LIMIT_BOUNDS: Readonly<Record<keyof ResolvedLimits, NumericBound>> = {
  highRiskBytes: { min: 1, max: null, integer: true, fallback: DEFAULT_LIMITS.highRiskBytes },
  lightNodeModulesEntries: {
    min: 1,
    max: 100_000,
    integer: true,
    fallback: DEFAULT_LIMITS.lightNodeModulesEntries,
  },
  concurrency: { min: 1, max: 128, integer: true, fallback: DEFAULT_LIMITS.concurrency },
  maxDirectories: { min: 1, max: 5_000_000, integer: true, fallback: DEFAULT_LIMITS.maxDirectories },
};

/** Limit keys in a stable order, so warnings are reported deterministically. */
const LIMIT_KEYS = Object.keys(LIMIT_BOUNDS) as readonly (keyof ResolvedLimits)[];

// ===========================================================================
// II. Schema
// ===========================================================================

/**
 * Shape of one rule override.
 *
 * I. Deliberate looseness
 *
 * 1. `minSizeBytes`, `olderThanDays` and `minEntries` are only type-checked for
 *    a non-negative number: these are per-rule thresholds where a large value
 *    is a legitimate way to say "practically never", so they are not clamped.
 * 2. The object is strict. A misspelled `reportonly` would otherwise be a
 *    silent no-op, and a silently ignored safety override is worse than a
 *    validation error.
 */
const ruleOverrideSchema = z.strictObject({
  enabled: z.boolean().optional(),
  risk: z.enum(RISK_LEVELS).optional(),
  minSizeBytes: z.number().min(0).optional(),
  olderThanDays: z.number().min(0).optional(),
  minEntries: z.number().min(0).optional(),
  extraPatterns: z.array(z.string().min(1)).optional(),
  reportOnly: z.boolean().optional(),
});

/**
 * Shape of the `limits` block.
 *
 * Only the type is checked here; the ranges live in {@link LIMIT_BOUNDS} and are
 * applied by `resolveConfig`, so an out-of-range value becomes a warning
 * instead of a hard failure.
 */
const limitsSchema = z.strictObject({
  highRiskBytes: z.number().optional(),
  lightNodeModulesEntries: z.number().optional(),
  concurrency: z.number().optional(),
  maxDirectories: z.number().optional(),
});

/** Shape of one ecosystem toggle. */
const ecosystemSchema = z.strictObject({ enabled: z.boolean().optional() });

/** Shape of the `report` block. */
const reportSchema = z.strictObject({
  dir: z.string().min(1).optional(),
  format: z.enum(['json', 'markdown']).optional(),
});

/**
 * The complete `dvc.config.json` schema.
 *
 * I. Strictness
 *
 * 1. Every object in the file is strict, so an unknown key is reported by name
 *    rather than ignored. A typo in a protection setting must never be silent.
 * 2. Numeric fields are accepted as plain numbers on purpose: range handling is
 *    clamping (see {@link resolveNumber}), not rejection.
 */
const userConfigSchema = z.strictObject({
  schemaVersion: z.number().optional(),
  roots: z.array(z.string().min(1)).optional(),
  maxDepth: z.number().optional(),
  minSizeBytes: z.number().optional(),
  whitelist: z.array(z.string().min(1)).optional(),
  retentionDays: z.number().optional(),
  rules: z.record(z.string(), ruleOverrideSchema).optional(),
  limits: limitsSchema.optional(),
  ecosystems: z.record(z.string(), ecosystemSchema).optional(),
  report: reportSchema.optional(),
});

/**
 * Validate raw JSON as a `UserConfig`.
 *
 * @param raw - Parsed JSON, or anything else a caller happens to hold.
 * @param sourcePath - File the value came from, used to prefix messages; null
 *   for a value that was assembled in memory.
 * @returns The validated config, or the list of human-readable errors.
 *
 * @example
 * ```ts
 * parseUserConfig({ maxDepth: 'deep' }, '/repo/dvc.config.json')
 * // { ok: false, errors: ['/repo/dvc.config.json: maxDepth: Invalid input: expected number, received string'] }
 * ```
 */
export function parseUserConfig(
  raw: unknown,
  sourcePath: string | null,
): { ok: true; config: UserConfig } | { ok: false; errors: string[] } {
  const prefix = sourcePath === null ? '' : `${sourcePath}: `;

  // I. The root must be a JSON object. Reporting one clear message beats a wall
  //    of per-field type errors produced by a file that is not an object at all.
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [`${prefix}(root): expected a JSON object, received ${describeValue(raw)}`],
    };
  }

  // II. Structural validation. `safeParse` never throws, so a hostile or
  //     truncated file costs a message rather than a stack trace.
  const result = userConfigSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => formatIssue(issue.path, issue.message, prefix)),
    };
  }

  // III. The inferred shape is structurally identical to `UserConfig`; the
  //      mutable arrays and records it produces satisfy the readonly contract.
  return { ok: true, config: result.data };
}

// ===========================================================================
// III. Resolution
// ===========================================================================

/**
 * The built-in configuration: defaults for everything, no source file.
 *
 * @returns A resolved config equivalent to running with no file at all.
 */
export function getDefaultConfig(): ResolvedConfig {
  return resolveConfig({}, null);
}

/**
 * Merge user values over the built-in defaults.
 *
 * I. Merge order
 *
 * 1. Built-in defaults first, then every field the user supplied. A field the
 *    user omitted keeps its default; one they set wins outright — there is no
 *    deep merge of nested objects, except that `limits` and `ecosystems` are
 *    merged key by key so a partial block stays usable.
 *
 * II. Path handling
 *
 * 1. A leading `~` is expanded in `roots`, `whitelist` and `report.dir`.
 * 2. A relative `roots` or `whitelist` entry is resolved against the directory
 *    of the file that declared it, so the same file means the same tree no
 *    matter which directory the tool is launched from. `report.dir` is left as
 *    written (apart from `~`) because reports are written relative to the
 *    working directory, not to the config file.
 * 3. Duplicate entries are dropped, keeping the first occurrence, because two
 *    identical roots would double every target in a report.
 *
 * III. Numbers
 *
 * 1. Every numeric field is clamped by {@link resolveNumber} against the bound
 *    tables above; {@link collectClampWarnings} reports the same clamps later,
 *    so resolution and warnings always agree.
 *
 * @param user - Validated user configuration.
 * @param sourcePath - File the config came from, or null for pure defaults.
 * @returns The configuration the engine actually consumes.
 */
export function resolveConfig(user: UserConfig, sourcePath: string | null): ResolvedConfig {
  // I. Relative paths are anchored to the declaring file's directory.
  const baseDirectory = sourcePath === null ? process.cwd() : dirname(sourcePath);
  const roots = resolvePathList(user.roots, baseDirectory);
  const whitelist = resolvePathList(user.whitelist, baseDirectory);

  // II. Clamp the limits block field by field. A partial `limits` object keeps
  //     the built-in value for every key it does not mention.
  const limits: ResolvedLimits = {
    highRiskBytes: resolveNumber(
      user.limits?.highRiskBytes,
      LIMIT_BOUNDS.highRiskBytes,
      'limits.highRiskBytes',
    ).value,
    lightNodeModulesEntries: resolveNumber(
      user.limits?.lightNodeModulesEntries,
      LIMIT_BOUNDS.lightNodeModulesEntries,
      'limits.lightNodeModulesEntries',
    ).value,
    concurrency: resolveNumber(user.limits?.concurrency, LIMIT_BOUNDS.concurrency, 'limits.concurrency')
      .value,
    maxDirectories: resolveNumber(
      user.limits?.maxDirectories,
      LIMIT_BOUNDS.maxDirectories,
      'limits.maxDirectories',
    ).value,
  };

  // III. The resolved object carries no `schemaVersion`: that field versions
  //      the *file*, while the resolver always implements the current contract.
  //      A file claiming another version is a warning (see
  //      `collectSoftWarnings`), never a silent switch of behaviour.
  return {
    sourcePath,
    roots: roots.length > 0 ? roots : [getHome()],
    maxDepth: resolveNumber(user.maxDepth, TOP_LEVEL_BOUNDS.maxDepth, 'maxDepth').value,
    minSizeBytes: resolveNumber(user.minSizeBytes, TOP_LEVEL_BOUNDS.minSizeBytes, 'minSizeBytes').value,
    whitelist,
    retentionDays: resolveNumber(user.retentionDays, TOP_LEVEL_BOUNDS.retentionDays, 'retentionDays').value,
    rules: { ...user.rules },
    limits,
    ecosystems: resolveEcosystems(user.ecosystems),
    report: resolveReport(user.report),
  };
}

// ===========================================================================
// IV. Discovery
// ===========================================================================

/**
 * Every path that is searched for a configuration file, in precedence order.
 *
 * I. Order
 *
 * 1. `<cwd>/dvc.config.json` first, then each ancestor directory up to the
 *    filesystem root, nearest first — the nearest file wins.
 * 2. The per-user XDG location next, then the legacy `~/.dvc.config.json`.
 *
 * II. Deduplication
 *
 * 1. Paths are deduplicated with `normalizeForCompare`, which folds case on
 *    macOS and Windows where two spellings name one file. The first occurrence
 *    keeps its original spelling so messages stay readable.
 *
 * @param cwd - Directory the command was started in.
 * @returns Absolute candidate paths, highest precedence first.
 */
export function getConfigSearchPaths(cwd: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string): void => {
    const key = normalizeForCompare(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  // I. The working directory itself, then every ancestor up to the root.
  let current = resolve(cwd);
  push(join(current, CONFIG_FILE_NAME));
  for (;;) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    push(join(current, CONFIG_FILE_NAME));
  }

  // II. The per-user config directory, then the legacy home dotfile.
  push(join(xdgConfigDirectory(), 'devenvclean', 'config.json'));
  push(join(getHome(), `.${CONFIG_FILE_NAME}`));

  return candidates;
}

/**
 * Find the first existing configuration file for a working directory.
 *
 * A candidate only counts when it is a regular file; a directory that happens
 * to be named `dvc.config.json` must not be handed to the JSON reader.
 *
 * @param cwd - Directory the command was started in.
 * @returns The winning absolute path, or null when nothing was found.
 */
export async function findConfigFile(cwd: string): Promise<string | null> {
  for (const candidate of getConfigSearchPaths(cwd)) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

// ===========================================================================
// V. Loading
// ===========================================================================

/**
 * Load, validate and resolve the configuration for a run.
 *
 * I. Failure model
 *
 * 1. A missing file anywhere in the search path is not a failure: the built-in
 *    defaults are a complete configuration.
 * 2. An explicit `--config` path that does not exist *is* a failure — the user
 *    named a file, so silently falling back would hide their mistake.
 * 3. A file that cannot be read, parsed or validated throws. This is the only
 *    throwing function in the module because the signature has no error
 *    channel; the command layer catches it and exits non-zero.
 *
 * II. Warnings
 *
 * 1. Only clamp warnings are returned here. The advisory checks that need to
 *    stat the filesystem (roots that do not exist, a whitelist entry outside
 *    every root) belong to `dvc config validate`, and `validateConfigFile`
 *    runs them explicitly.
 *
 * @param options - Working directory and an optional explicit config path.
 * @param options.cwd - Directory used for config discovery.
 * @param options.explicitPath - `--config` value; relative paths resolve
 *   against `cwd`, not the process working directory.
 * @returns The resolved config plus clamp warnings.
 * @throws When the chosen file cannot be read, parsed or validated.
 */
export async function loadConfig(options: {
  cwd: string;
  explicitPath?: string | null;
}): Promise<{ config: ResolvedConfig; warnings: string[] }> {
  const explicitPath = options.explicitPath ?? null;
  const sourcePath =
    explicitPath === null
      ? await findConfigFile(options.cwd)
      : resolve(options.cwd, expandTilde(explicitPath));

  // I. No file anywhere: defaults are a complete, valid configuration.
  if (sourcePath === null) return { config: getDefaultConfig(), warnings: [] };

  // II. A named or discovered file must be usable.
  const raw = await readJsonFile(sourcePath);
  const parsed = parseUserConfig(raw, sourcePath);
  if (!parsed.ok) {
    const details = parsed.errors.map((error) => `  - ${error}`).join('\n');
    throw new Error(`invalid configuration in ${sourcePath}:\n${details}`);
  }

  return {
    config: resolveConfig(parsed.config, sourcePath),
    warnings: collectClampWarnings(parsed.config),
  };
}

// ===========================================================================
// VI. Snapshot and scaffolding
// ===========================================================================

/**
 * Project a resolved config down to the plain data a report may echo.
 *
 * I. Why a projection and not the live object
 *
 * 1. A report is a durable artifact; it must never embed a runtime-only field.
 *    The snapshot keeps exactly the values needed to explain a scan.
 * 2. `lockedRules` has no configuration source in v1 — a target's lock is
 *    decided at scan time — so it is always empty. It stays in the contract so
 *    report consumers never have to guess whether the field exists.
 * 3. `disabledRules` and `ecosystems` are both sorted, because a report is
 *    diffed byte for byte and an unsorted list would make two identical runs
 *    look different.
 *
 * @param config - Live resolved configuration.
 * @returns The JSON-safe snapshot embedded in `ScanReport.config`.
 */
export function toConfigSnapshot(config: ResolvedConfig): ResolvedConfigSnapshot {
  const disabledRules = Object.keys(config.rules)
    .filter((ruleId) => config.rules[ruleId]?.enabled === false)
    .sort();
  const ecosystems = Object.keys(config.ecosystems)
    .filter((ecosystemId) => config.ecosystems[ecosystemId]?.enabled === true)
    .sort();

  return {
    sourcePath: config.sourcePath,
    minSizeBytes: config.minSizeBytes,
    maxDepth: config.maxDepth,
    disabledRules,
    whitelist: [...config.whitelist],
    lockedRules: [],
    ecosystems,
    limits: { ...config.limits },
  };
}

/**
 * Build the minimal configuration object `dvc config init` writes out.
 *
 * I. Why the file is small
 *
 * 1. Only the settings a user is expected to edit are emitted; everything else
 *    stays implicit so an upgrade that changes a default is picked up instead
 *    of being frozen into a stale scaffold.
 * 2. `whitelist` is pre-seeded with the machine-global stores that must never
 *    be deleted file by file: the pnpm content store (deleting it orphans every
 *    existing `node_modules` link), the Maven local repository (offline builds
 *    stop working), Xcode DerivedData, and the two report-only locations the
 *    catalog refuses to delete anyway — Xcode Archives and the Docker image
 *    store. Seeding them means a user who edits this file starts from the safe
 *    set instead of having to discover it.
 * 3. `roots` is empty on purpose: an empty list means "the home directory",
 *    which is the honest default for a machine-wide cleanup tool.
 *
 * @param config - Resolved configuration whose tuned values seed the scaffold.
 * @returns A `UserConfig` that round-trips through {@link parseUserConfig}.
 */
export function serializeConfig(config: ResolvedConfig): UserConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    roots: [],
    maxDepth: config.maxDepth,
    minSizeBytes: config.minSizeBytes,
    retentionDays: config.retentionDays,
    whitelist: dangerousCacheRoots(),
    rules: {},
  };
}

// ===========================================================================
// VII. File validation
// ===========================================================================

/**
 * Validate one configuration file and report both errors and warnings.
 *
 * I. Errors versus warnings
 *
 * 1. Errors mean the file cannot be used: unreadable, not JSON, or structurally
 *    invalid. `ok` is false and no warnings are reported.
 * 2. Warnings mean the file works but says something questionable. The file is
 *    usable, `ok` stays true, and never blocks a run — matching the contract
 *    that a `schemaVersion` mismatch warns instead of failing.
 *
 * II. Advisory checks
 *
 * 1. A missing or mismatched `schemaVersion`.
 * 2. A `rules` key that no built-in rule defines, which would silently do
 *    nothing.
 * 3. A `roots` entry that does not exist, which yields an empty scan.
 * 4. A `whitelist` entry outside every root, which can never match a target.
 *
 * @param path - Path to the file, relative to the process working directory or
 *   absolute.
 * @returns Whether the file is usable, plus errors and warnings.
 */
export async function validateConfigFile(
  path: string,
): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const filePath = resolve(path);

  // I. Read and parse. A file that is not readable or not JSON has no warnings
  //    to report — there is nothing to reason about.
  let raw: unknown;
  try {
    raw = await readJsonFile(filePath);
  } catch (error) {
    return { ok: false, errors: [errorMessage(error)], warnings: [] };
  }

  const parsed = parseUserConfig(raw, filePath);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [] };

  // II. Structurally valid: everything below is advisory.
  const config = resolveConfig(parsed.config, filePath);
  const warnings = [
    ...collectClampWarnings(parsed.config),
    ...(await collectSoftWarnings(parsed.config, config)),
  ];
  return { ok: true, errors: [], warnings };
}

// ===========================================================================
// VIII. Private helpers
// ===========================================================================

/** A clamped numeric field together with the warning it produced, if any. */
interface ResolvedNumber {
  /** The value after fallback, truncation and clamping. */
  readonly value: number;
  /** Human-readable clamp report, or null when nothing was changed. */
  readonly warning: string | null;
}

/**
 * Clamp one numeric field into its supported range.
 *
 * I. Rules
 *
 * 1. Absent means "use the default", silently: absence is not a mistake.
 * 2. A non-finite value (`Infinity` from a hand-edited or generated file) is
 *    unusable, so it falls back and says so.
 * 3. A value outside the range is clamped and reported with the field path, so
 *    the message can be shown verbatim without extra context.
 * 4. A fractional value for an integer field is truncated and reported only
 *    when truncation actually changed it.
 *
 * @param raw - Value as written by the user, or undefined.
 * @param bound - Bounds for this field.
 * @param fieldPath - Dotted path used in the warning message.
 * @returns The value to use and an optional warning.
 */
function resolveNumber(raw: number | undefined, bound: NumericBound, fieldPath: string): ResolvedNumber {
  if (raw === undefined) return { value: bound.fallback, warning: null };

  if (!Number.isFinite(raw)) {
    return {
      value: bound.fallback,
      warning: `${fieldPath}: ${String(raw)} is not a finite number; using ${bound.fallback}`,
    };
  }

  const value = bound.integer ? Math.trunc(raw) : raw;

  // I. The lower bound is reported before the upper one: a negative value is a
  //    different mistake from an oversized one, and only one can be true.
  if (bound.min !== null && value < bound.min) {
    return {
      value: bound.min,
      warning: `${fieldPath}: ${raw} is below the minimum ${bound.min}; using ${bound.min}`,
    };
  }

  if (bound.max !== null && value > bound.max) {
    return {
      value: bound.max,
      warning: `${fieldPath}: ${raw} is above the maximum ${bound.max}; using ${bound.max}`,
    };
  }

  if (value !== raw) {
    return { value, warning: `${fieldPath}: ${raw} is not an integer; using ${value}` };
  }

  return { value, warning: null };
}

/**
 * Collect the clamp warnings for a validated user config.
 *
 * Re-runs the same bound tables the resolver uses, so a clamp can never be
 * applied without being reported, or reported without being applied.
 *
 * @param user - Validated user configuration.
 * @returns One warning per clamped field, in a stable order.
 */
function collectClampWarnings(user: UserConfig): string[] {
  const warnings: string[] = [];

  appendWarning(warnings, resolveNumber(user.maxDepth, TOP_LEVEL_BOUNDS.maxDepth, 'maxDepth').warning);
  appendWarning(
    warnings,
    resolveNumber(user.minSizeBytes, TOP_LEVEL_BOUNDS.minSizeBytes, 'minSizeBytes').warning,
  );
  appendWarning(
    warnings,
    resolveNumber(user.retentionDays, TOP_LEVEL_BOUNDS.retentionDays, 'retentionDays').warning,
  );

  for (const key of LIMIT_KEYS) {
    appendWarning(warnings, resolveNumber(user.limits?.[key], LIMIT_BOUNDS[key], `limits.${key}`).warning);
  }

  return warnings;
}

/**
 * Collect advisory findings that need the resolved config and the filesystem.
 *
 * @param user - Validated user configuration, as written.
 * @param config - The resolved configuration.
 * @returns Warning messages in check order.
 */
async function collectSoftWarnings(user: UserConfig, config: ResolvedConfig): Promise<string[]> {
  const warnings: string[] = [];

  // I. Contract drift warns but never blocks: the file still parses as long as
  //    the fields it uses are known ones.
  if (user.schemaVersion === undefined) {
    warnings.push(`schemaVersion: not set; the current report contract version is ${SCHEMA_VERSION}`);
  } else if (user.schemaVersion !== SCHEMA_VERSION) {
    warnings.push(
      `schemaVersion: ${user.schemaVersion} differs from the current report contract ${SCHEMA_VERSION}`,
    );
  }

  // II. An override for an id no rule defines silently does nothing, which is
  //     exactly the quiet no-op a user needs told about.
  const catalog = indexRules();
  for (const ruleId of Object.keys(user.rules ?? {}).sort()) {
    if (!catalog.has(ruleId)) {
      warnings.push(`rules.${ruleId}: unknown rule id; the built-in catalog defines no such rule`);
    }
  }

  // III. A root that does not exist yields an empty scan, so it is reported
  //      before the user waits on one.
  for (const [index, root] of config.roots.entries()) {
    if (!(await pathExists(root))) warnings.push(`roots[${index}]: "${root}" does not exist on disk`);
  }

  // IV. A whitelist entry outside every root can never match a target; the user
  //     almost always meant to protect something inside a scan root.
  for (const [index, entry] of config.whitelist.entries()) {
    if (findContainingRoot(entry, config.roots) === null) {
      warnings.push(`whitelist[${index}]: "${entry}" is outside every configured root`);
    }
  }

  return warnings;
}

/** Append a warning when there is one. */
function appendWarning(warnings: string[], warning: string | null): void {
  if (warning !== null) warnings.push(warning);
}

/**
 * Render one zod issue as `<path>: <message>`.
 *
 * @param path - Issue path segments; empty for the document root.
 * @param message - Zod's message, which names the expected shape.
 * @param prefix - Optional source-file prefix.
 * @returns A single-line, human-readable error.
 */
function formatIssue(path: readonly PropertyKey[], message: string, prefix: string): string {
  const fieldPath = path.length === 0 ? '(root)' : path.map((segment) => String(segment)).join('.');
  return `${prefix}${fieldPath}: ${message}`;
}

/** Name the type of a non-object config root for the rejection message. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Expand a leading `~` to the current user's home directory.
 *
 * Only a leading `~` (alone, or followed by a separator) is expanded; a path
 * such as `~/backup~` keeps its literal tail.
 *
 * @param value - Path as written in the config.
 * @returns The path with `~` resolved.
 */
function expandTilde(value: string): string {
  if (value === '~') return getHome();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(getHome(), value.slice(2));
  return value;
}

/**
 * Expand and absolutize one path entry.
 *
 * @param value - Path as written in the config.
 * @param baseDirectory - Directory relative paths resolve against.
 * @returns An absolute, normalized path.
 */
function resolvePathEntry(value: string, baseDirectory: string): string {
  return resolve(baseDirectory, expandTilde(value));
}

/**
 * Expand and deduplicate a list of path entries, keeping the first spelling.
 *
 * @param values - Entries as written, or undefined.
 * @param baseDirectory - Directory relative paths resolve against.
 * @returns Absolute paths in their original order.
 */
function resolvePathList(values: readonly string[] | undefined, baseDirectory: string): string[] {
  if (values === undefined || values.length === 0) return [];

  const resolvedEntries: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const absolute = resolvePathEntry(value, baseDirectory);
    const key = normalizeForCompare(absolute);
    if (seen.has(key)) continue;
    seen.add(key);
    resolvedEntries.push(absolute);
  }

  return resolvedEntries;
}

/**
 * Resolve the ecosystem enablement map.
 *
 * I. Merge semantics
 *
 * 1. Every ecosystem the detector knows starts enabled, so the default is
 *    all-on and a config only ever has to name what it turns off.
 * 2. A user entry overrides its ecosystem; an entry for an id the detector does
 *    not know is kept verbatim rather than silently dropped, so `dvc config
 *    show` echoes exactly what was written.
 *
 * @param overrides - User toggles, or undefined.
 * @returns Enablement flags for every ecosystem.
 */
function resolveEcosystems(
  overrides: Readonly<Record<string, { readonly enabled?: boolean }>> | undefined,
): Readonly<Record<string, { enabled: boolean }>> {
  const resolved: Record<string, { enabled: boolean }> = {};

  for (const ecosystem of ECOSYSTEMS) resolved[ecosystem.id] = { enabled: true };
  for (const [id, override] of Object.entries(overrides ?? {}))
    resolved[id] = { enabled: override.enabled ?? true };

  return resolved;
}

/**
 * Resolve the report block.
 *
 * `~` is expanded but a relative `dir` is left relative: reports are written
 * relative to the working directory, unlike scan roots.
 *
 * @param report - User report settings, or undefined.
 * @returns The resolved report directory and format.
 */
function resolveReport(report: UserConfig['report']): { dir: string; format: 'json' | 'markdown' } {
  const dir = report?.dir === undefined ? DEFAULT_REPORT_DIR : expandTilde(report.dir);
  return { dir, format: report?.format ?? DEFAULT_REPORT_FORMAT };
}

/**
 * The per-user configuration directory for this platform.
 *
 * I. Precedence
 *
 * 1. `$XDG_CONFIG_HOME` wins whenever it is set and non-empty, on every
 *    platform, because a user who sets it means it.
 * 2. Windows falls back to `%APPDATA%` (the roaming profile), not `~/.config`.
 * 3. Everything else falls back to `~/.config`.
 *
 * @returns An absolute directory path; the caller appends the file name.
 */
function xdgConfigDirectory(): string {
  const xdgHome = process.env.XDG_CONFIG_HOME;
  if (xdgHome !== undefined && xdgHome.trim().length > 0) return resolve(expandTilde(xdgHome));

  if (getPlatform() === 'win32') {
    const appData = process.env.APPDATA;
    if (appData !== undefined && appData.trim().length > 0) return resolve(expandTilde(appData));
    return join(getHome(), 'AppData', 'Roaming');
  }

  return join(getHome(), '.config');
}

/**
 * The machine-global cache locations that must not be deleted file by file.
 *
 * I. Selection
 *
 * 1. The pnpm content store and the Maven local repository are the two global
 *    caches the catalog marks `high` risk: deleting them breaks every linked
 *    `node_modules` and every offline build respectively.
 * 2. Xcode DerivedData is the largest rebuildable macOS directory, and the
 *    Xcode archive and Docker locations are the catalog's `reportOnly` rules —
 *    the exact places a generic deleter must refuse to touch.
 *
 * @param platform - Target platform; defaults to the host platform.
 * @returns Absolute whitelist entries, deduplicated, empty strings dropped.
 */
function dangerousCacheRoots(platform: SupportedPlatform = getPlatform()): string[] {
  const caches = getGlobalCacheRoots(platform);
  const candidates = [
    caches.pnpm,
    caches.maven,
    caches.xcodeDerivedData,
    ...xcodeArchivePaths(platform),
    ...dockerDataPaths(platform),
  ];

  const entries: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    const key = normalizeForCompare(candidate, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(candidate);
  }

  return entries;
}

/**
 * Xcode archive locations, mirroring the `global-xcode-archives` report-only
 * rule. Archives only exist on macOS, so other platforms contribute nothing.
 *
 * @param platform - Target platform.
 * @returns Absolute archive directories.
 */
function xcodeArchivePaths(platform: SupportedPlatform): string[] {
  if (platform !== 'darwin') return [];
  return [join(getHome(), 'Library', 'Developer', 'Xcode', 'Archives')];
}

/**
 * Docker data locations, mirroring the `global-docker-report` report-only rule.
 *
 * Docker Desktop keeps its VM disk under `~/Library` on macOS and under
 * `AppData` on Windows; a native Linux daemon stores images in `/var/lib/docker`.
 *
 * @param platform - Target platform.
 * @returns Absolute Docker data directories.
 */
function dockerDataPaths(platform: SupportedPlatform): string[] {
  if (platform === 'darwin') {
    return [join(getHome(), 'Library', 'Containers', 'com.docker.docker', 'Data', 'vms')];
  }
  if (platform === 'win32') return [join(getHome(), 'AppData', 'Local', 'Docker')];
  return ['/var/lib/docker'];
}

/**
 * Read and parse a JSON file.
 *
 * @param filePath - Absolute path to read.
 * @returns The parsed value, untouched by schema validation.
 * @throws When the file is missing, unreadable or not valid JSON.
 */
async function readJsonFile(filePath: string): Promise<unknown> {
  let text: string;

  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    // I. A missing file is the one failure a caller can act on, so it gets a
    //    dedicated message instead of a wrapped errno.
    if (errorCode(error) === 'ENOENT') throw new Error(`configuration file not found: ${filePath}`);
    throw new Error(`cannot read configuration file ${filePath}: ${errorMessage(error)}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`configuration file is not valid JSON: ${filePath}: ${errorMessage(error)}`);
  }
}

/** Test whether a path exists, of any kind. */
async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Test whether a path exists and is a regular file. */
async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** Extract an errno-style code from an unknown thrown value. */
function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** Render an unknown thrown value as a message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
