/**
 * Shared Test Fixtures and Builders
 *
 * Provides the filesystem fixture lifecycle and the in-memory contract builders
 * every DevEnvClean test file shares, so a fixture is created and destroyed the
 * same way everywhere.
 *
 * I. Why fixtures live inside the workspace
 *
 * 1. On macOS `/tmp` is a symlink to `/private/tmp`, and `/private` is on the
 *    built-in path denylist. A fixture built under `os.tmpdir()` therefore lands
 *    on a path the product is *designed* to refuse, so every executor test would
 *    fail for the wrong reason. Fixtures are created under `tests/.fixtures/`
 *    instead, which is an ordinary directory below the scan root's home and is
 *    not part of the product's denylist.
 * 2. `afterEach` removes the tree unconditionally, including after a failed
 *    assertion, so a red run never leaves a directory behind.
 *
 * II. Why the builders exist
 *
 * 1. `CleanTarget`, `ScanReport` and `ResolvedConfig` have many required fields.
 *    Spelling them out per test buries the one field a test is actually about;
 *    a builder keeps each test's intent visible and its diff readable.
 * 2. The builders only fill defaults — they never encode a safety decision, so
 *    a test can always override the field under examination.
 *
 * @module tests/helpers
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  CleanPlan,
  CleanTarget,
  DetectedProject,
  ResolvedConfig,
  ResolvedConfigSnapshot,
  ResolvedLimits,
  ScanReport,
  ScanSummary,
} from '../src/core/types.js';
import { DEFAULT_LIMITS, resolveConfig } from '../src/rules/config.js';

/** Directory below which every filesystem fixture is created. */
export const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Repository root, derived from this module's own location. */
export const WORKSPACE_ROOT = dirname(TESTS_DIR);

/** Parent of every throwaway fixture tree. */
export const FIXTURE_PARENT = join(TESTS_DIR, '.fixtures');

/**
 * A stable, non-existent absolute base used by pure tests.
 *
 * Planner and report tests need absolute paths for containment and protection
 * math but never touch the disk, so they use paths under this prefix rather
 * than a real fixture directory.
 */
export const SAMPLE_ROOT = join(FIXTURE_PARENT, 'sample');

/** The default limits block, reused by the report builder. */
export const DEFAULT_LIMITS_SNAPSHOT: ResolvedLimits = { ...DEFAULT_LIMITS };

/**
 * Create a fresh, uniquely named fixture directory inside the workspace.
 *
 * @param label - Short prefix that makes a failing test's leftovers obvious.
 * @returns The canonical absolute path of the new directory.
 */
export async function createFixtureRoot(label = 'run'): Promise<string> {
  await mkdir(FIXTURE_PARENT, { recursive: true });
  const created = await mkdtemp(join(FIXTURE_PARENT, `${label}-`));
  // Return the canonical form so every comparison the product performs
  // (`realpath`-based containment) sees exactly the path the fixture reports.
  return realpath(created);
}

/**
 * Make a tree removable again, then delete it.
 *
 * I. Why permissions are restored first
 *
 * 1. The executor test that provokes a permission failure chmods a directory to
 *    `0o500`. Without restoring the mode, the cleanup itself would fail and the
 *    fixture would be left on disk — exactly the failure mode the test rules
 *    forbid. Restoration is best-effort: a directory that has already been
 *    deleted is not an error.
 *
 * @param directory - Fixture root to delete; missing is not an error.
 */
export async function removeFixtureRoot(directory: string): Promise<void> {
  await restorePermissions(directory);
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}

/** Recursively add owner write/execute permission, ignoring every failure. */
async function restorePermissions(directory: string): Promise<void> {
  try {
    const handle = await readdir(directory, { withFileTypes: true });
    for (const entry of handle) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await restorePermissions(join(directory, entry.name));
      }
    }
  } catch {
    // An unreadable directory cannot be walked; the chmod below still applies.
  }
  try {
    await chmod(directory, 0o700);
  } catch {
    // Already gone, or owned by another user; `rm` below reports the real state.
  }
}

/**
 * Write a file of exactly `size` bytes, creating parents as needed.
 *
 * The content is a deterministic repeating byte pattern rather than a sparse
 * hole, so the file's logical size and its allocated blocks agree and a size
 * assertion cannot be satisfied by a filesystem optimisation.
 *
 * @param filePath - Destination file.
 * @param size - Number of bytes to write.
 * @returns The destination path, for chaining.
 */
