/**
 * TUI Report Diff View
 *
 * Two scans compared: the net byte change, the instants the two reports were
 * taken, and the individual directories that account for the difference.
 *
 * I. Direction, not severity
 *
 * 1. A negative delta is good news — space came back — and is drawn in the
 *    success ink; a positive delta consumed space and is drawn in `danger`; an
 *    exact zero is neither and stays muted. Colouring a shrink as a problem is
 *    the one mistake a growth report cannot afford.
 * 2. The sign is also in the text of every row, so the reading survives
 *    `theme.plain`, a monochrome terminal and a screenshot. Colour reinforces the
 *    sign; it never carries it alone.
 *
 * II. Rows come from the contract, in contract order
 *
 * 1. `diff.entries` is already sorted by absolute delta descending, so the rows
 *    that matter come first and `limit` is a truncation rather than a filter.
 *    Unchanged paths sort last behind every changed one and therefore only appear
 *    when the caller deliberately asks for a long list; their classification is
 *    still rendered rather than assumed away.
 * 2. The view never re-sorts: two front-ends disagreeing about the order of the
 *    same report would make the diff untrustworthy.
 *
 * III. Timestamps are shown as stored
 *
 * 1. `scannedAt` is issued by the report writer as an ISO-8601 instant, so it is
 *    rendered exactly as written. Re-formatting it through the host timezone
 *    would silently change the value the two reports are compared against.
 *
 * @module tui/components/DiffView
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { displayWidth, ellipsizePath, formatSignedBytes, pad } from '../../core/format.js';
import type { ReportDiff, ReportDiffEntry } from '../../core/types.js';
import { type Theme, textStyle } from '../theme.js';

/** Props accepted by {@link DiffView}. */
export interface DiffViewProps {
  /** Comparison of two scans whose entries are sorted by absolute delta. */
  readonly diff: ReportDiff;
  /** Maximum number of entry rows, on top of the height budget. */
  readonly limit: number;
  /** Total terminal width in columns. */
  readonly width: number;
  /** Total terminal height in rows; the view never renders more than this. */
  readonly height: number;
  /** Active theme. */
  readonly theme: Theme;
  /** Localised labels. `net` may carry a `{delta}` slot. */
  readonly labels: {
    readonly net: string;
    readonly grew: string;
    readonly shrank: string;
    readonly added: string;
    readonly removed: string;
    readonly noChange: string;
    readonly from: string;
    readonly to: string;
  };
}

/** Localised label keys for the five change classifications. */
type ChangeLabelKey = 'grew' | 'shrank' | 'added' | 'removed' | 'noChange';

/** Signed-size column width; `-1023.9 KB` is the widest value produced. */
const DELTA_WIDTH = 10;
/** Gutter between two cells of a row. */
const GAP = '  ';
/** Narrowest change-label column; the classification is never cut below this. */
const CHANGE_MIN_WIDTH = 6;
/** Widest change-label column; longer localised labels are ellipsized. */
const CHANGE_MAX_WIDTH = 12;
/** From this width the two timestamps share one row. */
const TIMESTAMPS_SIDE_BY_SIDE = 64;

/** Classification → localised label key. */
const CHANGE_KEY: Readonly<Record<ReportDiffEntry['change'], ChangeLabelKey>> = {
  added: 'added',
  removed: 'removed',
  grew: 'grew',
  shrank: 'shrank',
  unchanged: 'noChange',
};

/**
 * Palette token for a net delta.
 *
 * @param theme - Active theme.
 * @param delta - Signed byte change.
 * @returns The ink the change direction earns.
 */
function deltaColor(theme: Theme, delta: number): string {
  if (delta < 0) return theme.colors.success;
  if (delta > 0) return theme.colors.danger;
  return theme.colors.muted;
}

/**
 * Palette token for one change classification.
 *
 * @param theme - Active theme.
 * @param change - Classification of the entry.
 * @returns The ink that classification earns.
 */
function changeColor(theme: Theme, change: ReportDiffEntry['change']): string {
  switch (change) {
    case 'added':
    case 'grew':
      return theme.colors.danger;
    case 'removed':
    case 'shrank':
      return theme.colors.success;
    case 'unchanged':
      return theme.colors.muted;
  }
}

/**
 * Compose a labelled value that may already be a template.
 *
 * I. Why both spellings are accepted
 *
 * 1. The message table stores the headline as `Net change: {delta}`, while a
 *    caller that has already interpolated it passes a finished label. Both reach
 *    this component, and a helper that understood only one of them would render a
 *    literal `{delta}` where the headline number belongs.
 * 2. A label with no slot is treated as a name and gains the usual separator, so
 *    the two contracts converge on the same sentence.
 *
 * @param label - Label or template.
 * @param slot - Slot name the template may carry.
 * @param value - Already-formatted value.
 * @returns The composed headline.
 */
