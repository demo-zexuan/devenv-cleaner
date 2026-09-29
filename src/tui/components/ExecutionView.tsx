/**
 * TUI Execution View
 *
 * The live feed while a plan is carried out: one segment per finished target, an
 * aggregate bar driven by `currentIndex / total`, and a running account of what
 * was reclaimed and what went wrong.
 *
 * I. The feed is scrolled to its tail, not to its head
 *
 * 1. An execution produces results in order and the user cares about the most
 *    recent one: a failure that just happened is actionable, a failure from two
 *    hundred targets ago is history. The window is therefore the *end* of the
 *    result array, and the oldest rows fall off the top as new ones arrive.
 * 2. There is no scroll offset prop. Scrolling is a key-handling concern that
 *    belongs to the container, and a feed that tracked its own offset would
 *    disagree with the counters it is also handed.
 *
 * II. Dry runs are impossible to confuse with deletions
 *
 * 1. `dryRun` does three things at once: every per-result colour collapses to
 *    `muted`, the outcome glyphs stop being tinted, and a filled warning band is
 *    the first row on screen. A user who glances away and back still sees the
 *    band before anything else.
 * 2. The band outranks the progress bar and even the byte footer in the row
 *    budget, because the one failure this screen must prevent is a preview being
 *    mistaken for work that already happened.
 *
 * III. Reasons are flattened before they are measured
 *
 * 1. A reason is the most important text on the line, so it claims a share of
 *    the row's width whenever that share clears {@link REASON_MIN}; the path
 *    keeps the remainder. Only on a terminal too narrow to hold both does the
 *    path win, because an error with no location names nothing to fix.
 * 2. Reasons arrive from the filesystem — an `EACCES` message can contain
 *    newlines and tabs — so they are collapsed to a single line before they are
 *    measured. A newline inside a measured cell would add a row the budget never
 *    accounted for.
 *
 * IV. Layout is computed, not nested
 *
 * 1. Each row has three independent width decisions and each frame has four
 *    independent row decisions. Both are resolved by the small pure helpers
 *    below and handed to the JSX as plain values, which keeps the render tree to
 *    one expression per value instead of a wall of ternaries.
 *
 * @module tui/components/ExecutionView
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { ellipsizePath, formatBar, formatBytes, formatCount, pad } from '../../core/format.js';
import type { CleanOutcome, CleanResult } from '../../core/types.js';
import { barBackground, barStyle, centre, type TextStyle, type Theme, textStyle } from '../theme.js';

/** Props accepted by {@link ExecutionView}. */
export interface ExecutionViewProps {
  /** Per-target outcomes produced so far, in execution order. */
  readonly results: readonly CleanResult[];
  /** Zero-based index of the target currently being acted on. */
  readonly currentIndex: number;
  /** Total number of targets the execution will touch. */
  readonly total: number;
  /** Bytes reclaimed so far. */
  readonly freedBytes: number;
  /** Targets that failed so far. */
  readonly failedCount: number;
  /** True when nothing is actually deleted; every action is a preview. */
  readonly dryRun: boolean;
  /** Available height in rows; the view never renders more than this. */
  readonly height: number;
  /** Total terminal width in columns. */
  readonly width: number;
  /** Active theme. */
  readonly theme: Theme;
  /** Localised labels. `done` is expected to be a short status word. */
  readonly labels: {
    readonly running: string;
    readonly done: string;
    readonly dryRun: string;
    readonly deleted: string;
    readonly skipped: string;
    readonly failed: string;
    readonly freed: string;
  };
  /** Localised outcome label resolver, used when a result carries no reason. */
  readonly outcomeLabel: (outcome: CleanOutcome) => string;
}

/**
 * Outcome glyphs.
 *
 * ASCII only: `+` added back to the disk, `-` left alone, `!` needs attention.
 * A symbol with ambiguous terminal width would shift every column after it.
 */
const GLYPH: Readonly<Record<CleanOutcome, string>> = {
  deleted: '+',
  skipped: '-',
  failed: '!',
};

/** Palette token per outcome, before the dry-run override flattens them. */
const GLYPH_TOKEN: Readonly<Record<CleanOutcome, keyof Theme['colors']>> = {
  deleted: 'success',
  skipped: 'dim',
  failed: 'danger',
};