export async function writeBytesFile(filePath: string, size: number): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  const buffer = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) buffer[index] = index % 251;
  await writeFile(filePath, buffer);
  return filePath;
}

/**
 * Write a small UTF-8 file, creating parents as needed.
 *
 * @param filePath - Destination file.
 * @param contents - Text to write.
 * @returns The destination path, for chaining.
 */
export async function writeTextFile(filePath: string, contents: string): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
  return filePath;
}

/** One entry in a tree snapshot. */
export interface TreeEntry {
  /** `file`, `directory` or `symlink`. */
  readonly type: 'file' | 'directory' | 'symlink';
  /** Size in bytes as reported by `lstat`; 0 for directories. */
  readonly size: number;
  /** SHA-256 of the contents, present only for files and only when requested. */
  readonly hash?: string;
}

/**
 * Describe a directory tree as a path-keyed map.
 *
 * I. Why this is used instead of a raw `du`
 *
 * 1. "The dry run left the tree byte-identical" is a claim about structure and
 *    content, not just about total size: a swap of two equally sized files would
 *    satisfy a byte total. The map records each path's type and size, so a
 *    rename, a deletion or a replacement is all visible.
 * 2. Symbols links are recorded but never followed, matching the product's own
 *    guarantee; following one would make the snapshot depend on a directory the
 *    test does not own.
 *
 * @param directory - Root to walk; a missing root yields an empty map.
 * @param options - `hashContents` adds a SHA-256 per file.
 * @returns Relative path to entry description.
 */
export async function snapshotTree(
  directory: string,
  options: { readonly hashContents?: boolean } = {},
): Promise<Map<string, TreeEntry>> {
  const snapshot = new Map<string, TreeEntry>();

  async function walk(current: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const key = relative(directory, absolute);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        snapshot.set(key, { type: 'symlink', size: stats.size });
        continue;
      }
      if (stats.isDirectory()) {
        snapshot.set(key, { type: 'directory', size: 0 });
        await walk(absolute);
        continue;
      }
      const record: TreeEntry = { type: 'file', size: stats.size };
      snapshot.set(
        key,
        options.hashContents === true ? { ...record, hash: await hashFile(absolute) } : record,
      );
    }
  }

  await walk(directory);
  return snapshot;
}

/** SHA-256 a file's bytes, or `''` when it cannot be read. */
async function hashFile(filePath: string): Promise<string> {
  try {
    return createHash('sha256')
      .update(await readFile(filePath))
      .digest('hex');
  } catch {
    return '';
  }
}

/**
 * Create a symbolic link, replacing any existing entry at that path.
 *
 * @param linkPath - Path of the link to create.
 * @param targetPath - Path the link points at.
 */
export async function createSymlink(linkPath: string, targetPath: string): Promise<void> {
  await mkdir(dirname(linkPath), { recursive: true });
  await rm(linkPath, { recursive: true, force: true });
  await symlink(targetPath, linkPath);
}

/** True when the test process is privileged, which disables permission tests. */
export function isPrivilegedUser(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * Build a fully populated `CleanTarget`.
 *
 * @param overrides - Fields to replace.
 * @returns A target whose default path lives below {@link SAMPLE_ROOT}, so the
 *   built-in denylist and the default root containment both accept it.
 */
export function makeTarget(overrides: Partial<CleanTarget> = {}): CleanTarget {
  return {
    id: 'node-modules#0123456789abcdef',
    ruleId: 'node-modules',
    label: 'Node Dependencies',
    path: join(SAMPLE_ROOT, 'proj', 'node_modules'),
    projectPath: join(SAMPLE_ROOT, 'proj'),
    projectName: 'proj',
    layer: 'dependencies',
    kind: 'node_modules',
    scope: 'project',
    risk: 'low',
    bytes: 2_000_000,
    files: 10,
    mtimeMs: 1_700_000_000_000,
    ageDays: 30,
    locked: false,
    lockedReason: null,
    note: 're-installable',
    ...overrides,
  };
}

/**
 * Build a resolved configuration with the product's own defaults.
 *
 * @param overrides - Fields to replace after resolution.
 * @returns A configuration with every field present.
 */
export function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...resolveConfig({}, null), ...overrides };
}