function composeSlot(label: string, slot: string, value: string): string {
  const placeholder = `{${slot}}`;
  if (label.includes(placeholder)) return label.split(placeholder).join(value);
  const trimmed = label.endsWith(':') || label.endsWith('：') ? label : `${label}:`;
  return `${trimmed} ${value}`;
}

/**
 * Render the report comparison.
 *
 * I. Row budget
 *
 * 1. The headline is the point of the screen and is always rendered; the
 *    timestamps come next, then a separating rule, then as many entries as the
 *    caller's `limit` and the remaining height allow, whichever is smaller.
 * 2. The two timestamps share a row only when both fit with a gutter; otherwise
 *    each gets its own row, which costs one row more but keeps both readable.
 *
 * @param props - The diff, a row limit and the frame size.
 * @returns A comparison sized to `width` x `height`.
 */
export function DiffView({ diff, limit, width, height, theme, labels }: DiffViewProps): ReactNode {
  const frameWidth = Math.max(0, Math.floor(width));
  const frameHeight = Math.max(0, Math.floor(height));
  if (frameHeight < 1) return null;

  const inner = Math.max(0, frameWidth - 2);

  // I. Headline: the net change, signed and coloured by direction.
  const netText = composeSlot(labels.net, 'delta', formatSignedBytes(diff.deltaBytes));
  const netStyle = textStyle(theme, deltaColor(theme, diff.deltaBytes), { bold: true });

  // II. The two instants, stacked unless both fit on one row.
  const fromText = composeSlot(labels.from, 'from', diff.from.scannedAt);
  const toText = composeSlot(labels.to, 'to', diff.to.scannedAt);
  const sideBySide = inner >= TIMESTAMPS_SIDE_BY_SIDE;
  const half = Math.floor(inner / 2);

  // III. Row budget: headline, timestamps, optional rule, then entries.
  let budget = frameHeight - 1;
  const timeRows = sideBySide ? 1 : 2;
  const showTimes = budget >= timeRows;
  if (showTimes) budget -= timeRows;
  const showRule = budget >= 5;
  if (showRule) budget -= 1;
  const rowCount = Math.min(Math.max(0, Math.floor(limit)), Math.max(0, budget));
  const entries = rowCount > 0 ? diff.entries.slice(0, rowCount) : [];

  // IV. The change-label column is sized to the labels actually on screen, so a
  //     two-character translation does not steal columns from the path.
  const widestChange = entries.reduce(
    (widest, entry) => Math.max(widest, displayWidth(labels[CHANGE_KEY[entry.change]])),
    0,
  );
  const changeWidth = Math.min(CHANGE_MAX_WIDTH, Math.max(CHANGE_MIN_WIDTH, widestChange));
  const pathWidth = Math.max(0, inner - DELTA_WIDTH - GAP.length - changeWidth - GAP.length);

  return (
    <Box flexDirection="column" width={frameWidth} height={frameHeight} paddingX={1} overflow="hidden">
      {/* I. Net change. */}
      <Text {...netStyle} wrap="truncate-end">
        {pad(netText, inner)}
      </Text>

      {/* II. When each report was taken. */}
      {showTimes ? (
        sideBySide ? (
          <Text {...textStyle(theme, theme.colors.dim, { dim: true })} wrap="truncate-end">
            {pad(fromText, half) + pad(toText, Math.max(0, inner - half))}
          </Text>
        ) : (
          <>
            <Text {...textStyle(theme, theme.colors.dim, { dim: true })} wrap="truncate-end">
              {pad(fromText, inner)}
            </Text>
            <Text {...textStyle(theme, theme.colors.dim, { dim: true })} wrap="truncate-end">
              {pad(toText, inner)}
            </Text>
          </>
        )
      ) : null}

      {/* III. Rule, only when it leaves room for a real list underneath. */}
      {showRule ? (
        <Text {...textStyle(theme, theme.colors.dim)} wrap="truncate-end">
          {'─'.repeat(inner)}
        </Text>
      ) : null}

      {/* IV. Entries in contract order: signed delta, classification, path tail. */}
      {entries.map((entry) => {
        const deltaCell = pad(formatSignedBytes(entry.deltaBytes), DELTA_WIDTH, 'right');
        const changeCell = pad(labels[CHANGE_KEY[entry.change]], changeWidth);
        const pathCell = pathWidth > 0 ? pad(ellipsizePath(entry.path, pathWidth), pathWidth) : '';
        return (
          <Text key={entry.path} wrap="truncate-end">
            <Text {...textStyle(theme, deltaColor(theme, entry.deltaBytes))}>{deltaCell}</Text>
            {GAP}
            <Text {...textStyle(theme, changeColor(theme, entry.change))}>{changeCell}</Text>
            {pathCell.length > 0 ? GAP : ''}
            <Text {...textStyle(theme, theme.colors.muted)}>{pathCell}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
