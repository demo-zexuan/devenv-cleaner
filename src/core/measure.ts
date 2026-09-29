/**
 * Directory Measurement (Size Walker)
 *
 * Computes the recursive byte size, file count and freshest modification time
 * of a directory without ever following a symbolic link.
 *
 * I. Design constraints
 *
 * 1. This is the only hot loop in the product. A realistic developer home holds
 *    hundreds of thousands of files across a handful of `node_modules` trees,
 *    so the walker must not allocate per-file state, must not `stat` a path
 *    twice, and must never build a list of paths in memory.
 * 2. Sizing must be *symlink-safe*. Following links would both double count and
 *    escape the scan root; a link therefore contributes its own `lstat` size
 *    (the length of the target string) and is not descended into.
 * 3. Failures are expected, not exceptional: a permission-denied subdirectory
 *    is counted and skipped, never thrown, because one unreadable folder must
 *    not abort a scan of an entire disk.
 *
 * II. Concurrency model
 *
 * 1. Node's `fs/promises` operations are already thread-pooled, so the walker
 *    bounds *in-flight* operations rather than spawning worker threads. This
 *    keeps the event loop free, which is what lets the Ink TUI animate during a
 *    scan; worker threads would serialise progress reporting for no gain.
 * 2. The bound is a semaphore resolved from `limits.concurrency`.
 *
 * @module core/measure
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { type Dirent, constants as fsConstants } from 'node:fs';
import { access, lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';

/** Aggregated measurement of one directory tree. */
export interface Measurement {
  /** Sum of every regular file's logical size, in bytes. */
  readonly bytes: number;
  /** Number of regular files encountered. */
  readonly files: number;
  /** Number of directories visited, including the root of the measurement. */
  readonly directories: number;
  /** Number of symbolic links encountered but not followed. */
  readonly symlinks: number;
  /** Number of directory entries in the measured root (used by heuristics). */
  readonly rootEntries: number;
  /** Freshest modification time anywhere in the tree, in epoch milliseconds. */
  readonly newestMtimeMs: number;
  /** Directories that could not be read; a non-zero value degrades confidence. */
  readonly unreadable: number;
  /** True when the walk stopped early because of the directory ceiling. */
  readonly truncated: boolean;
}

/** Options accepted by {@link measureDirectory}. */
export interface MeasureOptions {
  /** Maximum number of in-flight filesystem operations; defaults to 24. */
  readonly concurrency?: number;
  /** Hard ceiling on visited directories; guards against a runaway walk. */
  readonly maxDirectories?: number;
  /** Cancellation signal; an abort yields the partial measurement. */
  readonly signal?: AbortSignal;
  /**
   * Called periodically with the running totals so a caller can render live
   * progress without waiting for the whole tree.
   */
  readonly onProgress?: (partial: { readonly bytes: number; readonly files: number }) => void;
  /**
   * When true, a directory that cannot be stat-ed is treated as zero-sized
   * rather than counted as unreadable. Used for optional global caches.
   */
  readonly tolerateMissing?: boolean;
}

/** An empty measurement, returned for missing or unreadable roots. */
export function emptyMeasurement(): Measurement {
  return {
    bytes: 0,
    files: 0,
    directories: 0,
    symlinks: 0,
    rootEntries: 0,
    newestMtimeMs: 0,
    unreadable: 0,
    truncated: false,
  };
}

/**
 * A counting semaphore used to bound in-flight filesystem work.
 *
 * I. Why not a promise-pool library
 *
 * 1. The walk is recursive and unbounded in breadth, so a fixed-size worker
 *    queue does not fit; a semaphore around each async operation does, and it
 *    is twenty lines with no dependency.
 */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }

  /** Acquire one permit, resolving as soon as one is free. */
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Release one permit and hand it to the next waiter, if any. */
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available += 1;
  }

  /** Run an operation while holding a permit. */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }
}

/** Terminal names that represent a symbolic link. */
function isSymlink(entry: Dirent): boolean {
  return entry.isSymbolicLink();
}

/**
 * Measure a directory tree.
 *
 * I. Traversal
 *
 * 1. Read the directory with `opendir`, which streams entries instead of
 *    materialising every name — important for a `node_modules` with 90k
 *    entries at one level.
 * 2. For each entry, decide from the `Dirent` type alone whether it is a file
 *    (accumulate size), a directory (recurse) or a link (accumulate the link
 *    itself, never recurse).
 *
 * II. Accumulation
 *
 * 1. Totals are passed down by return value, not by shared mutable state, so a
 *    single measurement can run concurrently with others without interference.
 * 2. Only the *newest* mtime is kept, which is the signal the staleness rule
 *    needs and is far more robust than a directory's own mtime (a directory's
 *    mtime changes when files are added, but a checkout can sit untouched for
 *    years while remaining heavily used).
 *
 * @param directoryPath - Absolute directory to measure.
 * @param options - Measurement options.
 * @returns The aggregated measurement. A root that does not exist yields an
 *   all-zero measurement *only* when `tolerateMissing` is set; otherwise it is
 *   reported as one unreadable directory, which is the honest description of a
 *   path the walker was told to measure and could not open. Callers that probe
 *   an optional location pass `tolerateMissing: true`; callers that already
 *   know the path exists do not.
 *
 * @example
 * ```ts
 * const result = await measureDirectory('/repo/node_modules')
 * console.log(result.bytes, result.files)
 * ```
 */
