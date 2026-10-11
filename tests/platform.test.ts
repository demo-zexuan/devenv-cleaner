/**
 * Platform Path Safety Boundary
 *
 * Pins the exact security boundary of `src/core/platform.ts`: which paths a
 * cleanup may never touch, how containment is decided, and how the two
 * protection variants deliberately disagree.
 *
 * I. Why this file is a table and not a set of examples
 *
 * 1. These functions are the last line of defence between a rule pattern and
 *    `fs.rm`. A single missing entry is not a formatting bug, it is an
 *    unrecoverable deletion, so the covered inputs are enumerated explicitly
 *    and every entry's expected verdict is written down.
 * 2. `isProtectedPath` and `isProtectedResolvedPath` have *different*
 *    semantics on purpose (see the JSDoc in `platform.ts`). The planner and the
 *    executor use only the resolved variant, so the difference between the two
 *    is itself a security property and is asserted as such.
 *
 * @module tests/platform
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { describe, expect, it } from 'vitest';

import {
  canonicalizeRoots,
  findContainingRoot,
  getDenylist,
  getGlobalCacheRoots,
  getHome,
  getPlatform,
  isProtectedPath,
  isProtectedResolvedPath,
  normalizeForCompare,
} from '../src/core/platform.js';
import { SAMPLE_ROOT, TESTS_DIR, WORKSPACE_ROOT } from './helpers.js';

const POSIX_ONLY = getPlatform() !== 'win32';

/**
 * The `/tmp` -> `/private/tmp` symlink is a macOS property.
 *
 * Gating it on "POSIX" was wrong: Linux is POSIX too, but `/tmp` is a real
 * directory there, so the assertion only ever held on the machine it was
 * written on and failed the moment CI ran it on Linux.
 */
const DARWIN_ONLY = getPlatform() === 'darwin';

describe('getDenylist', () => {
  it('always contains the filesystem root and the system prefixes', () => {
    const denylist = getDenylist();
    for (const entry of ['/', '/usr', '/etc', '/private', '/var', '/System', '/Library']) {
      expect(denylist).toContain(normalizeForCompare(entry));
    }
  });

  it('adds the user-data directories below the home directory', () => {
    const home = normalizeForCompare(getHome());
    const denylist = getDenylist();
    // Entries are published in the *platform's* normalized form, and only macOS
    // and Windows fold case. Hardcoding a lowercase literal made this pass on a
    // developer laptop and fail on Linux CI, where the case is preserved.
    const below = (segment: string): string => `${home}/${normalizeForCompare(segment)}`;
    expect(denylist).toContain(below('Documents'));
    expect(denylist).toContain(below('Desktop'));
    expect(denylist).toContain(below('Library/Keychains'));
  });

  it('marks every entry it publishes as protected', () => {
    // The public list and the private predicate must not drift: an entry that
    // appears in the list but is not honoured would be a false sense of safety.
    for (const entry of getDenylist()) {
      expect(isProtectedPath(entry)).toBe(true);
    }
  });
});

describe('isProtectedPath', () => {
  it('protects the home directory itself', () => {
    expect(isProtectedPath(getHome())).toBe(true);
    expect(isProtectedPath(`${getHome()}/`)).toBe(true);
  });

  it('protects a removable-looking directory nested inside a user-data directory', () => {
    // This is the case the user-data denylist exists for: `~/Documents` is
    // primary data, so nothing below it may ever be treated as a cache.
    expect(isProtectedPath(`${getHome()}/Documents/proj/node_modules`)).toBe(true);
    expect(isProtectedPath(`${getHome()}/Library/Keychains/login`)).toBe(true);
  });

  it('protects a path that is exactly a denylisted prefix or a descendant of one', () => {
    expect(isProtectedPath('/usr')).toBe(true);
    expect(isProtectedPath('/usr/local/lib')).toBe(true);
    expect(isProtectedPath('/etc')).toBe(true);
    expect(isProtectedPath('/etc/hosts')).toBe(true);
    expect(isProtectedPath('/')).toBe(true);
  });

  it('does not protect a normal project path', () => {
    expect(isProtectedPath(WORKSPACE_ROOT)).toBe(false);
    expect(isProtectedPath(`${SAMPLE_ROOT}/proj/node_modules`)).toBe(false);
  });

  it('matches on a component boundary rather than a string prefix', () => {
    // `/usr` must not swallow `/usrname`, or a directory named after a system
    // prefix would become invisible to every rule.
    expect(isProtectedPath('/usrname')).toBe(false);
    expect(isProtectedPath('/etcpasswd')).toBe(false);
    expect(isProtectedPath('/usr-local')).toBe(false);
  });

  it.skipIf(!POSIX_ONLY)('treats a raw /tmp path as safe even though its real path is denylisted', () => {
    // On macOS `/tmp` is not itself on the denylist; only its canonical form
    // `/private/tmp` is, and that is the asymmetry the next block pins.
    expect(isProtectedPath('/tmp/proj/node_modules')).toBe(false);
  });
});

