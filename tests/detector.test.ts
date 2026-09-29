/**
 * Ecosystem Detection Behaviour
 *
 * Pins how `src/core/detector.ts` turns a directory's entry names into a set of
 * ecosystems, and which of those entries are strong enough to make the
 * directory a project root.
 *
 * I. Why the catalog drives the assertions
 *
 * 1. The marker catalog is data, and the promise in `docs/design.md` is that a
 *    new ecosystem is *only* a new catalog entry. Deriving the strongest-marker
 *    table from `ECOSYSTEMS` means a newly added ecosystem is covered the moment
 *    it is declared, with no test edit — which is what makes the promise hold.
 * 2. The weak/strong distinction is a safety property, not a nicety: a directory
 *    holding only a monorepo hint such as `lerna.json` must not be reported as a
 *    project root, or every workspace container becomes a phantom project.
 *
 * @module tests/detector
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_MARKER_NAMES,
  detectInEntries,
  ECOSYSTEMS,
  type EcosystemId,
  ecosystemName,
  getEcosystem,
  type MarkerDefinition,
} from '../src/core/detector.js';

/** Every weak marker in the catalog, with the ecosystem it merely hints at. */
const WEAK_MARKERS: ReadonlyArray<{ readonly marker: string; readonly ecosystem: EcosystemId }> =
  ECOSYSTEMS.flatMap((ecosystem) =>
    ecosystem.markers
      .filter((marker: MarkerDefinition) => marker.weak === true)
      .map((marker) => ({ marker: marker.marker, ecosystem: ecosystem.id })),
  );

/** One strong marker per ecosystem, used to prove each is independently detectable. */
const STRONG_MARKERS: ReadonlyArray<{ readonly marker: string; readonly ecosystem: EcosystemId }> =
  ECOSYSTEMS.flatMap((ecosystem) => {
    const strong = ecosystem.markers.find((marker) => marker.weak !== true);
    return strong ? [{ marker: strong.marker, ecosystem: ecosystem.id }] : [];
  });

describe('detectInEntries with a single ecosystem marker', () => {
  for (const { marker, ecosystem } of STRONG_MARKERS) {
    it(`recognises ${ecosystem} from its marker ${marker}`, () => {
      const result = detectInEntries([marker]);
      expect(result.isProjectRoot).toBe(true);
      expect(result.ecosystems).toContain(ecosystem);
      expect(result.markers).toEqual([marker]);
    });
  }

  it('declares at least one strong marker for every ecosystem in the catalog', () => {
    // An ecosystem with nothing but weak markers could never be detected on its
    // own, which would make its rules unreachable.
    expect(STRONG_MARKERS.map((entry) => entry.ecosystem).sort()).toEqual(
      ECOSYSTEMS.map((ecosystem) => ecosystem.id).sort(),
    );
  });
});

describe('detectInEntries with no marker', () => {
  it('reports an ordinary directory as a non-project with no ecosystems', () => {
    const result = detectInEntries(['src', 'README.md', 'index.ts']);
    expect(result).toEqual({
      isProjectRoot: false,
      ecosystems: [],
      markers: [],
      packageManager: null,
    });
  });

  it('treats an empty entry list as a non-project', () => {
    expect(detectInEntries([]).isProjectRoot).toBe(false);
  });

  it('ignores a marker-like name that is not an exact match', () => {
    expect(detectInEntries(['package.json.bak']).isProjectRoot).toBe(false);
    expect(detectInEntries(['my-package.json']).isProjectRoot).toBe(false);
  });
});

describe('detectInEntries with several ecosystems', () => {
  it('reports ecosystems in catalog order regardless of entry order', () => {
    const forward = detectInEntries(['package.json', 'Cargo.toml', 'go.mod']);
    const reversed = detectInEntries(['go.mod', 'Cargo.toml', 'package.json']);
    expect(forward.ecosystems).toEqual(['node', 'rust', 'go']);
    expect(reversed.ecosystems).toEqual(forward.ecosystems);
  });

  it('deduplicates an ecosystem that several of its markers imply', () => {
    // `package.json` and `pnpm-workspace.yaml` are both node markers.
    const result = detectInEntries(['package.json', 'pnpm-workspace.yaml', 'package.json']);
    expect(result.ecosystems).toEqual(['node']);
    expect(result.markers).toEqual(['package.json', 'pnpm-workspace.yaml']);
  });

  it('sorts the matched marker names for deterministic output', () => {
    expect(detectInEntries(['go.sum', 'Cargo.toml', 'package.json']).markers).toEqual([
      'Cargo.toml',
      'go.sum',
      'package.json',
    ]);
  });

  it('reports a lock file as package-manager evidence rather than as a marker', () => {
    // `markers` is documented as "marker files that caused the detection"; a
    // lock file refines the answer and must not claim to be the cause.
    const result = detectInEntries(['package.json', 'pnpm-lock.yaml']);
    expect(result.markers).toEqual(['package.json']);
    expect(result.packageManager).toBe('pnpm');
  });

  it('reports a full-stack directory as every ecosystem it belongs to', () => {
    const result = detectInEntries([
      'package.json',
      'pyproject.toml',
      'Cargo.toml',
      'go.mod',
      'pom.xml',
      'composer.json',
      'Gemfile',
      'mix.exs',
      'Package.swift',
      'CMakeLists.txt',
    ]);
    expect(result.isProjectRoot).toBe(true);
    expect(result.ecosystems).toEqual([
      'node',
      'python',
      'rust',
      'go',
      'java-maven',
      'php',
      'ruby',
      'elixir',
      'swift',
      'c-cpp',
    ]);
  });
});

