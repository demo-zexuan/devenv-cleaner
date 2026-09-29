/**
 * Plan Execution (the Destructive Path)
 *
 * Pins the behaviour of `src/core/executor.ts`: the last moment at which the
 * product can notice that the filesystem changed since the plan was built.
 *
 * I. Why every test here builds a real tree
 *
 * 1. The executor's contract is about *unlink semantics*: what survives, what
 *    disappears, and which number is reported as freed. A mock of `fs.rm` would
 *    assert the call shape and prove nothing about the property.
 * 2. The headline test encodes an attack rather than a feature: a directory is
 *    planned, then replaced with a symlink pointing at a canary directory
 *    outside the scan root. That is the exact sequence a hostile or merely
 *    careless process could perform between the preview the user confirmed and
 *    the unlink, and the only acceptable outcome is that the canary survives.
 *
 * II. Fixture hygiene
 *
 * 1. Every tree lives under `tests/.fixtures/` (never `/tmp`, which on macOS is
 *    a symlink into the denylisted `/private`) and is removed in `afterEach`,
 *    including after a failure.
 * 2. The permission test chmods a directory to `0o500`; the shared cleanup
 *    restores owner permissions before deleting, so a failure cannot leave an
 *    undeletable directory behind.
 *
 * @module tests/executor
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { chmod, lstat, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executePlan, formatExecutionSummary } from '../src/core/executor.js';
import { getPlatform } from '../src/core/platform.js';
import type { CleanOptions, CleanTarget, ResolvedConfig } from '../src/core/types.js';
import {
  createFixtureRoot,
  createSymlink,
  isPrivilegedUser,
  makeConfig,
  makePlan,
  makeTarget,
  removeFixtureRoot,
  snapshotTree,
  writeBytesFile,
} from './helpers.js';

let fixtureDir = '';
let projDir = '';
let canaryDir = '';
let config: ResolvedConfig;

beforeEach(async () => {
  fixtureDir = await createFixtureRoot('executor');
  projDir = join(fixtureDir, 'proj');
  canaryDir = join(fixtureDir, 'canary');
  // The root is deliberately the *project* directory, so anything beside it in
  // the fixture tree is outside every configured root — which is what makes the
  // symlink-escape test meaningful.
  config = makeConfig({ roots: [projDir], minSizeBytes: 0 });
});

afterEach(async () => {
  await removeFixtureRoot(fixtureDir);
});

/** A target whose path is `proj/<name>`. */
function targetFor(name: string, overrides: Partial<CleanTarget> = {}): CleanTarget {
  const path = join(projDir, name);
  return makeTarget({
    id: `node-modules#${name}`,
    path,
    projectPath: projDir,
    projectName: 'proj',
    ...overrides,
  });
}

/** Build the executor's options with sensible defaults for a real run. */
function optionsFor(plan: CleanOptions['plan'], overrides: Partial<CleanOptions> = {}): CleanOptions {
  return { plan, config, dryRun: false, ...overrides };
}

