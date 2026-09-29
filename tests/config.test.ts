/**
 * Configuration Loading, Validation and Resolution
 *
 * Pins the contract of `src/rules/config.ts`: what a user config file may say,
 * what happens when it says something out of range, and which values the engine
 * actually receives.
 *
 * I. Why clamping and rejection are tested separately
 *
 * 1. The module makes a deliberate distinction. Top-level and `limits` numbers
 *    are *clamped* with a warning, because a user who writes `maxDepth: 200`
 *    means "very deep" and failing the run would be hostile. Per-rule
 *    thresholds are *rejected*, because a per-rule value is a deliberate
 *    statement about safety and a silently clamped one would be a lie.
 * 2. That distinction is the contract `dvc config validate` reports on, so both
 *    halves are pinned rather than assumed.
 *
 * @module tests/config
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ECOSYSTEMS } from '../src/core/detector.js';
import { getGlobalCacheRoots, getHome } from '../src/core/platform.js';
import { SCHEMA_VERSION } from '../src/core/types.js';
import {
  DEFAULT_LIMITS,
  findConfigFile,
  getConfigSearchPaths,
  getDefaultConfig,
  loadConfig,
  parseUserConfig,
  resolveConfig,
  serializeConfig,
  validateConfigFile,
} from '../src/rules/config.js';
import { createFixtureRoot, removeFixtureRoot, writeTextFile } from './helpers.js';

let fixtureDir = '';

beforeEach(async () => {
  fixtureDir = await createFixtureRoot('config');
});

afterEach(async () => {
  await removeFixtureRoot(fixtureDir);
});

describe('parseUserConfig', () => {
  it('accepts a well-formed config and returns it unchanged', () => {
    const raw = {
      schemaVersion: SCHEMA_VERSION,
      roots: ['/a'],
      maxDepth: 4,
      minSizeBytes: 100,
      whitelist: ['/b'],
      retentionDays: 3,
      rules: { 'node-modules': { risk: 'high' as const } },
      limits: { concurrency: 8 },
      ecosystems: { rust: { enabled: false } },
      report: { dir: 'out', format: 'markdown' as const },
    };
    const parsed = parseUserConfig(raw, '/cfg/dvc.config.json');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config).toEqual(raw);
  });

  it('names an unknown top-level key in the error message', () => {
    const parsed = parseUserConfig({ nope: 1 }, '/cfg/dvc.config.json');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.errors[0]).toContain('nope');
      expect(parsed.errors[0]).toContain('/cfg/dvc.config.json');
    }
  });

  it('names an unknown key inside a nested block', () => {
    // A misspelled safety override must never be a silent no-op, so every
    // nested object is strict too.
    const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ limits: { nope: 1 } }, 'nope'],
      [{ report: { nope: 1 } }, 'nope'],
      [{ rules: { 'node-modules': { reportonly: true } } }, 'reportonly'],
      [{ ecosystems: { rust: { nope: 1 } } }, 'nope'],
    ];
    for (const [raw, offendingKey] of cases) {
      const parsed = parseUserConfig(raw, null);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.errors.join(' ')).toContain(offendingKey);
    }
  });

  it('reports a non-object root with one clear message', () => {
    for (const [raw, described] of [
      [null, 'null'],
      [[1, 2], 'an array'],
      ['text', 'a string'],
      [42, 'a number'],
    ] as const) {
      const parsed = parseUserConfig(raw, null);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.errors).toHaveLength(1);
        expect(parsed.errors[0]).toContain('expected a JSON object');
        expect(parsed.errors[0]).toContain(described);
      }
    }
  });

  it('rejects a value of the wrong type and names the field and the shape', () => {
    const parsed = parseUserConfig({ maxDepth: 'deep' }, '/cfg/dvc.config.json');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors[0]).toContain('maxDepth');
      expect(parsed.errors[0]).toContain('expected number');
    }
  });

  it('rejects a non-finite number rather than letting it reach the walker', () => {
    for (const value of [Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(parseUserConfig({ maxDepth: value }, null).ok).toBe(false);
      expect(parseUserConfig({ limits: { concurrency: value } }, null).ok).toBe(false);
    }
  });

  it('rejects a negative per-rule threshold instead of clamping it', () => {
    // Documented asymmetry: per-rule thresholds are statements about safety, so
    // an out-of-range one is an error rather than a silently corrected value.
    expect(parseUserConfig({ rules: { 'node-modules': { minSizeBytes: -1 } } }, null).ok).toBe(false);
    expect(parseUserConfig({ rules: { 'node-modules': { olderThanDays: -1 } } }, null).ok).toBe(false);
    expect(parseUserConfig({ rules: { 'node-modules': { minEntries: -1 } } }, null).ok).toBe(false);
  });

  it('rejects an empty extra pattern because it could never match', () => {
    expect(parseUserConfig({ rules: { 'node-modules': { extraPatterns: [''] } } }, null).ok).toBe(false);
  });

  it('never throws, whatever it is handed', () => {
    expect(() => parseUserConfig(undefined, null)).not.toThrow();
    expect(() => parseUserConfig({ rules: 'not-an-object' }, null)).not.toThrow();
  });
});

describe('resolveConfig numeric clamping', () => {
  const CASES: ReadonlyArray<readonly [string, Record<string, unknown>, number]> = [
    ['maxDepth below the floor', { maxDepth: 0 }, 1],
    ['maxDepth above the ceiling', { maxDepth: 200 }, 32],
    ['maxDepth truncated to an integer', { maxDepth: 6.9 }, 6],
    ['maxDepth at the floor', { maxDepth: 1 }, 1],
    ['minSizeBytes below the floor', { minSizeBytes: -5 }, 0],
    ['minSizeBytes truncated', { minSizeBytes: 1.9 }, 1],
    ['minSizeBytes has no ceiling', { minSizeBytes: 10 ** 15 }, 10 ** 15],
    ['retentionDays below the floor', { retentionDays: -1 }, 0],
    ['retentionDays above the ceiling', { retentionDays: 99_999 }, 3650],
    ['limits.concurrency below the floor', { limits: { concurrency: 0 } }, 1],
    ['limits.concurrency above the ceiling', { limits: { concurrency: 1000 } }, 128],
    ['limits.concurrency truncated', { limits: { concurrency: 12.9 } }, 12],
    ['limits.lightNodeModulesEntries below the floor', { limits: { lightNodeModulesEntries: 0 } }, 1],
    [
      'limits.lightNodeModulesEntries above the ceiling',
      { limits: { lightNodeModulesEntries: 200_000 } },
      100_000,
    ],
    ['limits.maxDirectories below the floor', { limits: { maxDirectories: 0 } }, 1],
    ['limits.maxDirectories above the ceiling', { limits: { maxDirectories: 9_000_000 } }, 5_000_000],
    ['limits.highRiskBytes below the floor', { limits: { highRiskBytes: 0 } }, 1],
  ];

  for (const [label, user, expected] of CASES) {
    it(`clamps ${label} to ${expected}`, () => {
      const config = resolveConfig(user, null);
      if (typeof user.maxDepth === 'number') expect(config.maxDepth).toBe(expected);
      if (typeof user.minSizeBytes === 'number') expect(config.minSizeBytes).toBe(expected);
      if (typeof user.retentionDays === 'number') expect(config.retentionDays).toBe(expected);
      if (user.limits && typeof user.limits === 'object') {
        const limits = user.limits as Record<string, number>;
        const key = Object.keys(limits)[0] as keyof typeof config.limits;
        expect(config.limits[key]).toBe(expected);
      }
    });
  }

  it('falls back to the built-in default for a non-finite value', () => {
    // `parseUserConfig` rejects `Infinity`, so this branch is only reachable
    // from a programmatic caller; it must still not poison every later sum.
    const config = resolveConfig({ maxDepth: Number.POSITIVE_INFINITY, minSizeBytes: Number.NaN }, null);
    expect(config.maxDepth).toBe(6);
    expect(config.minSizeBytes).toBe(1_048_576);
  });
});

describe('resolveConfig path handling', () => {
  it('expands a leading tilde against the home directory', () => {
    const config = resolveConfig({ roots: ['~/projects'], whitelist: ['~/keep'] }, null);
    expect(config.roots).toEqual([join(getHome(), 'projects')]);
    expect(config.whitelist).toEqual([join(getHome(), 'keep')]);
  });

  it('expands a bare tilde to the home directory', () => {
    expect(resolveConfig({ roots: ['~'] }, null).roots).toEqual([getHome()]);
  });

  it('keeps a tilde that is not a leading segment literal', () => {
    expect(resolveConfig({ roots: ['/backup~/x'] }, null).roots).toEqual(['/backup~/x']);
  });

  it('resolves a relative root against the directory of the config file', () => {
    // The same file must mean the same tree no matter where the tool is
    // launched from, so relative entries anchor to the declaring file.
    const config = resolveConfig({ roots: ['sub'], whitelist: ['keep'] }, '/cfg/dvc.config.json');
    expect(config.roots).toEqual(['/cfg/sub']);
    expect(config.whitelist).toEqual(['/cfg/keep']);
  });

  it('resolves a relative root against the working directory without a source file', () => {
    expect(resolveConfig({ roots: ['sub'] }, null).roots).toEqual([join(process.cwd(), 'sub')]);
  });

  it('drops duplicate roots and whitelist entries, keeping the first spelling', () => {
    const config = resolveConfig({ roots: ['/a', '/a/', '/b'], whitelist: ['/x', '/x'] }, null);
    expect(config.roots).toEqual(['/a', '/b']);
    expect(config.whitelist).toEqual(['/x']);
  });

  it('falls back to the home directory when no root is configured', () => {
    expect(resolveConfig({}, null).roots).toEqual([getHome()]);
    expect(resolveConfig({ roots: [] }, null).roots).toEqual([getHome()]);
  });
});

describe('resolveConfig defaults and blocks', () => {
  it('produces a config with every declared field present', () => {
    const config = resolveConfig({}, null);
    expect(Object.keys(config).sort()).toEqual(
      [
        'ecosystems',
        'limits',
        'maxDepth',
        'minSizeBytes',
        'report',
        'retentionDays',
        'roots',
        'rules',
        'sourcePath',
        'whitelist',
      ].sort(),
    );
    expect(Object.keys(config.limits).sort()).toEqual(
      ['concurrency', 'highRiskBytes', 'lightNodeModulesEntries', 'maxDirectories'].sort(),
    );
    expect(Object.keys(config.report).sort()).toEqual(['dir', 'format']);
  });

  it('defaults every limit to the built-in guard rails', () => {
    expect(getDefaultConfig().limits).toEqual(DEFAULT_LIMITS);
  });

  it('enables every known ecosystem by default', () => {
    const config = getDefaultConfig();
    expect(Object.keys(config.ecosystems).sort()).toEqual(ECOSYSTEMS.map((e) => e.id).sort());
    for (const id of Object.keys(config.ecosystems)) {
      expect(config.ecosystems[id]?.enabled).toBe(true);
    }
  });

  it('keeps an ecosystem id the detector does not know', () => {
    // `dvc config show` must echo exactly what the user wrote.
    const config = resolveConfig({ ecosystems: { 'not-a-real-ecosystem': { enabled: false } } }, null);
    expect(config.ecosystems['not-a-real-ecosystem']).toEqual({ enabled: false });
    expect(config.ecosystems.node).toEqual({ enabled: true });
  });

  it('merges a partial limits block over the defaults', () => {
    const config = resolveConfig({ limits: { concurrency: 4 } }, null);
    expect(config.limits.concurrency).toBe(4);
    expect(config.limits.highRiskBytes).toBe(DEFAULT_LIMITS.highRiskBytes);
    expect(config.limits.maxDirectories).toBe(DEFAULT_LIMITS.maxDirectories);
  });

  it('anchors the report directory to the working directory but expands a tilde', () => {
    expect(resolveConfig({}, null).report).toEqual({ dir: '.devenvclean', format: 'json' });
    const expanded = resolveConfig({ report: { dir: '~/reports', format: 'markdown' } }, null);
    expect(expanded.report).toEqual({ dir: join(homedir(), 'reports'), format: 'markdown' });
    // A relative report dir stays relative: reports are written where the
    // command runs, not where the config file lives.
    expect(resolveConfig({ report: { dir: 'reports' } }, '/cfg/dvc.config.json').report.dir).toBe('reports');
  });

  it('echoes the rule overrides it was given', () => {
    const config = resolveConfig({ rules: { 'node-modules': { risk: 'high' } } }, null);
    expect(config.rules).toEqual({ 'node-modules': { risk: 'high' } });
  });

  it('records the source file it was resolved from', () => {
    expect(resolveConfig({}, null).sourcePath).toBeNull();
    expect(resolveConfig({}, '/cfg/dvc.config.json').sourcePath).toBe('/cfg/dvc.config.json');
  });
});

describe('serializeConfig', () => {
  it('round-trips through parseUserConfig without errors', () => {
    const serialized = serializeConfig(getDefaultConfig());
    const parsed = parseUserConfig(serialized, null);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config).toEqual(serialized);
  });

  it('stamps the current schema version and an explicit empty root list', () => {
    const serialized = serializeConfig(getDefaultConfig());
    expect(serialized.schemaVersion).toBe(SCHEMA_VERSION);
    expect(serialized.roots).toEqual([]);
  });

  it('carries the tuned values into the scaffold', () => {
    const config = resolveConfig({ maxDepth: 9, minSizeBytes: 42, retentionDays: 7 }, null);
    const serialized = serializeConfig(config);
    expect(serialized.maxDepth).toBe(9);
    expect(serialized.minSizeBytes).toBe(42);
    expect(serialized.retentionDays).toBe(7);
  });

  it('pre-seeds the whitelist with the machine-global stores that must not be touched', () => {
    const whitelist = serializeConfig(getDefaultConfig()).whitelist ?? [];
    expect(whitelist).toContain(getGlobalCacheRoots().pnpm);
    expect(whitelist).toContain(getGlobalCacheRoots().maven);
    expect(whitelist.length).toBeGreaterThan(0);
  });
});

describe('config discovery and file validation', () => {
  it('finds the nearest config file, walking up from the working directory', async () => {
    const nested = join(fixtureDir, 'a', 'b');
    await writeTextFile(join(fixtureDir, 'dvc.config.json'), '{"minSizeBytes": 7}');
    const result = await loadConfig({ cwd: nested });
    expect(result.config.sourcePath).toBe(join(fixtureDir, 'dvc.config.json'));
    expect(result.config.minSizeBytes).toBe(7);
  });

  it('returns pure defaults when nothing is found in the temporary tree', async () => {
    // `findConfigFile` is asserted rather than `loadConfig` so the assertion
    // does not depend on what exists in the developer's home directory.
    expect(await findConfigFile(fixtureDir)).toBeNull();
  });

  it('searches the working directory before its ancestors and ends at the user config', () => {
    const paths = getConfigSearchPaths(fixtureDir);
    expect(paths[0]).toBe(join(fixtureDir, 'dvc.config.json'));
    expect(paths[1]).toBe(join(dirname(fixtureDir), 'dvc.config.json'));
    // No candidate may repeat, or a later lookup would shadow an earlier one.
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain(join(homedir(), '.dvc.config.json'));
    expect(paths.some((candidate) => candidate.endsWith(join('devenvclean', 'config.json')))).toBe(true);
  });

  it('throws when an explicitly named config file does not exist', async () => {
    await expect(loadConfig({ cwd: fixtureDir, explicitPath: 'missing.json' })).rejects.toThrow(/not found/);
  });

  it('throws with the offending key when the file is structurally invalid', async () => {
    const file = join(fixtureDir, 'dvc.config.json');
    await writeTextFile(file, '{"maxDepth": "deep"}');
    await expect(loadConfig({ cwd: fixtureDir })).rejects.toThrow(/maxDepth/);
  });

  it('reports a non-JSON file as an error instead of throwing', async () => {
    const file = join(fixtureDir, 'broken.json');
    await writeTextFile(file, '{ not json');
    const result = await validateConfigFile(file);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('not valid JSON');
    expect(result.warnings).toEqual([]);
  });

  it('warns about a clamp, an unknown rule id, a missing root and an orphan whitelist entry', async () => {
    const file = join(fixtureDir, 'dvc.config.json');
    await writeTextFile(
      file,
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION + 1,
        roots: [join(fixtureDir, 'does-not-exist')],
        whitelist: ['/outside/every/root'],
        maxDepth: 200,
        rules: { 'no-such-rule': { enabled: false } },
      }),
    );
    const result = await validateConfigFile(file);
    expect(result.ok).toBe(true);
    const joined = result.warnings.join('\n');
    expect(joined).toContain('maxDepth');
    expect(joined).toContain('no-such-rule');
    expect(joined).toContain('does not exist on disk');
    expect(joined).toContain('outside every configured root');
    expect(joined).toContain('schemaVersion');
  });

  it('reports a valid, current config file with no warnings', async () => {
    const file = join(fixtureDir, 'dvc.config.json');
    await writeTextFile(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, roots: [fixtureDir] }));
    const result = await validateConfigFile(file);
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });
});
