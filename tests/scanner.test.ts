/**
 * Scan Orchestration and Directory Measurement
 *
 * Pins the end-to-end pipeline of `src/core/scanner.ts` — discover, dedupe,
 * measure, decide, aggregate — and the symlink-safety property of the size
 * walker it depends on.
 *
 * I. Why an end-to-end fixture rather than mocked modules
 *
 * 1. The properties that matter here are cross-module: a rule matches, a nested
 *    match is dropped, a size clears the floor, and a project is attributed. Each
 *    of those is asserted separately elsewhere; only a real tree proves they
 *    compose into the numbers the user is shown.
 * 2. `summary.totalBytes` is the headline claim of the whole product, so it is
 *    asserted against the sum of the targets actually reported, not against a
 *    number copied from the same code path.
 * 3. Fixtures are created under `tests/.fixtures/` — never `/tmp`, which on
 *    macOS is a symlink into the denylisted `/private` and would make every
 *    target look protected.
 *
 * @module tests/scanner
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isDirectory, measureDirectory } from '../src/core/measure.js';
import { canonicalizeRoots } from '../src/core/platform.js';
import { mapWithConcurrency, scan, summarizeScan } from '../src/core/scanner.js';
import { SCHEMA_VERSION, type ScanReport } from '../src/core/types.js';
import {
  createFixtureRoot,
  createSymlink,
  makeConfig,
  removeFixtureRoot,
  writeBytesFile,
  writeTextFile,
} from './helpers.js';

const MIB = 1024 * 1024;

let fixtureDir = '';
let projDir = '';

beforeEach(async () => {
  fixtureDir = await createFixtureRoot('scanner');
  projDir = join(fixtureDir, 'proj');
});

afterEach(async () => {
  await removeFixtureRoot(fixtureDir);
});

/** Plant a Node project whose two targets both clear the default size floor. */
async function buildNodeProject(directory: string): Promise<void> {
  await writeTextFile(join(directory, 'package.json'), '{"name":"proj","version":"1.0.0"}');
  // Two immediate entries so the node_modules rule's entry-count guard passes,
  // and enough real bytes to clear the 1 MiB default floor without a config
  // override — the floor is part of what is under test.
  await writeBytesFile(join(directory, 'node_modules', 'pkg-a', 'index.js'), 700 * 1024);
  await writeBytesFile(join(directory, 'node_modules', 'pkg-b', 'index.js'), 700 * 1024);
  await writeBytesFile(join(directory, 'dist', 'bundle.js'), 1.1 * MIB);
}

/** A target lookup helper that fails loudly when the rule produced nothing. */
function targetFor(report: ScanReport, ruleId: string) {
  const target = report.targets.find((candidate) => candidate.ruleId === ruleId);
  if (target === undefined) throw new Error(`no target produced by rule ${ruleId}`);
  return target;
}

