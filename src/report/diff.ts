/**
 * Scan Report Diffing
 *
 * Compares two {@link ScanReport} snapshots and classifies every removable
 * directory as added, removed, grown, shrunk or unchanged.
 *
 * I. Why paths, not target ids, are the key
 *
 * 1. `CleanTarget.id` is derived from the rule id plus the absolute path, so it
 *    is stable *for a rule*. When the catalog changes, or when a directory stops
 *    matching one rule and starts matching another (`.next/cache` graduating
 *    from a cache rule to a build rule, say), the id changes while the directory
 *    on disk does not. Keying by id would report that as one removal plus one
 *    addition of the same bytes — noise that hides the real change.
 * 2. Keying by canonical path answers the question the user actually asked:
 *    "is this directory bigger than last week?"
 *
 * II. Why the comparison is unordered but the arguments are not
 *
 * 1. The algorithm itself only needs two keyed maps, so it would happily accept
 *    the pair in either order.
 * 2. The *report* it produces is directional: `deltaBytes` is `to - from` and
 *    the headline reads as "grew by X since the baseline". Handing it a newer
 *    report as `from` inverts every sign in the output while looking perfectly
 *    plausible, so the reversal is rejected loudly instead.
 *
 * @module report/diff
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { formatSignedBytes } from '../core/format.js';
import { normalizeForCompare } from '../core/platform.js';
import type { ReportDiff, ReportDiffEntry, ScanReport } from '../core/types.js';

/** Counts of each change classification, used by the CLI one-liner. */
interface DiffBreakdown {
  /** Paths that appeared since the older report. */
  readonly added: number;
  /** Paths that disappeared since the older report. */
  readonly removed: number;
  /** Paths present in both that grew. */
  readonly grew: number;
  /** Paths present in both that shrank. */
  readonly shrank: number;
}

/**
 * Compare two reports and produce the growth report.
 *
 * I. Classification
 *
 * 1. A path in `to` only is `added` (`fromBytes = 0`).
 * 2. A path in `from` only is `removed` (`toBytes = 0`).
 * 3. A path in both with a larger `toBytes` grew; smaller shrank; equal is
 *    `unchanged`.
 *
 * II. Why `unchanged` entries are dropped
 *
 * 1. The `ReportDiffEntry.change` union includes `unchanged`, so the contract
 *    can express "nothing happened" — and a caller that wants that as positive
 *    evidence can still re-derive it by keying the two reports itself.
 * 2. But a report of a developer's home directory routinely holds thousands of
 *    targets, the overwhelming majority of which did not change between two
 *    scans an hour apart. Returning them would bury the handful of rows the
 *    user opened the diff to read under thousands of identical ones, and would
 *    make the CLI summary line useless. A row whose delta is non-zero can never
 *    be classified `unchanged`, so this filter removes exactly the zero-delta
 *    noise and nothing else.
 *
 * III. Ordering
 *
 * 1. Entries are sorted by `|deltaBytes|` descending, then by path ascending,
 *    which is the contract's stated order and the order a growth report reads
 *    in. The path tie-break keeps two equal deltas stable across runs.
 *
 * @param from - The older report (the baseline).
 * @param to - The newer report.
 * @returns The net delta plus every changed path.
 * @throws An `Error` when `from` is newer than `to`, or when the reports cover
 *   different roots.
 */
export function diffReports(from: ScanReport, to: ScanReport): ReportDiff {
  // I. Guard the two preconditions that would silently produce nonsense.
  // 1. Reversed arguments invert every sign in the output; `from` must be the
  //    older scan. Both timestamps are ISO-8601, so the string comparison is
  //    chronological within one offset, and `Date.parse` catches mixed offsets.
  const fromMillis = Date.parse(from.scannedAt);
  const toMillis = Date.parse(to.scannedAt);
  const reversed =
    Number.isFinite(fromMillis) && Number.isFinite(toMillis)
      ? fromMillis > toMillis
      : from.scannedAt > to.scannedAt;
  if (reversed) {
    throw new Error(
      `diffReports requires the older report first: "from" was scanned at ${from.scannedAt} ` +
        `but "to" was scanned at ${to.scannedAt}`,
    );
  }

  // 2. Two different scan roots have no shared baseline: every target would be
  //    reported as added and every old one as removed, producing a diff that is
  //    technically correct and completely meaningless. Comparing roots from
  //    different machines is the same mistake, so a platform mismatch is only
  //    ever surfaced as part of a root mismatch message.
  if (normalizeForCompare(from.root) !== normalizeForCompare(to.root)) {
    throw new Error(
      `cannot diff reports from different scan roots: "${from.root}" (${from.platform}) ` +
        `vs "${to.root}" (${to.platform})`,
    );
  }

  // II. Index both sides by canonical path. A later duplicate path would be a
  //     contract violation; keeping the first occurrence makes it deterministic
  //     (both arrays arrive sorted by bytes descending) rather than
  //     order-of-iteration dependent.
  const fromIndex = indexByCanonicalPath(from);
  const toIndex = indexByCanonicalPath(to);

  const entries: ReportDiffEntry[] = [];

  for (const [key, target] of toIndex) {
    const previous = fromIndex.get(key);
    const fromBytes = previous?.bytes ?? 0;
    const toBytes = target.bytes;
    const deltaBytes = toBytes - fromBytes;

    // (1) Present in both: classify by the sign of the change. `ruleId` comes
    //     from the newer report, which is the rule that owns the path now.
    if (previous) {
      const change = deltaBytes > 0 ? 'grew' : deltaBytes < 0 ? 'shrank' : 'unchanged';
      if (change === 'unchanged') continue;
      entries.push({
        path: target.path,
        ruleId: target.ruleId,
        fromBytes,
        toBytes,
        deltaBytes,
        change,
      });
      continue;
    }

    // (2) New since the older report.
    if (deltaBytes !== 0) {
      entries.push({
        path: target.path,
        ruleId: target.ruleId,
        fromBytes: 0,
        toBytes,
        deltaBytes,
        change: 'added',
      });
    }
  }

  // III. Anything left in the older report is gone; the rule id can only come
  //      from the side that still knows it.
  for (const [key, target] of fromIndex) {
    if (toIndex.has(key)) continue;
    if (target.bytes === 0) continue;
    entries.push({
      path: target.path,
      ruleId: target.ruleId,
      fromBytes: target.bytes,
      toBytes: 0,
      deltaBytes: -target.bytes,
      change: 'removed',
    });
  }

  // IV. Biggest movement first, with a stable path tie-break.
  entries.sort((left, right) => {
    const leftMagnitude = Math.abs(left.deltaBytes);
    const rightMagnitude = Math.abs(right.deltaBytes);
    if (leftMagnitude !== rightMagnitude) return rightMagnitude - leftMagnitude;
    if (left.path === right.path) return 0;
    return left.path < right.path ? -1 : 1;
  });

  return {
    from,
    to,
    deltaBytes: to.summary.totalBytes - from.summary.totalBytes,
    entries,
  };
}

