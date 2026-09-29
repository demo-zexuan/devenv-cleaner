/**
 * Clean Plan Construction
 *
 * Pins the lock matrix of `src/core/planner.ts`: which targets a cleanup run is
 * willing to act on, and — more importantly — which ones no flag may ever
 * release.
 *
 * I. The two-layer safety model this file exists to protect
 *
 * 1. A report already carries `locked` / `lockedReason` from the scan, but a
 *    report is a *file*: it can be stale, hand-edited, or produced under a
 *    different config. The planner therefore recomputes the permanent guards
 *    (`protected-path`, `outside-root`, `whitelisted`, `too-small`) from the
 *    live config instead of trusting the flags it reads.
 * 2. `includeLocked` is a deny-list, not an allow-list. Only `too-recent`,
 *    `risk-exceeds-policy` and `user-config` may be released; every other
 *    reason — including one added to `LockReason` later — fails closed.
 *
 * @module tests/planner
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { buildPlan, planFromReport } from '../src/core/planner.js';
import type { CleanTarget, LockReason, ResolvedConfig } from '../src/core/types.js';
import { LAYER_ORDER } from '../src/rules/engine.js';
import { makeConfig, makeReport, makeTarget, SAMPLE_ROOT, WORKSPACE_ROOT } from './helpers.js';

/** The scan root every planner test uses, so containment is easy to reason about. */
const ROOT = join(SAMPLE_ROOT, 'proj');

/** A target path located inside {@link ROOT}. */
const INSIDE = join(ROOT, 'node_modules');

/** A target path located outside every configured root. */
const OUTSIDE = join(WORKSPACE_ROOT, 'elsewhere', 'node_modules');

/** A protected system path that no config may ever release. */
const PROTECTED = '/etc/nginx';

/** Build the planner's config: one root, no size floor unless a test asks. */
function planConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return makeConfig({ roots: [ROOT], minSizeBytes: 0, ...overrides });
}

/** Reasons the planner is allowed to release when `includeLocked` is set. */
const OVERRIDABLE_REASONS: readonly LockReason[] = ['too-recent', 'risk-exceeds-policy', 'user-config'];

/** Reasons that are permanent whatever the caller passes. */
const PERMANENT_REASONS: readonly LockReason[] = [
  'protected-path',
  'whitelisted',
  'outside-root',
  'too-small',
];

describe('buildPlan with policy-level locks', () => {
  for (const reason of OVERRIDABLE_REASONS) {
    it(`keeps a ${reason} target in skipped unless the caller opts in`, () => {
      const target = makeTarget({ locked: true, lockedReason: reason, bytes: 2000 });
      const report = makeReport([target]);
      const config = planConfig();

      const withoutFlag = buildPlan({ report, config });
      expect(withoutFlag.targets).toHaveLength(0);
      expect(withoutFlag.skipped.map((entry) => entry.id)).toEqual([target.id]);

      const withFlag = buildPlan({ report, config, includeLocked: true });
      expect(withFlag.targets.map((entry) => entry.id)).toEqual([target.id]);
      expect(withFlag.skipped).toHaveLength(0);
      expect(withFlag.totalBytes).toBe(2000);
    });
  }

  it('promotes a locked target without erasing the fact that it was locked', () => {
    // Overriding a lock is not a way to sneak past the executor's re-checks:
    // the promoted entry still says it was locked and why.
    const target = makeTarget({ locked: true, lockedReason: 'too-recent' });
    const plan = buildPlan({ report: makeReport([target]), config: planConfig(), includeLocked: true });
    expect(plan.targets[0]?.locked).toBe(true);
    expect(plan.targets[0]?.lockedReason).toBe('too-recent');
  });

  it('collects distinct human skip reasons, sorted', () => {
    const report = makeReport([
      makeTarget({ id: 'a', locked: true, lockedReason: 'too-recent' }),
      makeTarget({ id: 'b', locked: true, lockedReason: 'too-small', bytes: 1 }),
    ]);
    const plan = buildPlan({ report, config: planConfig({ minSizeBytes: 5000 }) });
    expect(plan.skipReasons).toEqual(['below the configured size floor', 'modified too recently']);
  });

  it('fails closed on a lock that declares no reason', () => {
    // Guessing that an unlabelled lock is a policy hesitation is the one guess
    // a deletion tool must not make, so it stays locked and is explained.
    const target = makeTarget({ locked: true, lockedReason: null });
    const plan = buildPlan({ report: makeReport([target]), config: planConfig(), includeLocked: true });
    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped.map((entry) => entry.id)).toEqual([target.id]);
    expect(plan.skipped[0]?.locked).toBe(true);
    expect(plan.skipReasons).toEqual(['locked by an unspecified policy']);
  });
});