describe('scan on an end-to-end Node project', () => {
  it('finds node_modules and dist, attributes them to the project and totals them exactly', async () => {
    await buildNodeProject(projDir);
    const roots = await canonicalizeRoots([projDir]);
    const report = await scan({ roots, config: makeConfig() });

    const nodeModules = targetFor(report, 'node-modules');
    const buildOutput = targetFor(report, 'node-build-output');

    expect(nodeModules.path).toBe(join(roots[0] ?? '', 'node_modules'));
    expect(nodeModules.bytes).toBe(700 * 1024 * 2);
    expect(nodeModules.layer).toBe('dependencies');
    expect(nodeModules.locked).toBe(false);
    expect(nodeModules.note).toBe('re-installable');

    expect(buildOutput.path).toBe(join(roots[0] ?? '', 'dist'));
    expect(buildOutput.layer).toBe('build');
    expect(buildOutput.locked).toBe(false);

    // The headline number is the sum of what was reported, computed here
    // independently of the summary implementation.
    const summed = report.targets.reduce((total, target) => total + target.bytes, 0);
    expect(report.summary.totalBytes).toBe(summed);
    expect(report.summary.targetCount).toBe(report.targets.length);
    expect(report.summary.lockedCount).toBe(0);
    expect(report.summary.reclaimableBytes).toBe(summed);
    expect(report.summary.largestTargetBytes).toBe(Math.max(...report.targets.map((t) => t.bytes)));
  });

  it('attributes both targets to the nearest project and names it', async () => {
    await buildNodeProject(projDir);
    const roots = await canonicalizeRoots([projDir]);
    const report = await scan({ roots, config: makeConfig() });

    for (const target of report.targets) {
      expect(target.projectPath).toBe(roots[0]);
      expect(target.projectName).toBe('proj');
      expect(target.scope).toBe('project');
    }
    expect(report.projects).toHaveLength(1);
    expect(report.projects[0]?.markers).toEqual(['package.json']);
    expect(report.projects[0]?.ecosystems).toEqual(['node']);
    expect(report.projects[0]?.bytes).toBe(report.summary.totalBytes);
    const labels = [...(report.projects[0]?.targetLabels ?? [])].sort();
    expect(labels).toEqual(['JS/TS Build Output', 'Node Dependencies']);
  });

  it('reports the contract metadata a consumer checks first', async () => {
    await buildNodeProject(projDir);
    const roots = await canonicalizeRoots([projDir]);
    const report = await scan({ roots, config: makeConfig() });

    expect(report.schemaVersion).toBe(SCHEMA_VERSION);
    expect(report.root).toBe(roots[0]);
    expect(report.platform).toBe(process.platform);
    expect(report.truncated).toBe(false);
    expect(report.skippedDirectories).toBe(0);
    expect(report.directoriesVisited).toBeGreaterThan(0);
    expect(report.config.ecosystems).toContain('node');
    expect(report.config.sourcePath).toBeNull();
    expect(summarizeScan(report)).toContain('reclaimable across');
  });

  it('counts a stub node_modules as too small instead of reporting it as dependencies', async () => {
    await writeTextFile(join(projDir, 'package.json'), '{"name":"proj"}');
    // A single entry and a few bytes: the entry-count guard must reject it.
    await writeBytesFile(join(projDir, 'node_modules', 'index.js'), 8);
    const roots = await canonicalizeRoots([projDir]);
    const report = await scan({ roots, config: makeConfig({ minSizeBytes: 0 }) });

    const stub = targetFor(report, 'node-modules');
    expect(stub.locked).toBe(true);
    expect(stub.lockedReason).toBe('too-small');
    expect(report.summary.reclaimableBytes).toBe(0);
    expect(report.summary.lockedCount).toBe(1);
  });

  it('does not descend into a version-control store', async () => {
    await buildNodeProject(projDir);
    // A node_modules buried inside .git is an implementation detail of a
    // repository, never a cleanup target, and walking it would burn the scan
    // budget on object storage.
    await writeBytesFile(join(projDir, '.git', 'modules', 'x', 'node_modules', 'a.js'), 4 * MIB);
    const roots = await canonicalizeRoots([projDir]);
    const report = await scan({ roots, config: makeConfig() });

    expect(report.targets.some((target) => target.path.includes('/.git/'))).toBe(false);
  });

  it('leaves an unlocked directory below the size floor locked', async () => {
    await buildNodeProject(projDir);
    const roots = await canonicalizeRoots([projDir]);
    // A floor above both targets' real sizes: both must appear, both locked,
    // because visibility of a too-small target is the point.
    const report = await scan({ roots, config: makeConfig({ minSizeBytes: 100 * MIB }) });
    expect(report.targets).toHaveLength(2);
    for (const target of report.targets) {
      expect(target.locked).toBe(true);
      expect(target.lockedReason).toBe('too-small');
    }
    expect(report.summary.reclaimableBytes).toBe(0);
  });
});

describe('scan does not double count nested matches', () => {
  it('reports only the outer node_modules and does not inflate the total', async () => {
    // THE DOUBLE-COUNTING PROPERTY:
    //
    //   `**/node_modules` matches both `proj/node_modules` and the nested
    //   `proj/node_modules/pkg/node_modules`. The nested one is physically
    //   inside the outer one, so reporting both would add its bytes twice and
    //   would name a directory that is about to disappear with its parent.
    await writeTextFile(join(projDir, 'package.json'), '{"name":"proj"}');
    await writeBytesFile(join(projDir, 'node_modules', 'index.js'), 1000);
    await writeBytesFile(join(projDir, 'node_modules', 'pkg', 'node_modules', 'inner.js'), 4000);
    const roots = await canonicalizeRoots([projDir]);
    // The floor is explicitly zero so the nested match would be actionable if
    // deduplication failed — the test must fail for the right reason.
    const report = await scan({ roots, config: makeConfig({ minSizeBytes: 0 }) });

    const matched = report.targets.filter((target) => target.ruleId === 'node-modules');
    expect(matched).toHaveLength(1);
    expect(matched[0]?.path).toBe(join(roots[0] ?? '', 'node_modules'));
    // 1000 + 4000 measured once, not 1000 + 4000 + 4000.
    expect(matched[0]?.bytes).toBe(5000);
    expect(report.summary.totalBytes).toBe(5000);
  });
});