/**
 * Index a report's targets by canonical path.
 *
 * @param report - Report whose targets to index.
 * @returns A map from {@link normalizeForCompare} key to target.
 */
function indexByCanonicalPath(report: ScanReport): Map<string, ScanReport['targets'][number]> {
  const index = new Map<string, ScanReport['targets'][number]>();
  for (const target of report.targets) {
    const key = normalizeForCompare(target.path);
    if (!index.has(key)) index.set(key, target);
  }
  return index;
}

/**
 * Summarize how many paths fell into each change classification.
 *
 * @param entries - Diff entries, already filtered of zero-delta rows.
 * @returns Per-classification counts.
 */
function countChanges(entries: readonly ReportDiffEntry[]): DiffBreakdown {
  let added = 0;
  let removed = 0;
  let grew = 0;
  let shrank = 0;
  for (const entry of entries) {
    if (entry.change === 'added') added += 1;
    else if (entry.change === 'removed') removed += 1;
    else if (entry.change === 'grew') grew += 1;
    else if (entry.change === 'shrank') shrank += 1;
  }
  return { added, removed, grew, shrank };
}

/**
 * Render a one-line summary of a diff for CLI output.
 *
 * I. Shape
 *
 * 1. The net delta leads, because that is the number CI gates on and the number
 *    `--fail-on-growth` compares against.
 * 2. Absolute churn follows, because a net delta of zero can hide gigabytes
 *    moving in both directions — a `node_modules` reappearing while a build
 *    directory disappears is not "no change".
 * 3. It is one line with no `\n`, so the caller owns the layout, and it is
 *    plain ASCII-free of ANSI escapes, so it survives a pipe and a `NO_COLOR`
 *    terminal unchanged.
 *
 * @param diff - The computed diff.
 * @returns A single line such as
 *   `net +1.2 GB over 2 reports | 3 added, 1 removed, 5 grew, 2 shrank`.
 *
 * @example
 * ```ts
 * console.log(formatDiffSummary(diffReports(baseline, latest)))
 * ```
 */
export function formatDiffSummary(diff: ReportDiff): string {
  const counts = countChanges(diff.entries);
  let churn = 0;
  for (const entry of diff.entries) churn += Math.abs(entry.deltaBytes);

  const net = `net ${formatSignedBytes(diff.deltaBytes)}`;
  const routes =
    `${counts.added} added, ${counts.removed} removed, ` + `${counts.grew} grew, ${counts.shrank} shrank`;
  // The churn half is only worth printing when it disagrees with the net: for a
  // diff that only grew, `|net| === churn` and the extra number is noise.
  const churnPart = churn === Math.abs(diff.deltaBytes) ? '' : ` | ${formatSignedBytes(churn)} total churn`;
  return `${net} over 2 reports | ${routes}${churnPart}`;
}

/**
 * Select the fastest-growing paths from a diff.
 *
 * I. Semantics
 *
 * 1. Only positive deltas qualify: shrinking is good news and does not belong
 *    in a section headed "what grew".
 * 2. `limit` is a count, not a byte threshold, and a non-positive limit yields
 *    an empty list rather than the whole array — the caller asking for zero
 *    rows must not receive four thousand.
 *
 * @param diff - The computed diff.
 * @param limit - Maximum number of entries to return.
 * @returns Up to `limit` entries, largest growth first.
 */
export function topGrowth(diff: ReportDiff, limit: number): ReportDiffEntry[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const growing = diff.entries.filter((entry) => entry.deltaBytes > 0);
  // `entries` already arrives sorted by magnitude descending, so a prefix is
  // the answer; the sort is repeated only to keep the guarantee local to this
  // function rather than resting on the caller having used `diffReports`.
  growing.sort((left, right) => right.deltaBytes - left.deltaBytes);
  return growing.slice(0, Math.trunc(limit));
}