/** Byte column width; `-1023.9 KB` is the widest value `formatBytes` produces. */
const SIZE_WIDTH = 9;
/** Gutter between two cells of a row. */
const GAP = '  ';
/** Reason column never grows past this, however wide the terminal is. */
const REASON_MAX = 30;
/** Share of a row's body the reason column may claim. */
const REASON_SHARE = 0.4;
/** Smallest reason column worth reserving; below it there is no room for both. */
const REASON_MIN = 12;
/** From this width the footer also spells out the deleted and skipped counts. */
const FOOTER_WIDE_WIDTH = 72;
/** Narrowest bar worth drawing, including its brackets. */
const BAR_MIN_ROOM = 14;
/** Widest aggregate bar, however wide the terminal is. */
const BAR_MAX_WIDTH = 28;

/** Which rows a frame of a given height can afford. */
interface RowBudget {
  /** True when the dry-run band is rendered. */
  readonly notice: boolean;
  /** True when the status and progress row is rendered. */
  readonly headline: boolean;
  /** True when the running-totals row is rendered. */
  readonly footer: boolean;
  /** Rows left for the result feed. */
  readonly results: number;
}

/** Everything one result row needs, resolved away from JSX. */
interface ResultLine {
  /** Stable React key: one row per target. */
  readonly key: string;
  /** Single-character outcome marker. */
  readonly glyph: string;
  /** Byte, path and reason cells composed into one padded line. */
  readonly body: string;
  /** Palette token for the glyph before the dry-run override. */
  readonly token: keyof Theme['colors'];
  /** True when the row is secondary information. */
  readonly dim: boolean;
  /** True when the glyph should stand out. */
  readonly boldGlyph: boolean;
}

/** The three cells of the running-totals row. */
interface FooterCells {
  /** Deleted and skipped counts, padded so the totals stay right-aligned. */
  readonly lead: string;
  /** Reclaimed bytes, already formatted. */
  readonly freed: string;
  /** Failure count, already formatted. */
  readonly failed: string;
}

/**
 * Compose a `label: value` pair without doubling a separator.
 *
 * @param label - Label as supplied by the container.
 * @param value - Already-formatted value.
 * @returns The composed text.
 */
function withValue(label: string, value: string): string {
  const trimmed = label.endsWith(':') || label.endsWith('：') ? label : `${label}:`;
  return `${trimmed} ${value}`;
}

/**
 * Decide which rows a frame can afford.
 *
 * I. Priority
 *
 * 1. The dry-run band is bought first, then the live status row, then the
 *    running totals, and the feed gets whatever is left. A one-row terminal in a
 *    dry run therefore says only "this is a dry run", which is the correct thing
 *    for it to say.
 *
 * @param frameHeight - Rows available in total.
 * @param dryRun - Whether the frame must announce itself as a preview.
 * @returns The row allowance for the frame.
 */
function rowBudget(frameHeight: number, dryRun: boolean): RowBudget {
  let budget = frameHeight;
  const notice = dryRun;
  if (notice) budget -= 1;
  const headline = budget >= 1;
  if (headline) budget -= 1;
  const footer = budget >= 1;
  if (footer) budget -= 1;
  return { notice, headline, footer, results: Math.max(0, budget) };
}

/**
 * Build the status cell for one result.
 *
 * I. Shape
 *
 * 1. A deleted target has nothing to explain, so it gets no status at all — the
 *    overwhelming majority of rows stay narrow.
 * 2. A skipped or failed target gets `label: reason`, or the bare outcome label
 *    when the executor recorded no reason. The outcome label is never dropped,
 *    because "skipped" without a reason is still better than an empty column.
 * 3. Whitespace is collapsed, for the reason given in the module header.
 *
 * @param result - Result to describe.
 * @param outcomeLabel - Localised outcome label resolver.
 * @returns A single-line status, or an empty string for a deletion.
 */
function statusFor(result: CleanResult, outcomeLabel: (outcome: CleanOutcome) => string): string {
  if (result.outcome === 'deleted') return '';
  const reason = (result.outcome === 'failed' ? result.error : result.skipReason) ?? '';
  const label = outcomeLabel(result.outcome);
  const collapsed = reason.replace(/\s+/g, ' ').trim();
  return collapsed.length === 0 ? label : `${label}: ${collapsed}`;
}

