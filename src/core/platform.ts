/**
 * Platform and Filesystem Primitives
 *
 * Every operating-system specific assumption in DevEnvClean lives here, so the
 * scanning and rule layers can stay platform-agnostic and unit-testable.
 *
 * I. Responsibilities
 *
 * 1. Resolve the user's home directory and the per-platform global cache roots.
 * 2. Classify paths that must never be deleted, independent of user config.
 * 3. Decide whether a path is inside a scan root, which is the containment
 *    gate that stops a rule pattern from escaping the tree the user asked for.
 *
 * II. Why the denylist is code and not config
 *
 * 1. A user can legitimately want to clean `~/Library/Caches/pnpm` but never
 *    `~/Library` or `/System`; a configurable denylist invites a typo that
 *    nukes a home directory, so the floor is hard-coded and non-negotiable.
 * 2. Users may still *extend* it through the whitelist in `dvc.config.json`.
 *
 * @module core/platform
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/** Supported host platforms, narrowed from `process.platform`. */
export type SupportedPlatform = 'darwin' | 'linux' | 'win32';

/** Resolve the host platform, falling back to linux semantics on the exotic. */
export function getPlatform(): SupportedPlatform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'linux';
}

/** The current user's home directory, with no trailing separator. */
export function getHome(): string {
  return homedir().replace(/[\\/]+$/, '');
}

/**
 * Return the platform-correct path flavour.
 *
 * Rule patterns are compared against normalized absolute paths, so all path
 * arithmetic must go through one flavour rather than string concatenation.
 */
export function pathFlavour(): typeof posix | typeof win32 {
  return getPlatform() === 'win32' ? win32 : posix;
}

/**
 * Absolute path fragments that are never deleted, on any platform.
 *
 * Each entry is matched as a whole path component prefix after normalizing
 * separators, so `/usr` blocks `/usr/local/lib` but not `/usrx`.
 */
const POSIX_DENYLIST: readonly string[] = [
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/opt',
  '/proc',
  '/root',
  '/sbin',
  '/srv',
  '/sys',
  '/usr',
  '/var',
  '/System',
  '/Library',
  '/Applications',
  '/private',
  '/Volumes',
  '/cores',
];

/** Windows drive-root denylist, kept separate because the separators differ. */
const WIN32_DENYLIST: readonly string[] = [
  'C:\\',
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\Users',
];

/**
 * User-level directories that hold primary data rather than expendable caches.
 *
 * These are denylisted even under the home directory because the scan root is
 * frequently `~` itself, and a broad rule pattern must not reach a user's
 * documents, photos or source of truth.
 */
const USER_DATA_DENYLIST_POSIX: readonly string[] = [
  'Desktop',
  'Documents',
  'Downloads',
  'Movies',
  'Music',
  'Pictures',
  'Public',
  'Library/Application Support',
  'Library/Containers',
  'Library/Group Containers',
  'Library/Keychains',
  'Library/Mail',
  'Library/Messages',
  'Library/Mobile Documents',
  'Library/Preferences',
  'Library/Saved Application State',
];

/** Windows equivalents of the user-data denylist. */
const USER_DATA_DENYLIST_WIN32: readonly string[] = [
  'Desktop',
  'Documents',
  'Downloads',
  'Favorites',
  'Links',
  'OneDrive',
  'Pictures',
  'Saved Games',
  'Videos',
  'AppData\\Local\\Microsoft',
  'AppData\\Roaming\\Microsoft',
];

/**
 * Normalize a path for comparison.
 *
 * I. Normalization rules
 *
 * 1. Windows separators become `/` so one comparison routine works everywhere.
 * 2. A trailing separator is stripped, except for a bare root (`/` or `C:/`).
 * 3. Case is folded on Windows and macOS, because both default to
 *    case-insensitive filesystems and a deny that misses by case is a delete.
 */
export function normalizeForCompare(rawPath: string, platform = getPlatform()): string {
  let value = rawPath.replace(/\\/g, '/');
  // Collapse duplicate separators. Note this also flattens a leading `//`
  // UNC marker, so a Windows network path compares as a local one. That is
  // acceptable here because this function feeds *containment and denylist*
  // comparisons, where over-normalizing can only make a path look like it is
  // inside a protected location — the safe direction. It must not be used to
  // reconstruct a path for the filesystem.
  value = value.replace(/\/{2,}/g, '/');
  const isRoot = /^([a-zA-Z]:)?\/$/.test(value);
  if (!isRoot) value = value.replace(/\/+$/, '');
  return platform === 'linux' ? value : value.toLowerCase();
}