describe('the permanent lock floor', () => {
  it('never releases protected-path, whitelisted, outside-root or too-small, even with includeLocked', () => {
    // SECURITY FLOOR — the assertion this whole file exists for.
    //
    // These four reasons are the product's non-negotiable safety floor: no flag,
    // no config value and no CLI option may lift them. The counterexample is a
    // report that claims one of them is locked while the caller passes
    // `includeLocked: true`; if any of them moved into `targets`, the executor
    // would be one dry-run confirmation away from deleting a protected path.
    // The reasons that *are* releasable are the opposite case, asserted in the
    // block above, and the difference between the two lists is the entire
    // meaning of `--include-locked`.
    for (const reason of PERMANENT_REASONS) {
      const target = makeTarget({ locked: true, lockedReason: reason, bytes: 2_000_000 });
      const plan = buildPlan({
        report: makeReport([target]),
        config: planConfig(),
        includeLocked: true,
      });
      expect(plan.targets).toHaveLength(0);
      expect(plan.skipped.map((entry) => entry.id)).toEqual([target.id]);
      expect(plan.skipped[0]?.lockedReason).toBe(reason);
      expect(plan.totalBytes).toBe(0);
    }
  });

  it('recomputes protected-path instead of trusting a report that says the path is unlocked', () => {
    // A hand-edited report is the threat: `locked: false` plus a benign-looking
    // reason must not talk the planner into proposing a system directory.
    const target = makeTarget({ path: PROTECTED, locked: false, lockedReason: null });
    const plan = buildPlan({
      report: makeReport([target]),
      config: planConfig({ roots: ['/'] }),
      includeLocked: true,
    });
    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0]?.lockedReason).toBe('protected-path');
  });

  it('recomputes outside-root instead of trusting the report', () => {
    const target = makeTarget({ path: OUTSIDE, locked: false, lockedReason: null });
    const plan = buildPlan({ report: makeReport([target]), config: planConfig(), includeLocked: true });
    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0]?.lockedReason).toBe('outside-root');
  });

  it('recomputes whitelisted from the live config even when the report says unlocked', () => {
    const target = makeTarget({ path: INSIDE, locked: false, lockedReason: null });
    const plan = buildPlan({
      report: makeReport([target]),
      config: planConfig({ whitelist: [INSIDE] }),
      includeLocked: true,
    });
    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0]?.lockedReason).toBe('whitelisted');
  });

  it('recomputes too-small against the global floor with includeLocked set', () => {
    const target = makeTarget({ bytes: 10, locked: false, lockedReason: null });
    const plan = buildPlan({
      report: makeReport([target]),
      config: planConfig({ minSizeBytes: 5000 }),
      includeLocked: true,
    });
    expect(plan.targets).toHaveLength(0);
    expect(plan.skipped[0]?.lockedReason).toBe('too-small');
  });

  it('applies a per-rule size floor on top of the global one', () => {
    const target = makeTarget({ bytes: 5000, ruleId: 'node-modules' });
    const plan = buildPlan({
      report: makeReport([target]),
      config: planConfig({ minSizeBytes: 0, rules: { 'node-modules': { minSizeBytes: 10_000 } } }),
    });
    expect(plan.skipped[0]?.lockedReason).toBe('too-small');
  });

  it('reports the planner verdict rather than the scan verdict on a skipped entry', () => {
    // The scan locked the path for a benign reason, but the live denylist wins;
    // the entry is rewritten so a caller can match on the reason it sees.
    const target = makeTarget({ path: PROTECTED, locked: true, lockedReason: 'too-recent' });
    const plan = buildPlan({
      report: makeReport([target]),
      config: planConfig({ roots: ['/'] }),
      includeLocked: true,
    });
    expect(plan.skipped[0]?.lockedReason).toBe('protected-path');
  });
});