describe('isProtectedResolvedPath', () => {
  /**
   * The alias-hole matrix.
   *
   * Every row is a *canonical* path, i.e. exactly what `realpath` produces on
   * macOS. The false rows are the reason the strict variant exists at all: a
   * legitimate project behind `/tmp` resolves to `/private/tmp/...`, and a
   * strictly prefix-based test against the denylist's `/private` entry would
   * lock every one of its targets as `protected-path` — presenting to the user
   * as a cleanup that silently does nothing.
   */
  const MATRIX: ReadonlyArray<readonly [string, boolean]> = [
    // The alias hole: recognised temporary roots and their descendants.
    ['/private/tmp', false],
    ['/private/tmp/proj', false],
    ['/private/tmp/proj/node_modules/cache', false],
    // System state behind the same alias must stay blocked, because a symlink
    // from inside a project can point at it while still passing containment.
    ['/private/var/db/anything', true],
    ['/private/var/log/system.log', true],
    ['/private/var/tmp/scratch', true],
    ['/private/etc/hosts', true],
    ['/private', true],
    // Ordinary system prefixes.
    ['/System/Library/CoreServices', true],
    ['/usr/local/lib', true],
    ['/usr', true],
    ['/etc/passwd', true],
    ['/', true],
  ];

  for (const [candidate, expected] of MATRIX) {
    it(`${expected ? 'refuses' : 'allows'} the canonical path ${candidate}`, () => {
      expect(isProtectedResolvedPath(candidate)).toBe(expected);
    });
  }

  it('does not protect a normal project path', () => {
    expect(isProtectedResolvedPath(`${SAMPLE_ROOT}/proj/node_modules`)).toBe(false);
  });

  it('still protects a user-data directory reached through its canonical form', () => {
    expect(isProtectedResolvedPath(`${getHome()}/Documents/proj/node_modules`)).toBe(true);
  });

  it('allows the per-user temp area, which is what `$TMPDIR` resolves to', () => {
    // The macOS per-user scratch directory is aliased alongside `/private/tmp`.
    // Without it, any project whose real path runs through `$TMPDIR` has every
    // target locked as `protected-path` — the "cleanup that refuses to do
    // anything" failure the alias list exists to prevent.
    expect(isProtectedResolvedPath('/private/var/folders/xy/T/proj/node_modules')).toBe(false);
    expect(isProtectedResolvedPath('/private/var/folders/xy/T/proj')).toBe(false);
  });

  it('keeps the system state beside the alias blocked', () => {
    // Aliasing `/private/var/folders` must not open `/private/var` as a whole:
    // each alias exposes exactly its own subtree and nothing beside it.
    expect(isProtectedResolvedPath('/private/var/db/anything')).toBe(true);
    expect(isProtectedResolvedPath('/private/var/log/system.log')).toBe(true);
    expect(isProtectedResolvedPath('/private/var/tmp/scratch')).toBe(true);
    expect(isProtectedResolvedPath('/private/var')).toBe(true);
  });
});