/**
 * Compose one result row into plain, pre-measured cells.
 *
 * I. Width order
 *
 * 1. The byte cell is fixed, the reason column claims a share of the remainder,
 *    and the path takes what is left. Giving the path the remainder rather than a
 *    fixed width is what makes the table look deliberate on every terminal
 *    instead of only the author's.
 * 2. The reason is reserved at *every* width its own floor allows, because a
 *    failure the user cannot read is the worst outcome this screen has. Only on a
 *    terminal too narrow to hold a path stub and a usable reason together does
 *    the path win, since an error without a location names nothing to fix.
 *
 * @param result - Result to render.
 * @param outcomeLabel - Localised outcome label resolver.
 * @param bodyBudget - Columns available after the glyph and its gutter.
 * @returns The row's key, glyph, body and emphasis.
 */
function resultLine(
  result: CleanResult,
  outcomeLabel: (outcome: CleanOutcome) => string,
  bodyBudget: number,
): ResultLine {
  const status = statusFor(result, outcomeLabel);
  const reasonRoom = Math.floor(bodyBudget * REASON_SHARE) - GAP.length;
  const statusWidth = status.length > 0 && reasonRoom >= REASON_MIN ? Math.min(REASON_MAX, reasonRoom) : 0;
  const pathWidth = Math.max(
    0,
    bodyBudget - SIZE_WIDTH - GAP.length - (statusWidth > 0 ? statusWidth + GAP.length : 0),
  );

  const cells: string[] = [pad(formatBytes(result.freedBytes), SIZE_WIDTH, 'right')];
  if (pathWidth > 0) cells.push(pad(ellipsizePath(result.path, pathWidth), pathWidth));
  if (statusWidth > 0) cells.push(pad(status, statusWidth));

  return {
    key: `${result.targetId}:${result.path}`,
    glyph: GLYPH[result.outcome],
    body: pad(cells.join(GAP), bodyBudget),
    token: GLYPH_TOKEN[result.outcome],
    dim: result.outcome === 'skipped',
    boldGlyph: result.outcome === 'failed',
  };
}

/**
 * Compose the status and aggregate-progress row.
 *
 * I. Why the bar is dropped before the counter
 *
 * 1. The counter is exact and the bar is an impression of it, so when the line
 *    is too narrow for both the bar is the half that goes. The percentage-looking
 *    bar is also what a narrow terminal would garble first.
 *
 * @param statusText - Localised status word.
 * @param done - Targets finished so far.
 * @param planned - Targets in the plan.
 * @param inner - Content width of the frame.
 * @returns A line padded to `inner`.
 */
function headline(statusText: string, done: number, planned: number, inner: number): string {
  const countText = `${formatCount(done)}/${formatCount(planned)}`;
  const barRoom = inner - statusText.length - countText.length - 2;
  if (barRoom < BAR_MIN_ROOM) {
    return pad(pad(statusText, Math.max(0, inner - countText.length)) + countText, inner);
  }
  const bar = formatBar(planned > 0 ? done / planned : 0, Math.min(BAR_MAX_WIDTH, barRoom));
  const right = `${bar} ${countText}`;
  return pad(pad(statusText, Math.max(0, inner - right.length)) + right, inner);
}

/**
 * Compose the running-totals row.
 *
 * @param results - Results produced so far.
 * @param freedBytes - Bytes reclaimed so far.
 * @param failedCount - Failures so far.
 * @param labels - Localised labels.
 * @param inner - Content width of the frame.
 * @returns The three cells, with the leading cell padded for right alignment.
 */
function footerCells(
  results: readonly CleanResult[],
  freedBytes: number,
  failedCount: number,
  labels: ExecutionViewProps['labels'],
  inner: number,
): FooterCells {
  const freed = withValue(labels.freed, formatBytes(freedBytes));
  const failed = withValue(labels.failed, formatCount(failedCount));
  const deleted = results.filter((result) => result.outcome === 'deleted').length;
  const skipped = results.filter((result) => result.outcome === 'skipped').length;
  const counts =
    inner >= FOOTER_WIDE_WIDTH
      ? `${withValue(labels.deleted, formatCount(deleted))}${GAP}${withValue(labels.skipped, formatCount(skipped))}${GAP}`
      : '';
  return {
    lead: pad(counts, Math.max(0, inner - freed.length - GAP.length - failed.length)),
    freed,
    failed,
  };
}