describe('buildPlan filters', () => {
  const cache = makeTarget({
    id: 'cache',
    ruleId: 'generic-cache',
    path: join(ROOT, '.cache'),
    layer: 'cache',
    bytes: 100,
    ageDays: 1,
  });
  const build = makeTarget({
    id: 'build',
    ruleId: 'node-build-output',
    path: join(ROOT, 'dist'),
    layer: 'build',
    bytes: 200,
    ageDays: 2,
  });
  const deps = makeTarget({
    id: 'deps',
    path: join(ROOT, 'node_modules'),
    layer: 'dependencies',
    bytes: 300,
    ageDays: 10,
  });
  const report = makeReport([cache, build, deps]);
  const config = planConfig();

  it('selects exactly the requested target ids', () => {
    const plan = buildPlan({ report, config, selectedIds: ['build', 'cache'] });
    expect(plan.targets.map((entry) => entry.id)).toEqual(['cache', 'build']);
  });

  it('reports a selected id the report does not contain', () => {
    const plan = buildPlan({ report, config, selectedIds: ['build', 'ghost', 'phantom', 'ghost'] });
    expect(plan.unknownIds).toEqual(['ghost', 'phantom']);
  });

  it('reports no unknown ids when the caller did not narrow the selection', () => {
    // "The user typed nothing" and "everything the user typed was found" are
    // different statements, so the list is empty rather than the report's ids.
    expect(buildPlan({ report, config }).unknownIds).toEqual([]);
  });

  it('restricts the plan to the requested layers', () => {
    const plan = buildPlan({ report, config, layers: ['build'] });
    expect(plan.targets.map((entry) => entry.id)).toEqual(['build']);
  });

  it('restricts the plan to the requested rule ids', () => {
    const plan = buildPlan({ report, config, ruleIds: ['node-modules'] });
    expect(plan.targets.map((entry) => entry.id)).toEqual(['deps']);
  });

  it('applies the minimum size filter', () => {
    const plan = buildPlan({ report, config, minBytes: 200 });
    // 200 is inclusive, and 'build' sorts before 'deps' because build is the
    // cheaper-to-lose layer in the plan's own display order.
    expect(plan.targets.map((entry) => entry.id)).toEqual(['build', 'deps']);
  });

  it('applies the staleness filter on the freshest file in the tree', () => {
    const plan = buildPlan({ report, config, olderThanDays: 5 });
    expect(plan.targets.map((entry) => entry.id)).toEqual(['deps']);
  });

  it('matches the path filter case-insensitively', () => {
    const plan = buildPlan({ report, config, pathContains: 'NODE_MODULES' });
    expect(plan.targets.map((entry) => entry.id)).toEqual(['deps']);
  });

  it('composes every filter as a conjunction', () => {
    const plan = buildPlan({
      report,
      config,
      layers: ['cache', 'build', 'dependencies'],
      ruleIds: ['node-modules', 'node-build-output'],
      minBytes: 150,
      olderThanDays: 5,
      pathContains: 'node_modules',
    });
    expect(plan.targets.map((entry) => entry.id)).toEqual(['deps']);
  });

  it('does not place a filtered-out locked target in skipped', () => {
    // A target the caller excluded is not "skipped"; it was never a candidate,
    // and counting it would inflate the locked statistics.
    const locked = makeTarget({
      id: 'locked-cache',
      path: join(ROOT, '.cache'),
      layer: 'cache',
      locked: true,
      lockedReason: 'too-recent',
    });
    const plan = buildPlan({
      report: makeReport([locked, build]),
      config,
      layers: ['build'],
    });
    expect(plan.skipped).toHaveLength(0);
    expect(plan.targets.map((entry) => entry.id)).toEqual(['build']);
  });
});