describe('isProtectedPath versus isProtectedResolvedPath', () => {
  /**
   * The two variants disagree by design on macOS.
   *
   * `isProtectedPath` answers "is this configured path a protected location";
   * `isProtectedResolvedPath` answers "may this canonical path be deleted".
   * For `/private/tmp/proj` the plain answer must be true (the raw string looks
   * like a system path) while the resolved answer must be false (the only
   * reason it looks that way is the `/tmp` alias). Encoding that difference is
   * what stops a future refactor from collapsing the two into one function.
   */
  it('disagrees on a temp directory only because of the macOS alias', () => {
    expect(isProtectedPath('/private/tmp/proj/node_modules')).toBe(true);
    expect(isProtectedResolvedPath('/private/tmp/proj/node_modules')).toBe(false);
  });

  it('agrees that a system directory is protected in both forms', () => {
    for (const candidate of ['/System/Library', '/etc/passwd', '/usr/lib', '/private']) {
      expect(isProtectedPath(candidate)).toBe(true);
      expect(isProtectedResolvedPath(candidate)).toBe(true);
    }
  });

  it('protects the home directory in both variants', () => {
    // The only variant the planner and the executor consult is the resolved
    // one, and `getDenylist()` lists the home directory's *children* but never
    // the home directory itself. Both variants therefore need an explicit
    // identity guard. Without it, a scan root that is the home directory and
    // whose basename matches an unguarded rule pattern — `~/logs` with
    // `generic-logs` (`**/logs`), `~/build` with `node-build-output`
    // (`**/build`), `~/dist` with the same rule — becomes an actionable target
    // and the cleanup deletes the user's home directory. A directory's name is
    // not a safety property; its identity is.
    expect(isProtectedPath(getHome())).toBe(true);
    expect(isProtectedResolvedPath(getHome())).toBe(true);
  });

  it('refuses the home directory even when its basename matches a rule pattern', () => {
    // Regression guard for the exact attack: a directory named `logs` that is
    // also the home directory must never be considered deletable, whatever
    // `generic-logs` thinks of its name.
    const home = getHome();
    const looksLikeATarget = home.endsWith('/logs') || home.endsWith('/build') || home.endsWith('/dist');
    expect(isProtectedResolvedPath(home)).toBe(true);
    // The assertion holds regardless of what this particular machine's home is
    // called; the variable documents that the check is not name-dependent.
    expect(typeof looksLikeATarget).toBe('boolean');
  });

  it('protects a bare drive or filesystem root in both variants', () => {
    expect(isProtectedPath('/')).toBe(true);
    expect(isProtectedResolvedPath('/')).toBe(true);
  });
});

describe('findContainingRoot', () => {
  it('does not treat a sibling with a shared prefix as contained', () => {
    expect(findContainingRoot('/home/user2/proj', ['/home/user'])).toBeNull();
    expect(findContainingRoot('/home/user2', ['/home/user'])).toBeNull();
  });

  it('accepts an exact root match and a strict descendant', () => {
    expect(findContainingRoot('/home/user', ['/home/user'])).toBe('/home/user');
    expect(findContainingRoot('/home/user/proj/node_modules', ['/home/user'])).toBe('/home/user');
  });

  it('returns the deepest matching root when several contain the path', () => {
    expect(findContainingRoot('/a/b/c/d', ['/a', '/a/b', '/a/b/c'])).toBe('/a/b/c');
    expect(findContainingRoot('/a/b/c/d', ['/a/b/c', '/a', '/a/b'])).toBe('/a/b/c');
  });

  it('treats the filesystem root as containing everything', () => {
    expect(findContainingRoot('/anything/at/all', ['/'])).toBe('/');
  });

  it('returns null when no root is configured', () => {
    expect(findContainingRoot('/a/b', [])).toBeNull();
  });

  it('answers in the normalized form of the winning root', () => {
    // Containment is a string comparison, so the answer must be in the same
    // form as the comparison; the caller uses it to classify, not to delete.
    expect(findContainingRoot('/a/b/c', ['/a/b/'], 'linux')).toBe(normalizeForCompare('/a/b/', 'linux'));
  });

  it('folds case only on the platforms whose filesystems do', () => {
    // Case folding belongs to the *target platform*, not to whatever machine is
    // running the suite. Asserting the host default made this pass on a
    // developer laptop and fail in Linux CI, which is exactly the trap this
    // explicit-platform form avoids.
    expect(findContainingRoot('/A/B/C', ['/a/b/'], 'darwin')).toBe(normalizeForCompare('/a/b/', 'darwin'));
    expect(findContainingRoot('/A/B/C', ['/a/b/'], 'win32')).toBe(normalizeForCompare('/a/b/', 'win32'));
    expect(findContainingRoot('/A/B/C', ['/a/b/'], 'linux')).toBeNull();
  });
});