/**
 * Palette token for the status word.
 *
 * @param theme - Active theme.
 * @param dryRun - Whether colour is being flattened.
 * @param finished - Whether the execution has completed.
 * @returns The ink the status earns.
 */
function statusColor(theme: Theme, dryRun: boolean, finished: boolean): string {
  if (dryRun) return theme.colors.muted;
  return finished ? theme.colors.success : theme.colors.primary;
}

/**
 * Style for the failure cell.
 *
 * @param theme - Active theme.
 * @param failedCount - Failures so far.
 * @param dryRun - Whether colour is being flattened.
 * @returns Bold danger once something has failed, quiet otherwise.
 */
function failureStyle(theme: Theme, failedCount: number, dryRun: boolean): TextStyle {
  return failedCount > 0 && !dryRun
    ? textStyle(theme, theme.colors.danger, { bold: true })
    : textStyle(theme, theme.colors.dim, { dim: true });
}

/**
 * Render the execution feed.
 *
 * @param props - Streamed results, aggregate totals and frame size.
 * @returns An execution feed sized to `width` x `height`.
 */
export function ExecutionView({
  results,
  currentIndex,
  total,
  freedBytes,
  failedCount,
  dryRun,
  height,
  width,
  theme,
  labels,
  outcomeLabel,
}: ExecutionViewProps): ReactNode {
  const frameWidth = Math.max(0, Math.floor(width));
  const frameHeight = Math.max(0, Math.floor(height));
  if (frameHeight < 1) return null;

  const inner = Math.max(0, frameWidth - 2);
  const done = Math.max(0, Math.floor(currentIndex));
  const planned = Math.max(0, Math.floor(total));
  const finished = planned > 0 && done >= planned;
  const bodyBudget = Math.max(0, inner - 2);

  // I. Row allowance, then the two fixed rows.
  const allowance = rowBudget(frameHeight, dryRun);
  const statusText = finished ? labels.done : labels.running;
  const statusStyle = textStyle(theme, statusColor(theme, dryRun, finished), { bold: true });
  const totals = footerCells(results, freedBytes, failedCount, labels, inner);
  const failedStyle = failureStyle(theme, failedCount, dryRun);

  // II. The feed window is the tail of the result array.
  const visible = allowance.results > 0 ? results.slice(Math.max(0, results.length - allowance.results)) : [];

  return (
    <Box flexDirection="column" width={frameWidth} height={frameHeight} paddingX={1} overflow="hidden">
      {/* I. The one row that must never be missed when nothing is deleted. */}
      {allowance.notice ? (
        <Box backgroundColor={barBackground(theme, theme.colors.warning)} width={inner}>
          <Text {...barStyle(theme, theme.colors.warning)} wrap="truncate-end">
            {centre(labels.dryRun, inner)}
          </Text>
        </Box>
      ) : null}

      {/* II. Status and aggregate progress. */}
      {allowance.headline ? (
        <Text {...statusStyle} wrap="truncate-end">
          {headline(statusText, done, planned, inner)}
        </Text>
      ) : null}

      {/* III. One padded line per result, newest at the bottom. */}
      {visible.map((result) => {
        const line = resultLine(result, outcomeLabel, bodyBudget);
        return (
          <Text
            key={line.key}
            {...textStyle(theme, dryRun ? theme.colors.muted : theme.colors.text, {
              dim: dryRun || line.dim,
            })}
            wrap="truncate-end"
          >
            <Text
              {...textStyle(theme, dryRun ? theme.colors.muted : theme.colors[line.token], {
                bold: !dryRun && line.boldGlyph,
              })}
            >
              {line.glyph}
            </Text>
            {` ${line.body}`}
          </Text>
        );
      })}

      {/* IV. Running totals, right-aligned so the numbers stay at a fixed edge. */}
      {allowance.footer ? (
        <Text wrap="truncate-end">
          <Text {...textStyle(theme, theme.colors.muted)}>{totals.lead}</Text>
          <Text {...textStyle(theme, theme.colors.muted)}>{totals.freed}</Text>
          {GAP}
          <Text {...failedStyle}>{totals.failed}</Text>
        </Text>
      ) : null}
    </Box>
  );
}