/** Aggregate targets the way the scanner does, for report fixtures. */
function summarize(targets: readonly CleanTarget[]): ScanSummary {
  const layers = ['dependencies', 'build', 'cache', 'artifacts'] as const;
  const ruleIds = [...new Set(targets.map((target) => target.ruleId))];
  const ecosystemIds = [...new Set(targets.map((target) => target.projectPath ?? 'node'))];
  return {
    totalBytes: targets.reduce((sum, target) => sum + target.bytes, 0),
    reclaimableBytes: targets
      .filter((target) => !target.locked)
      .reduce((sum, target) => sum + target.bytes, 0),
    targetCount: targets.length,
    lockedCount: targets.filter((target) => target.locked).length,
    fileCount: targets.reduce((sum, target) => sum + target.files, 0),
    byLayer: layers.map((layer) => {
      const inLayer = targets.filter((target) => target.layer === layer);
      return {
        layer,
        targetCount: inLayer.length,
        bytes: inLayer.reduce((sum, target) => sum + target.bytes, 0),
        reclaimableBytes: inLayer
          .filter((target) => !target.locked)
          .reduce((sum, target) => sum + target.bytes, 0),
      };
    }),
    byRule: ruleIds.map((ruleId) => {
      const bucket = targets.filter((target) => target.ruleId === ruleId);
      return {
        ruleId,
        label: bucket[0]?.label ?? ruleId,
        layer: bucket[0]?.layer ?? 'cache',
        targetCount: bucket.length,
        bytes: bucket.reduce((sum, target) => sum + target.bytes, 0),
        reclaimableBytes: bucket
          .filter((target) => !target.locked)
          .reduce((sum, target) => sum + target.bytes, 0),
      };
    }),
    byEcosystem: ecosystemIds.map((id) => ({
      id,
      name: id,
      projectCount: 1,
      bytes: targets.reduce((sum, target) => sum + target.bytes, 0),
      reclaimableBytes: targets
        .filter((target) => !target.locked)
        .reduce((sum, target) => sum + target.bytes, 0),
    })),
    largestTargetBytes: targets.reduce((largest, target) => Math.max(largest, target.bytes), 0),
  };
}

/** The config snapshot embedded in a report fixture. */
export function makeConfigSnapshot(overrides: Partial<ResolvedConfigSnapshot> = {}): ResolvedConfigSnapshot {
  return {
    sourcePath: null,
    minSizeBytes: 0,
    maxDepth: 6,
    disabledRules: [],
    whitelist: [],
    lockedRules: [],
    ecosystems: ['node'],
    limits: { ...DEFAULT_LIMITS_SNAPSHOT },
    ...overrides,
  };
}

/**
 * Build a scan report whose summary is consistent with its targets.
 *
 * @param targets - Targets the report claims to have found.
 * @param overrides - Report-level fields to replace, e.g. `scannedAt` or `root`.
 * @returns A report that passes every structural assertion the product makes.
 */
export function makeReport(
  targets: readonly CleanTarget[] = [],
  overrides: Partial<ScanReport> = {},
): ScanReport {
  const projects: readonly DetectedProject[] = [
    {
      path: join(SAMPLE_ROOT, 'proj'),
      name: 'proj',
      ecosystems: ['node'],
      markers: ['package.json'],
      targetLabels: [...new Set(targets.map((target) => target.label))].sort(),
      bytes: targets.reduce((sum, target) => sum + target.bytes, 0),
    },
  ];
  return {
    schemaVersion: 1,
    toolVersion: '0.1.0',
    scannedAt: '2026-09-29T00:00:00.000Z',
    root: SAMPLE_ROOT,
    platform: process.platform,
    durationMs: 12,
    directoriesVisited: 8,
    skippedDirectories: 0,
    truncated: false,
    config: makeConfigSnapshot(),
    targets,
    projects,
    summary: summarize(targets),
    ...overrides,
  };
}

/**
 * Build a cleanup plan from a target list.
 *
 * @param targets - Actionable targets.
 * @param skipped - Targets the plan refuses to touch.
 * @returns A plan with the byte total already summed.
 */
export function makePlan(
  targets: readonly CleanTarget[] = [],
  skipped: readonly CleanTarget[] = [],
): CleanPlan {
  return {
    targets,
    totalBytes: targets.reduce((sum, target) => sum + target.bytes, 0),
    skipped,
    skipReasons: [],
  };
}