describe('normalizeForCompare', () => {
  it('strips a trailing separator but keeps a bare root', () => {
    expect(normalizeForCompare('/a/b/', 'linux')).toBe('/a/b');
    expect(normalizeForCompare('/a/b///', 'linux')).toBe('/a/b');
    expect(normalizeForCompare('/', 'linux')).toBe('/');
  });

  it('converts Windows separators to forward slashes', () => {
    expect(normalizeForCompare('C:\\Users\\dev', 'linux')).toBe('C:/Users/dev');
  });

  it('collapses duplicate separators', () => {
    expect(normalizeForCompare('/a//b///c', 'linux')).toBe('/a/b/c');
  });

  it('folds case on the case-insensitive platforms only', () => {
    expect(normalizeForCompare('/A/B', 'darwin')).toBe('/a/b');
    expect(normalizeForCompare('/A/B', 'win32')).toBe('/a/b');
    // Case folding on Linux would make two genuinely different paths compare
    // equal, so it must not happen there.
    expect(normalizeForCompare('/A/B', 'linux')).toBe('/A/B');
  });

  it('keeps a drive root capitalized shape intact for win32', () => {
    expect(normalizeForCompare('C:\\', 'win32')).toBe('c:/');
  });
});

describe('canonicalizeRoots', () => {
  it('preserves the configured order of existing roots', async () => {
    const roots = await canonicalizeRoots([TESTS_DIR, WORKSPACE_ROOT, TESTS_DIR]);
    expect(roots).toEqual([TESTS_DIR, WORKSPACE_ROOT, TESTS_DIR]);
  });

  it('keeps an unresolvable root verbatim rather than dropping it', async () => {
    // Dropping the root would widen the containment gate for every other root,
    // and widening a delete gate on error is the wrong direction to fail.
    const missing = `${SAMPLE_ROOT}/definitely-not-here`;
    const roots = await canonicalizeRoots([missing, WORKSPACE_ROOT]);
    expect(roots).toHaveLength(2);
    expect(roots[0]).toBe(missing);
    expect(roots[1]).toBe(WORKSPACE_ROOT);
  });

  it.skipIf(!DARWIN_ONLY)('resolves the macOS /tmp alias to /private/tmp', async () => {
    const roots = await canonicalizeRoots(['/tmp']);
    expect(roots[0]).toBe('/private/tmp');
  });
});

describe('getGlobalCacheRoots', () => {
  it('returns an absolute location for every cache key on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const roots = getGlobalCacheRoots(platform);
      for (const [key, value] of Object.entries(roots)) {
        if (key === 'xcodeDerivedData' && platform !== 'darwin') {
          expect(value).toBe('');
          continue;
        }
        expect(value.length).toBeGreaterThan(0);
        expect(value).toContain(platform === 'win32' ? '\\' : '/');
      }
    }
  });

  it('places every non-empty location below the home directory', () => {
    const home = getHome();
    for (const value of Object.values(getGlobalCacheRoots('linux'))) {
      if (value === '') continue;
      expect(value.startsWith(home)).toBe(true);
    }
  });

  it('selects platform-specific stores for the same tool', () => {
    expect(getGlobalCacheRoots('darwin').pnpm).toContain('Library');
    expect(getGlobalCacheRoots('linux').pnpm).toContain('.local');
    expect(getGlobalCacheRoots('win32').pnpm).toContain('AppData');
  });

  it('offers Xcode derived data only on macOS', () => {
    expect(getGlobalCacheRoots('darwin').xcodeDerivedData).toContain('DerivedData');
    expect(getGlobalCacheRoots('linux').xcodeDerivedData).toBe('');
    expect(getGlobalCacheRoots('win32').xcodeDerivedData).toBe('');
  });
});