describe('detectInEntries with weak markers', () => {
  for (const { marker, ecosystem } of WEAK_MARKERS) {
    it(`does not treat ${marker} alone as a ${ecosystem} project root`, () => {
      const result = detectInEntries([marker]);
      expect(result.isProjectRoot).toBe(false);
      expect(result.ecosystems).not.toContain(ecosystem);
      // The marker is still reported, so `dvc explain` can say why the
      // directory was inspected at all.
      expect(result.markers).toEqual([marker]);
    });
  }

  it('admits a weak ecosystem alongside a strong one in the same directory', () => {
    const result = detectInEntries(['package.json', 'poetry.lock']);
    expect(result.isProjectRoot).toBe(true);
    expect(result.ecosystems).toEqual(['node', 'python']);
  });

  it('admits a weak marker from an unrelated ecosystem', () => {
    // A Node project with a Gradle settings file: the weak Gradle hint joins
    // the result, because a real project root was established.
    const result = detectInEntries(['package.json', 'settings.gradle']);
    expect(result.isProjectRoot).toBe(true);
    expect(result.ecosystems).toEqual(['node', 'java-gradle']);
  });

  it('covers every weak marker in the catalog', () => {
    expect(WEAK_MARKERS.length).toBeGreaterThan(0);
  });
});

describe('detectInEntries package manager inference', () => {
  const LOCKFILES: ReadonlyArray<readonly [string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
  ];

  for (const [lockfile, manager] of LOCKFILES) {
    it(`infers ${manager} from ${lockfile}`, () => {
      expect(detectInEntries(['package.json', lockfile]).packageManager).toBe(manager);
    });
  }

  it('leaves the package manager unknown when no lock file is present', () => {
    expect(detectInEntries(['package.json']).packageManager).toBeNull();
    expect(detectInEntries(['package.json', 'Cargo.lock']).packageManager).toBeNull();
  });

  it('infers a lock file even when it is the only node evidence', () => {
    // No `package.json` means no project root, but the lock file still names the
    // manager that owns the store.
    const result = detectInEntries(['yarn.lock']);
    expect(result.isProjectRoot).toBe(false);
    expect(result.packageManager).toBe('yarn');
  });

  it('resolves two lock files by the catalog priority, not by argument order', () => {
    // A directory holding a migrating project's two lock files must give the
    // same answer whatever order its entries arrive in. `readdir` order is
    // filesystem-dependent, so the inference iterates `NODE_LOCKFILES` — which
    // is ordered most-specific-first (pnpm, yarn, bun, npm) — and the entry
    // order is irrelevant. Both spellings below must therefore agree.
    expect(detectInEntries(['yarn.lock', 'pnpm-lock.yaml']).packageManager).toBe('pnpm');
    expect(detectInEntries(['pnpm-lock.yaml', 'yarn.lock']).packageManager).toBe('pnpm');
  });

  it('prefers the more specific manager over npm whenever both are present', () => {
    expect(detectInEntries(['package-lock.json', 'pnpm-lock.yaml']).packageManager).toBe('pnpm');
    expect(detectInEntries(['package-lock.json', 'yarn.lock']).packageManager).toBe('yarn');
    expect(detectInEntries(['package-lock.json', 'bun.lockb']).packageManager).toBe('bun');
    expect(detectInEntries(['package-lock.json']).packageManager).toBe('npm');
  });
});

describe('detectInEntries ecosystem allow-list', () => {
  it('ignores markers for an ecosystem that is not enabled', () => {
    const result = detectInEntries(['Cargo.toml'], { enabledEcosystems: ['node'] });
    expect(result.isProjectRoot).toBe(false);
    expect(result.markers).toEqual([]);
  });

  it('keeps the enabled ecosystems of a mixed directory', () => {
    const result = detectInEntries(['package.json', 'Cargo.toml'], { enabledEcosystems: ['rust'] });
    expect(result.isProjectRoot).toBe(true);
    expect(result.ecosystems).toEqual(['rust']);
    expect(result.markers).toEqual(['Cargo.toml']);
  });

  it('suppresses package-manager inference when node is not enabled', () => {
    const result = detectInEntries(['package.json', 'yarn.lock'], { enabledEcosystems: ['rust'] });
    expect(result.packageManager).toBeNull();
  });
});

describe('catalog helpers', () => {
  it('exposes every marker name exactly once, sorted', () => {
    const expected = [...new Set(ECOSYSTEMS.flatMap((e) => e.markers.map((m) => m.marker)))].sort();
    expect(ALL_MARKER_NAMES).toEqual(expected);
  });

  it('looks up an ecosystem by id and names it in prose', () => {
    expect(getEcosystem('node')?.name).toBe('Node.js');
    expect(ecosystemName('rust')).toBe('Rust');
    // An unknown id falls back to the raw id rather than inventing a label.
    expect(ecosystemName('not-an-ecosystem')).toBe('not-an-ecosystem');
    expect(getEcosystem('not-an-ecosystem' as EcosystemId)).toBeUndefined();
  });
});