describe('scan scope', () => {
  it('does not add machine-global targets to a scoped scan root', async () => {
    await buildNodeProject(projDir);
    const roots = await canonicalizeRoots([projDir]);
    const report = await scan({ roots, config: makeConfig() });
    // A project scan must never report the machine's caches: that would make
    // every project-level total meaningless.
    expect(report.targets.every((target) => target.scope === 'project')).toBe(true);
  });

  it('does not add them when the global probe is explicitly disabled', async () => {
    await buildNodeProject(projDir);
    const roots = await canonicalizeRoots([projDir]);
    const report = await scan({ roots, config: makeConfig(), includeGlobalTargets: false });
    expect(report.targets.some((target) => target.scope === 'global')).toBe(false);
  });

  it('returns an empty report instead of throwing when the signal is already aborted', async () => {
    await buildNodeProject(projDir);
    const roots = await canonicalizeRoots([projDir]);
    const report = await scan({ roots, config: makeConfig(), signal: AbortSignal.abort() });
    expect(report.targets).toEqual([]);
    expect(report.summary.totalBytes).toBe(0);
    expect(report.truncated).toBe(false);
  });

  it('skips a scan root that does not exist and counts it as skipped', async () => {
    const missing = join(fixtureDir, 'not-here');
    const report = await scan({ roots: [missing], config: makeConfig() });
    expect(report.skippedDirectories).toBe(1);
    expect(report.targets).toEqual([]);
    expect(report.summary.totalBytes).toBe(0);
  });
});

describe('measureDirectory symlink safety', () => {
  it('does not descend into a symlink and counts only the link itself', async () => {
    // SECURITY PROPERTY: following the link would both double count the linked
    // tree and escape the scan root, so the walker records the link's own
    // `lstat` size (the length of its target string) and stops there.
    const outside = join(fixtureDir, 'outside');
    await writeBytesFile(join(outside, 'huge.bin'), 512 * 1024);
    const root = join(fixtureDir, 'measured');
    await writeBytesFile(join(root, 'real.js'), 100);
    const link = join(root, 'linked');
    await createSymlink(link, outside);

    const measurement = await measureDirectory(root);

    expect(measurement.symlinks).toBe(1);
    expect(measurement.directories).toBe(1); // the root only: no descent
    expect(measurement.files).toBe(1); // real.js only
    const linkSize = (await lstat(link)).size;
    expect(linkSize).toBeGreaterThan(0);
    expect(measurement.bytes).toBe(100 + linkSize);
    // The linked tree's 512 KiB is nowhere in the total.
    expect(measurement.bytes).toBeLessThan(512 * 1024);
  });

  it('reports a symlink as not-a-directory so a plan never follows it', async () => {
    const outside = join(fixtureDir, 'outside');
    await writeBytesFile(join(outside, 'huge.bin'), 64);
    const link = join(fixtureDir, 'link');
    await createSymlink(link, outside);

    // `isDirectory` uses lstat, so the link itself never reads as a directory
    // even though the path resolves to one. That is the check the executor uses
    // to refuse a symlink swapped in after planning.
    expect(await isDirectory(link)).toBe(false);
    expect((await stat(link)).isDirectory()).toBe(true);
  });

  it('treats a missing path as an unreadable directory, and as nothing when told to tolerate it', async () => {
    const missing = join(fixtureDir, 'missing');
    // REPORTED FINDING (not fixed here): the JSDoc of `measureDirectory` says
    // the result is "empty when the path does not exist", but without
    // `tolerateMissing` the missing root is counted as one visited, unreadable
    // directory. The scanner always passes `tolerateMissing: true`, so the
    // divergence is currently invisible to the product; the assertions below
    // pin both branches rather than only the documented one.
    expect(await measureDirectory(missing)).toMatchObject({
      bytes: 0,
      files: 0,
      directories: 1,
      unreadable: 1,
    });
    expect(await measureDirectory(missing, { tolerateMissing: true })).toMatchObject({
      bytes: 0,
      files: 0,
      directories: 0,
      unreadable: 0,
      truncated: false,
    });
  });

  it('stops at the directory ceiling and reports the truncation', async () => {
    const root = join(fixtureDir, 'deep');
    await writeBytesFile(join(root, 'a', 'b', 'c', 'file.js'), 32);
    const measurement = await measureDirectory(root, { maxDirectories: 1 });
    expect(measurement.truncated).toBe(true);
    expect(measurement.files).toBe(0);
  });

  it('counts a deeply nested tree completely when no ceiling is set', async () => {
    const root = join(fixtureDir, 'deep');
    await writeBytesFile(join(root, 'a', 'b', 'c', 'file.js'), 32);
    expect(await measureDirectory(root)).toMatchObject({ bytes: 32, files: 1, directories: 4 });
  });
});

describe('mapWithConcurrency', () => {
  it('returns results in input order even when they finish out of order', async () => {
    const delays = [30, 1, 10];
    const results = await mapWithConcurrency([1, 2, 3], 3, async (item, index) => {
      await new Promise((resolve) => setTimeout(resolve, delays[index] ?? 0));
      return item * 10 + index;
    });
    expect(results).toEqual([10, 21, 32]);
  });

  it('handles an empty input and a non-positive bound', async () => {
    expect(await mapWithConcurrency([], 4, async (item: number) => item)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 0, async (item: number) => item * 2)).toEqual([2, 4]);
  });
});