describe('buildPlan ordering and totals', () => {
  it('orders by layer display order, then bytes descending, then path, then id', () => {
    const targets = [
      makeTarget({ id: 'z-artifact', path: join(ROOT, 'artifacts'), layer: 'artifacts', bytes: 900 }),
      makeTarget({ id: 'b-deps', path: join(ROOT, 'node_modules'), layer: 'dependencies', bytes: 100 }),
      makeTarget({ id: 'a-cache-small', path: join(ROOT, '.cache'), layer: 'cache', bytes: 10 }),
      makeTarget({ id: 'c-cache-big', path: join(ROOT, '.vite'), layer: 'cache', bytes: 500 }),
      makeTarget({ id: 'd-build', path: join(ROOT, 'dist'), layer: 'build', bytes: 50 }),
    ];
    const plan = buildPlan({ report: makeReport(targets), config: planConfig() });
    expect(plan.targets.map((entry) => entry.layer)).toEqual([
      'cache',
      'cache',
      'build',
      'dependencies',
      'artifacts',
    ]);
    expect(plan.targets[0]?.id).toBe('c-cache-big');
    expect(plan.targets[1]?.id).toBe('a-cache-small');
    expect(LAYER_ORDER).toEqual(['cache', 'build', 'dependencies', 'artifacts']);
  });

  it('breaks a size tie by path and then by id', () => {
    const targets = [
      makeTarget({ id: 'second', path: join(ROOT, 'b-build'), layer: 'build', bytes: 100 }),
      makeTarget({ id: 'first', path: join(ROOT, 'a-build'), layer: 'build', bytes: 100 }),
    ];
    const plan = buildPlan({ report: makeReport(targets), config: planConfig() });
    expect(plan.targets.map((entry) => entry.id)).toEqual(['first', 'second']);
  });

  it('sums only the actionable targets into totalBytes', () => {
    const actionable = makeTarget({ id: 'ok', bytes: 1000 });
    const locked = makeTarget({ id: 'no', locked: true, lockedReason: 'too-recent', bytes: 999_999 });
    const plan = buildPlan({ report: makeReport([actionable, locked]), config: planConfig() });
    expect(plan.totalBytes).toBe(1000);
    expect(plan.skipped).toHaveLength(1);
  });

  it('produces the same plan for the same input, whatever order the report lists', () => {
    const targets = [
      makeTarget({ id: 'a', path: join(ROOT, 'a'), bytes: 10 }),
      makeTarget({ id: 'b', path: join(ROOT, 'b'), bytes: 20 }),
    ];
    const first = buildPlan({ report: makeReport(targets), config: planConfig() });
    const second = buildPlan({ report: makeReport([...targets].reverse()), config: planConfig() });
    expect(first).toEqual(second);
  });

  it('is a pure function of its arguments', () => {
    const report = makeReport([makeTarget()]);
    const config = planConfig();
    expect(buildPlan({ report, config })).toEqual(buildPlan({ report, config }));
  });

  it('handles a report with no targets at all', () => {
    const plan = buildPlan({ report: makeReport([]), config: planConfig() });
    expect(plan).toEqual({ targets: [], totalBytes: 0, skipped: [], skipReasons: [], unknownIds: [] });
  });
});

describe('planFromReport', () => {
  it('selects every unlocked target and leaves a locked one behind', () => {
    const unlocked: CleanTarget = makeTarget({ id: 'open', bytes: 4000 });
    const locked: CleanTarget = makeTarget({ id: 'held', locked: true, lockedReason: 'too-recent' });
    const plan = planFromReport(makeReport([unlocked, locked]), planConfig());
    expect(plan.targets.map((entry) => entry.id)).toEqual(['open']);
    expect(plan.skipped.map((entry) => entry.id)).toEqual(['held']);
    expect(plan.unknownIds).toEqual([]);
  });
});