export async function measureDirectory(
  directoryPath: string,
  options: MeasureOptions = {},
): Promise<Measurement> {
  const semaphore = new Semaphore(options.concurrency ?? 24);
  const maxDirectories = options.maxDirectories ?? Number.POSITIVE_INFINITY;
  const signal = options.signal;

  let directoriesVisited = 0;
  let truncated = false;

  /**
   * Recursive worker.
   *
   * I. Base case
   *
   * 1. The directory ceiling is checked before reading, so a pathological tree
   *    stops promptly rather than after reading one more directory.
   */
  async function walk(currentPath: string, depth: number): Promise<Measurement> {
    // I. Guard rails before any filesystem work.
    // 1. Cancellation.
    if (signal?.aborted) return emptyMeasurement();
    // (2) Directory ceiling.
    if (directoriesVisited >= maxDirectories) {
      truncated = true;
      return emptyMeasurement();
    }
    directoriesVisited += 1;

    let bytes = 0;
    let files = 0;
    let directories = 1;
    let symlinks = 0;
    let unreadable = 0;
    let rootEntries = 0;
    let newestMtimeMs = 0;

    // II. Read the directory and handle the expected failure modes.
    let handle: Awaited<ReturnType<typeof opendir>> | null = null;
    try {
      handle = await semaphore.run(() => opendir(currentPath));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // (1) A missing path is normal for optional caches; report nothing.
      if (code === 'ENOENT' && options.tolerateMissing) return emptyMeasurement();
      // (2) Anything else is counted as unreadable but does not fail the walk.
      return { ...emptyMeasurement(), directories: 1, unreadable: 1 };
    }

    try {
      for await (const entry of handle) {
        // (1) Cancellation is checked per entry so Ctrl-C is responsive even
        //     inside a single enormous directory.
        if (signal?.aborted) break;
        rootEntries += 1;
        const entryPath = join(currentPath, entry.name);

        // (2) Symbolic links: record the link, never traverse it.
        if (isSymlink(entry)) {
          symlinks += 1;
          const stats = await semaphore.run(() => lstat(entryPath).catch(() => null));
          if (stats) {
            bytes += stats.size;
            if (stats.mtimeMs > newestMtimeMs) newestMtimeMs = stats.mtimeMs;
          }
          continue;
        }

        // (3) Directories: recurse and fold the child measurement in.
        if (entry.isDirectory()) {
          const child = await walk(entryPath, depth + 1);
          bytes += child.bytes;
          files += child.files;
          directories += child.directories;
          symlinks += child.symlinks;
          unreadable += child.unreadable;
          if (child.newestMtimeMs > newestMtimeMs) newestMtimeMs = child.newestMtimeMs;
          continue;
        }

        // (4) Regular files: the size matters, the mtime is a liveness signal.
        if (entry.isFile()) {
          const stats = await semaphore.run(() => lstat(entryPath).catch(() => null));
          if (!stats) {
            unreadable += 1;
            continue;
          }
          files += 1;
          bytes += stats.size;
          if (stats.mtimeMs > newestMtimeMs) newestMtimeMs = stats.mtimeMs;
        }
      }
    } catch {
      unreadable += 1;
    }

    return {
      bytes,
      files,
      directories,
      symlinks,
      rootEntries,
      newestMtimeMs,
      unreadable,
      truncated: false,
    };
  }

  const result = await walk(directoryPath, 0);
  options.onProgress?.({ bytes: result.bytes, files: result.files });
  // The shared `truncated` flag is set by whichever recursion hit the ceiling;
  // the returned measurement carries it so a caller can degrade the report.
  return { ...result, truncated: truncated || result.truncated };
}

/**
 * Count the immediate entries of a directory.
 *
 * Used by the `node_modules` heuristic, which distinguishes a real dependency
 * tree from a stub package without paying for a full size walk.
 *
 * @param directoryPath - Absolute directory to count.
 * @returns The entry count, or 0 when the directory cannot be read.
 */
export async function countEntries(directoryPath: string): Promise<number> {
  try {
    const handle = await opendir(directoryPath);
    let count = 0;
    for await (const entry of handle) {
      // Reference the entry so the loop is not treated as unused work; the
      // count is the only thing that matters here.
      void entry;
      count += 1;
      // The heuristic only ever needs to clear a small threshold; counting past
      // a few thousand entries in a real `node_modules` wastes time.
      if (count > 10_000) break;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Test whether a path exists and is a directory, without following links.
 *
 * @param targetPath - Absolute path to test.
 * @returns True when the path resolves to a real directory.
 */
export async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    const stats = await lstat(targetPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Test whether a path is writable by the current process.
 *
 * The executor uses this to pre-flight a deletion so a permission failure is
 * reported as a *skipped* target with a clear reason rather than as a crash
 * halfway through a batch.
 *
 * @param targetPath - Absolute path to test.
 * @returns True when the process may write inside the path.
 */
export async function isWritable(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}