/**
 * Build the effective denylist for a platform.
 *
 * @param platform - Target platform; defaults to the host platform.
 * @returns Every denied absolute prefix, normalized for comparison.
 */
export function getDenylist(platform = getPlatform()): string[] {
  const home = normalizeForCompare(getHome(), platform);
  const base = platform === 'win32' ? WIN32_DENYLIST : POSIX_DENYLIST;
  const userData = platform === 'win32' ? USER_DATA_DENYLIST_WIN32 : USER_DATA_DENYLIST_POSIX;
  const homeEntries = userData.map((entry) => `${home}/${normalizeForCompare(entry, platform)}`);
  return [...base.map((entry) => normalizeForCompare(entry, platform)), ...homeEntries];
}

/**
 * Test whether a path is protected by the built-in denylist.
 *
 * I. Matching semantics
 *
 * 1. The path is normalized once, then compared against every prefix.
 * 2. A prefix matches only on a component boundary, so `/usrname` is not
 *    caught by `/usr`.
 * 3. The home directory itself is always protected.
 *
 * @param targetPath - Absolute path to test.
 * @param platform - Target platform; defaults to the host platform.
 * @returns True when the path must never be deleted.
 */
export function isProtectedPath(targetPath: string, platform = getPlatform()): boolean {
  const candidate = normalizeForCompare(targetPath, platform);
  const home = normalizeForCompare(getHome(), platform);

  // I. The home directory itself, and every drive root, are unconditional stops.
  if (candidate === home) return true;
  if (/^([a-z]:)?\/$/.test(candidate)) return true;

  // II. A path that *contains* a denied user-data directory is protected.
  //     This catches `~/Documents/project/node_modules`, which no rule should
  //     ever be allowed to touch even though it looks like a clean target.
  for (const entry of getDenylist(platform)) {
    // (1) Exact match or directory-boundary prefix match.
    if (candidate === entry) return true;
    if (candidate.startsWith(`${entry}/`)) return true;
  }
  return false;
}

/**
 * Test whether a *symlink-resolved* path lands inside a system-protected area.
 *
 * I. Why this differs from {@link isProtectedPath}
 *
 * 1. It is applied to the canonical path produced by `realpath`, where the
 *    separators carry no meaning for the user but a great deal for safety.
 * 2. Every entry in the denylist that is a *container of a useful location*
 *    must be exempt, or the check becomes useless. On macOS `/tmp` is a symlink
 *    to `/private/tmp`, so a strictly prefix-based test against a denylist that
 *    contains `/private` marks every legitimate temp directory as protected —
 *    a false positive that would silently refuse deletion for any user whose
 *    project lives behind an aliased path.
 * 3. The entry is therefore honoured only when the resolved path is that entry
 *    itself or a *strict descendant that is not itself a recognised alias*, as
 *    enumerated in {@link RESOLVED_ALIAS_ROOTS}.
 *
 * II. Why the unconditional guards are repeated here
 *
 * 1. `getDenylist()` lists the *children* of the home directory (so that
 *    `~/Documents/project/node_modules` is refused) but never the home
 *    directory itself. The plain variant adds that guard explicitly; this one
 *    must repeat it, because this is the variant the planner and the executor
 *    actually consult.
 * 2. Without the guard, a scan root that is the home directory and whose
 *    basename happens to match a rule pattern — `~/logs`, `~/build`, `~/dist`,
 *    `~/target` — becomes an actionable target for that rule, and the cleanup
 *    deletes the user's home directory. The directory's *name* is not a
 *    safety property; its identity is.
 * 3. Drive roots are guarded for the same reason `isProtectedPath` guards them:
 *    a filesystem root is never a cleanup target.
 *
 * @param resolvedPath - Canonical path, as returned by `realpath`.
 * @param platform - Target platform; defaults to the host platform.
 * @returns True when the canonical path must not be deleted.
 */