describe('executePlan dry run', () => {
  it('leaves the tree byte-identical and reports every target as a dry-run skip', async () => {
    const first = targetFor('node_modules');
    const second = targetFor('dist');
    await writeBytesFile(join(first.path, 'index.js'), 4096);
    await writeBytesFile(join(second.path, 'bundle.js'), 2048);

    const before = await snapshotTree(fixtureDir, { hashContents: true });
    const execution = await executePlan(optionsFor(makePlan([first, second]), { dryRun: true }));
    const after = await snapshotTree(fixtureDir, { hashContents: true });

    // Structure, sizes and content hashes must all be untouched.
    expect(Object.fromEntries(after)).toEqual(Object.fromEntries(before));
    expect(execution.results).toHaveLength(2);
    for (const result of execution.results) {
      expect(result.outcome).toBe('skipped');
      expect(result.skipReason).toBe('dry-run');
      expect(result.freedBytes).toBe(0);
      expect(result.error).toBeNull();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(execution.freedBytes).toBe(0);
    expect(execution.deletedCount).toBe(0);
    expect(execution.skippedCount).toBe(2);
    expect(execution.failedCount).toBe(0);
    expect(execution.driftedTargetIds).toEqual([]);
  });

  it('reports dry-run for a target that does not exist, because it never reads the disk', async () => {
    // "May I delete this right now" is never answered during a dry run, so a
    // missing directory must not be reported as a re-check failure.
    const missing = targetFor('gone');
    const execution = await executePlan(optionsFor(makePlan([missing]), { dryRun: true }));
    expect(execution.results[0]?.outcome).toBe('skipped');
    expect(execution.results[0]?.skipReason).toBe('dry-run');
  });
});

describe('executePlan real deletion', () => {
  it('deletes the directory and reports the freshly measured byte count', async () => {
    const target = targetFor('node_modules');
    await writeBytesFile(join(target.path, 'a.js'), 1000);
    await writeBytesFile(join(target.path, 'b.js'), 2000);
    await writeBytesFile(join(target.path, 'nested', 'c.js'), 3000);

    // The plan's claim is deliberately wrong: the reported number must come
    // from the pre-delete measurement, never from the plan.
    const execution = await executePlan(optionsFor(makePlan([{ ...target, bytes: 1 }])));

    expect(execution.results).toHaveLength(1);
    expect(execution.results[0]?.outcome).toBe('deleted');
    expect(execution.results[0]?.freedBytes).toBe(6000);
    expect(execution.freedBytes).toBe(6000);
    expect(execution.deletedCount).toBe(1);
    await expect(stat(target.path)).rejects.toThrow();
  });

  it('flags a target whose size moved beyond the drift tolerance', async () => {
    const drifted = targetFor('node_modules');
    const stable = targetFor('dist');
    await writeBytesFile(join(drifted.path, 'a.js'), 6000);
    await writeBytesFile(join(stable.path, 'b.js'), 1000);

    const execution = await executePlan(
      optionsFor(
        makePlan([
          { ...drifted, bytes: 1 },
          { ...stable, bytes: 1000 },
        ]),
      ),
    );

    // Both are deleted — the user confirmed a path, not a byte count — but the
    // surprising one is named so the caller can explain the shortfall.
    expect(execution.deletedCount).toBe(2);
    expect(execution.driftedTargetIds).toEqual([drifted.id]);
  });

  it('flags a target that the plan claimed was empty but which still held data', async () => {
    const target = targetFor('node_modules');
    await writeBytesFile(join(target.path, 'a.js'), 32);
    const execution = await executePlan(optionsFor(makePlan([{ ...target, bytes: 0 }])));
    expect(execution.driftedTargetIds).toEqual([target.id]);
  });

  it('skips a target whose directory disappeared before execution', async () => {
    const target = targetFor('node_modules');
    const execution = await executePlan(optionsFor(makePlan([target])));
    expect(execution.results[0]?.outcome).toBe('skipped');
    expect(execution.results[0]?.skipReason).toBe('missing');
    expect(execution.freedBytes).toBe(0);
  });

  it('skips a target that was replaced by a regular file', async () => {
    const target = targetFor('node_modules');
    await writeBytesFile(join(projDir, 'node_modules'), 64);
    const execution = await executePlan(optionsFor(makePlan([target])));
    expect(execution.results[0]?.outcome).toBe('skipped');
    expect(execution.results[0]?.skipReason).toBe('not-a-directory');
    // The substitute file itself is untouched.
    await expect(stat(join(projDir, 'node_modules'))).resolves.toBeDefined();
  });
});

describe('executePlan re-checks the plan against the live config', () => {
  it.skipIf(getPlatform() !== 'darwin')(
    'refuses a protected system path at execution time without touching it',
    async () => {
      // The executor evaluates the denylist again, in its resolved form, before
      // any unlink. `/private/var/log` is a canonical path that must stay
      // blocked; the assertion that it still exists proves the refusal happens
      // before anything is removed rather than after.
      const target = makeTarget({ id: 'protected#1', path: '/private/var/log' });
      const execution = await executePlan({
        plan: makePlan([target]),
        config: makeConfig({ roots: ['/'], minSizeBytes: 0 }),
        dryRun: false,
      });
      expect(execution.results[0]?.outcome).toBe('skipped');
      expect(execution.results[0]?.skipReason).toBe('protected-path');
      expect(execution.freedBytes).toBe(0);
      await expect(stat('/private/var/log')).resolves.toBeDefined();
    },
  );

  it('refuses a whitelisted target and leaves it on disk', async () => {
    const target = targetFor('node_modules');
    await writeBytesFile(join(target.path, 'a.js'), 128);
    const execution = await executePlan(
      optionsFor(makePlan([target]), {
        config: makeConfig({ roots: [projDir], minSizeBytes: 0, whitelist: [target.path] }),
      }),
    );
    expect(execution.results[0]?.outcome).toBe('skipped');
    expect(execution.results[0]?.skipReason).toBe('whitelisted');
    await expect(stat(target.path)).resolves.toBeDefined();
  });

  it('refuses a target that is outside every configured root', async () => {
    const outside = join(canaryDir, 'node_modules');
    await writeBytesFile(join(outside, 'a.js'), 128);
    const target = makeTarget({ id: 'outside#1', path: outside });
    const execution = await executePlan(optionsFor(makePlan([target])));
    expect(execution.results[0]?.outcome).toBe('skipped');
    expect(execution.results[0]?.skipReason).toBe('outside-root');
    await expect(stat(outside)).resolves.toBeDefined();
  });
});

describe('executePlan against a filesystem that changed after planning', () => {
  it('refuses a symlink swapped in after planning and leaves the linked-to directory intact', async () => {
    // THE ATTACK THIS TEST ENCODES:
    //
    //   1. The scan measured a real directory inside the root and the user
    //      confirmed the plan.
    //   2. Before the unlink, another process removes that directory and
    //      replaces it with a symlink to a directory outside every root —
    //      here a canary holding a file whose content is asserted afterwards.
    //   3. A naive `rm -rf` on the planned path would follow the link and
    //      destroy the canary; a `realpath` re-check must resolve the link,
    //      notice that the resolved path is outside the roots, and refuse.
    //
    // The assertion that matters is not the skip reason but that the canary's
    // file still exists with its original bytes.
    const victim = targetFor('node_modules');
    await writeBytesFile(join(victim.path, 'placeholder.js'), 64);
    const secret = join(canaryDir, 'secret.txt');
    await writeBytesFile(secret, 128);

    const plan = makePlan([victim]);
    await removeFixtureRoot(victim.path);
    await createSymlink(victim.path, canaryDir);

    const execution = await executePlan(optionsFor(plan));

    expect(execution.results[0]?.outcome).toBe('skipped');
    expect(execution.results[0]?.skipReason).toBe('outside-root');
    expect(execution.freedBytes).toBe(0);
    // The canary survives, content included.
    await expect(stat(secret)).resolves.toBeDefined();
    expect((await readFile(secret)).length).toBe(128);
    // And the link itself was not unlinked either: the executor refuses, it
    // does not "clean up" the thing it refused to follow.
    expect((await lstat(victim.path)).isSymbolicLink()).toBe(true);
  });

  it('refuses a symlink that points inside the root rather than deleting its target', async () => {
    // A link pointing inside the roots passes containment, so the defence here
    // is different: the planned path stopped being a directory, and deleting
    // the link would free nothing while deleting its target would remove a
    // directory the plan never measured.
    const victim = targetFor('node_modules');
    const realDirectory = join(projDir, 'real-payload');
    await writeBytesFile(join(realDirectory, 'data.bin'), 256);
    await createSymlink(victim.path, realDirectory);

    const execution = await executePlan(optionsFor(makePlan([victim])));

    expect(execution.results[0]?.outcome).toBe('skipped');
    expect(execution.results[0]?.skipReason).toBe('not-a-directory');
    await expect(stat(join(realDirectory, 'data.bin'))).resolves.toBeDefined();
    expect((await lstat(victim.path)).isSymbolicLink()).toBe(true);
  });
});

describe('executePlan failure isolation', () => {
  it.skipIf(isPrivilegedUser())('fails an unwritable target while a sibling is still deleted', async () => {
    const unwritable = targetFor('node_modules');
    const sibling = targetFor('dist');
    await writeBytesFile(join(unwritable.path, 'locked.js'), 64);
    await writeBytesFile(join(sibling.path, 'bundle.js'), 256);
    // Read+execute but no write: the directory can be read and measured, but
    // removing its entries must fail with EACCES.
    await chmod(unwritable.path, 0o500);

    const execution = await executePlan(optionsFor(makePlan([unwritable, sibling])));

    expect(execution.results[0]?.outcome).toBe('failed');
    expect(execution.results[0]?.error).not.toBeNull();
    expect(execution.results[0]?.freedBytes).toBe(0);
    // The batch continues: one unwritable target must not abort the run.
    expect(execution.results[1]?.outcome).toBe('deleted');
    expect(execution.failedCount).toBe(1);
    expect(execution.deletedCount).toBe(1);
    expect(execution.freedBytes).toBe(256);
    await expect(stat(join(sibling.path, 'bundle.js'))).rejects.toThrow();
  });
});

describe('executePlan cancellation', () => {
  it('returns a partial execution without throwing when the signal aborts', async () => {
    const targets = [targetFor('one'), targetFor('two'), targetFor('three')];
    for (const target of targets) await writeBytesFile(join(target.path, 'data.js'), 100);

    const controller = new AbortController();
    let seen = 0;
    const execution = await executePlan(
      optionsFor(makePlan(targets), {
        signal: controller.signal,
        onProgress: () => {
          seen += 1;
          // Abort after the first outcome, i.e. at the only moment at which no
          // deletion is in flight.
          if (seen === 1) controller.abort();
        },
      }),
    );

    expect(execution.results).toHaveLength(1);
    expect(execution.deletedCount).toBe(1);
    expect(execution.freedBytes).toBe(100);
    // The unattempted targets are simply absent from `results` — they are not
    // reported as skipped, because "the user stopped me" is not a refusal.
    expect(execution.skippedCount).toBe(0);
    await expect(stat(join(targets[1]?.path ?? '', 'data.js'))).resolves.toBeDefined();
    await expect(stat(join(targets[2]?.path ?? '', 'data.js'))).resolves.toBeDefined();
  });

  it('does nothing at all when the signal is already aborted', async () => {
    const target = targetFor('node_modules');
    await writeBytesFile(join(target.path, 'data.js'), 100);
    const execution = await executePlan(optionsFor(makePlan([target]), { signal: AbortSignal.abort() }));
    expect(execution.results).toEqual([]);
    expect(execution.freedBytes).toBe(0);
    await expect(stat(join(target.path, 'data.js'))).resolves.toBeDefined();
  });
});

describe('formatExecutionSummary', () => {
  it('reports all three counters and the measured total', () => {
    expect(
      formatExecutionSummary({
        results: [],
        freedBytes: 4096,
        deletedCount: 2,
        skippedCount: 3,
        failedCount: 1,
        durationMs: 2400,
        startedAt: '2026-09-29T00:00:00.000Z',
      }),
    ).toBe('freed 4 KB · 2 deleted · 3 skipped · 1 failed · 2.4s');
  });

  it('keeps the skip count visible so an empty run is distinguishable from a preview', () => {
    expect(
      formatExecutionSummary({
        results: [],
        freedBytes: 0,
        deletedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        durationMs: 0,
        startedAt: '2026-09-29T00:00:00.000Z',
      }),
    ).toBe('freed 0 B · 0 deleted · 0 skipped · 0 failed · 0ms');
  });
});