export function isProtectedResolvedPath(resolvedPath: string, platform = getPlatform()): boolean {
  const candidate = normalizeForCompare(resolvedPath, platform);

  // I. Identity guards, evaluated before any prefix logic. A path is protected
  //    because of *what it is*, not because of what it is called.
  if (candidate === normalizeForCompare(getHome(), platform)) return true;
  if (/^([a-z]:)?\/$/.test(candidate)) return true;

  for (const entry of getDenylist(platform)) {
    if (candidate === entry) return true;
    if (!candidate.startsWith(`${entry}/`)) continue;

    // II. A descendant is only blocked when no alias in the path legitimately
    //     accounts for the prefix. `aliasOwns` returns the alias that covers the
    //     candidate, if any.
    if (!aliasOwns(candidate, platform)) return true;
  }
  return false;
}

/**
 * Recognised symlink aliases whose descendants are legitimate scan territory.
 *
 * I. Why this list is deliberately tiny
 *
 * 1. Each entry is a hole punched through the denylist, so an over-broad entry
 *    is a real vulnerability rather than a convenience. Aliasing a directory
 *    exposes exactly its subtree and nothing beside it, which is why the list
 *    names the two temporary-directory locations rather than their parent
 *    `/private/var`.
 * 2. `/private/var/db`, `/private/var/log` and `/private/var/tmp` are
 *    intentionally absent. They hold system state, and containment against the
 *    configured roots is not sufficient protection on its own: a symlink from
 *    inside a project root can point anywhere, including at those directories.
 *
 * II. Why these two entries are safe and necessary
 *
 * 1. `/private/tmp` is where macOS's `/tmp` resolves. Without the entry, every
 *    cleanup performed under `/tmp` is refused as `protected-path`.
 * 2. `/private/var/folders` is where macOS puts `$TMPDIR`, the per-user
 *    scratch area that `os.tmpdir()` returns. It is user-owned disposable
 *    data, it sits beside `/private/var/db` rather than containing it, and
 *    without the entry any project whose real path runs through `$TMPDIR` gets
 *    every target locked — the "cleanup silently does nothing" failure this
 *    list exists to prevent.
 * 3. Linux needs no entry: `/tmp` and `/var/tmp` are real directories there and
 *    are themselves denylisted, so a clean target never resolves through an
 *    unexpected prefix.
 */
const RESOLVED_ALIAS_ROOTS: readonly string[] = ['/private/tmp', '/private/var/folders'];

/**
 * Test whether a canonical path sits under a recognised alias root.
 *
 * @param candidate - Normalized canonical path.
 * @param platform - Target platform.
 * @returns The covering alias, or null when the path is not aliased.
 */
function aliasOwns(candidate: string, platform = getPlatform()): string | null {
  const aliases = platform === 'win32' ? [] : RESOLVED_ALIAS_ROOTS;
  let best: string | null = null;
  for (const alias of aliases) {
    const normalized = normalizeForCompare(alias, platform);
    if (candidate !== normalized && !candidate.startsWith(`${normalized}/`)) continue;
    if (best === null || normalized.length > best.length) best = normalized;
  }
  return best;
}

/**
 * Test whether a path is contained by one of the scan roots.
 *
 * I. Why this gate exists
 *
 * 1. Rules match glob patterns against absolute paths; a pattern as broad as
 *    "any directory named target" would happily match a directory on another
 *    volume that the user never asked to scan.
 * 2. Containment is therefore checked against the roots the user supplied,
 *    with a component-boundary comparison so `/home/user2` is not treated as
 *    inside `/home/user`.
 *
 * @param targetPath - Absolute path to test.
 * @param roots - Absolute scan roots.
 * @param platform - Target platform; defaults to the host platform.
 * @returns The containing root, or null when the path is outside every root.
 */
export function findContainingRoot(
  targetPath: string,
  roots: readonly string[],
  platform = getPlatform(),
): string | null {
  const candidate = normalizeForCompare(targetPath, platform);
  let best: string | null = null;

  for (const root of roots) {
    const normalizedRoot = normalizeForCompare(root, platform);
    const inside =
      candidate === normalizedRoot || normalizedRoot === '/' || candidate.startsWith(`${normalizedRoot}/`);
    // Prefer the deepest matching root so nested scan roots report correctly.
    if (inside && (best === null || normalizedRoot.length > best.length)) {
      best = normalizedRoot;
    }
  }
  return best;
}

/**
 * Resolve scan roots to their canonical form.
 *
 * I. Why this exists as a shared helper
 *
 * 1. Containment is a string comparison, so both sides must be in the same
 *    form. A user who scans `/tmp/project` on macOS supplies a root that
 *    canonicalises to `/private/tmp/project`, while a `realpath`-based check
 *    compares against the canonical form of the target — and `/tmp/x` is not a
 *    prefix of `/private/tmp/y`. Comparing the two forms is what makes a
 *    legitimate cleanup of an aliased directory work at all.
 * 2. Keeping one implementation stops the planner and the executor from
 *    disagreeing about whether a path is inside a root, which would present as
 *    a target that previews as actionable and then refuses to delete.
 *
 * II. Failure handling
 *
 * 1. A root that cannot be resolved keeps its configured form. Dropping it
 *    would widen the containment gate, and widening a safety gate on error is
 *    the wrong direction to fail.
 *
 * @param roots - Configured roots, absolute.
 * @returns The same roots in canonical form, order preserved.
 */
export async function canonicalizeRoots(roots: readonly string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    try {
      resolved.push(await realpath(root));
    } catch {
      resolved.push(root);
    }
  }
  return resolved;
}

/**
 * Standard library directory names per platform.
 *
 * Returned as bare names for the ecosystem detector, which probes candidate
 * library roots for known project markers instead of trusting a fixed list.
 */ export function getLibraryDirNames(platform = getPlatform()): string[] {
  if (platform === 'darwin') return ['Library'];
  if (platform === 'win32') return ['AppData'];
  return ['.local', '.config'];
}

/** Absolute path builders for the global cache roots a scan may report on. */
export interface GlobalCacheRoots {
  /** npm content-addressable cache. */
  readonly npm: string;
  /** pnpm content-addressable store. */
  readonly pnpm: string;
  /** Yarn Berry cache. */
  readonly yarn: string;
  /** Cargo registry and git checkouts. */
  readonly cargo: string;
  /** Go module cache. */
  readonly goMod: string;
  /** Gradle dependency and build caches. */
  readonly gradle: string;
  /** Maven local repository. */
  readonly maven: string;
  /** pip and uv download caches. */
  readonly pip: string;
  readonly uv: string;
  /** macOS Xcode derived data, empty on other platforms. */
  readonly xcodeDerivedData: string;
}

/**
 * Compute the conventional global cache locations for a platform.
 *
 * These are *candidates*: the scanner only reports the ones that exist, so a
 * developer who has never used Cargo sees no Cargo row rather than an empty one.
 */
export function getGlobalCacheRoots(platform = getPlatform()): GlobalCacheRoots {
  const home = getHome();
  const flavour = platform === 'win32' ? win32 : posix;
  const join = (...parts: string[]): string => flavour.join(home, ...parts);

  // I. macOS keeps most caches under ~/Library/Caches and ~/Library.
  if (platform === 'darwin') {
    return {
      npm: join('.npm', '_cacache'),
      pnpm: join('Library', 'Caches', 'pnpm'),
      yarn: join('Library', 'Caches', 'Yarn'),
      cargo: join('.cargo', 'registry'),
      goMod: join('go', 'pkg', 'mod'),
      gradle: join('.gradle', 'caches'),
      maven: join('.m2', 'repository'),
      pip: join('Library', 'Caches', 'pip'),
      uv: join('Library', 'Caches', 'uv'),
      xcodeDerivedData: join('Library', 'Developer', 'Xcode', 'DerivedData'),
    };
  }

  // II. Windows uses per-tool AppData locations plus a few dot-directories.
  if (platform === 'win32') {
    return {
      npm: join('AppData', 'Local', 'npm-cache', '_cacache'),
      pnpm: join('AppData', 'Local', 'pnpm', 'store'),
      yarn: join('AppData', 'Local', 'Yarn', 'Cache'),
      cargo: join('.cargo', 'registry'),
      goMod: join('go', 'pkg', 'mod'),
      gradle: join('.gradle', 'caches'),
      maven: join('.m2', 'repository'),
      pip: join('AppData', 'Local', 'pip', 'Cache'),
      uv: join('AppData', 'Local', 'uv', 'cache'),
      xcodeDerivedData: '',
    };
  }

  // III. Linux follows the XDG cache layout.
  return {
    npm: join('.npm', '_cacache'),
    pnpm: join('.local', 'share', 'pnpm', 'store'),
    yarn: join('.cache', 'yarn'),
    cargo: join('.cargo', 'registry'),
    goMod: join('go', 'pkg', 'mod'),
    gradle: join('.gradle', 'caches'),
    maven: join('.m2', 'repository'),
    pip: join('.cache', 'pip'),
    uv: join('.cache', 'uv'),
    xcodeDerivedData: '',
  };
}
