/**
 * TUI Confirm Dialog
 *
 * The last screen before anything is unlinked, and the highest-stakes frame in
 * the application: it restates what will be deleted, how much space that frees,
 * how much of it is dangerous, and how much is being left alone.
 *
 * I. What must not be lost
 *
 * 1. The byte total is the number the user is actually trading for the
 *    directories, so it is rendered as a filled band across the dialog rather
 *    than as one more `label: value` row. Emphasis is not decoration here; a
 *    misread total is the failure this frame exists to prevent.
 * 2. The dangerous count is the one number that can cost real work, so it is the
 *    only detail drawn in `danger`. At zero it drops to the muted ink, because a
 *    red `0` trains the eye to ignore red.
 * 3. The affirmative hint is filled and bold, the negative one dim. The two are
 *    never the same weight: a dialog whose answers look identical is one where a
 *    stray Enter deletes a directory tree. Brackets carry the emphasis in
 *    `theme.plain`, where fill and bold are gone.
 *
 * II. Height is budgeted, not hoped for
 *
 * 1. A terminal has no layout engine to fall back on, so the frame computes how
 *    many rows each block needs before it renders any of them. Blocks are added
 *    in priority order — title, prompt, size band, details, preview, hints — and
 *    the first ones that do not fit are dropped. Nothing is ever clipped
 *    mid-sentence by the terminal.
 * 2. The prompt is wrapped by {@link wrapLines} rather than handed to Ink's
 *    wrapper, because the number of rows it will occupy has to be known *before*
 *    the rows below it are budgeted. Ink discovers the same line count, but only
 *    after the frame has committed to a height.
 * 3. A trailing flex spacer absorbs the slack, which pins the key hints to the
 *    bottom edge whatever the terminal height happens to be.
 *
 * III. The preview is untrusted text
 *
 * 1. `previewText` may be command output or a file listing, so it is treated as
 *    opaque: rendered verbatim, line for line, with only its *count* bounded. A
 *    single over-long line is clipped by `pad` instead of being allowed to wrap,
 *    because wrapping would change the row count the budget was built on.
 * 2. When the preview holds more lines than the box can show, the tail is
 *    replaced by a marker naming how many lines are missing, so the dialog never
 *    implies it has shown everything.
 *
 * @module tui/components/ConfirmDialog
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { displayWidth, formatBytes, formatCount, pad, truncateToWidth } from '../../core/format.js';
import { barBackground, barStyle, centre, type Theme, textStyle } from '../theme.js';

/** Props accepted by {@link ConfirmDialog}. */
export interface ConfirmDialogProps {
  /** Dialog heading, already localised. */
  readonly title: string;
  /** Number of targets the plan will delete. */
  readonly targetCount: number;
  /** Total bytes the plan claims to free. */
  readonly totalBytes: number;
  /** Targets that matched but are locked, and will therefore be skipped. */
  readonly lockedSkippedCount: number;
  /** Targets at the highest risk level among the planned ones. */
  readonly dangerCount: number;
  /** Active theme. */
  readonly theme: Theme;
  /** Total terminal width in columns. */
  readonly width: number;
  /** Total terminal height in rows; the frame never exceeds it. */
  readonly height: number;
  /** Localised copy. `prompt` may carry `{count}` and `{bytes}` slots. */
  readonly labels: {
    readonly prompt: string;
    readonly yes: string;
    readonly no: string;
    readonly targets: string;
    readonly size: string;
    readonly danger: string;
    readonly skipped: string;
  };
  /** Optional raw output shown verbatim behind the summary. */
  readonly previewText?: string;
}

/** Space reserved by the double border (2) plus the horizontal padding (2). */
const FRAME_INSET = 4;
/** Space reserved inside the preview box by its own border and padding. */
const PREVIEW_INSET = 4;
/** Below this frame height the dialog renders nothing at all. */
const MIN_FRAME_HEIGHT = 4;
/** From this content height the title gets a blank row beneath it. */
const TITLE_SEPARATOR_MIN_HEIGHT = 6;
/** Fewest rows a preview box may occupy: two of border plus one of content. */
const PREVIEW_MIN_BLOCK = 3;
/**
 * Tail of the preview overflow marker.
 *
 * The prop contract exposes no label for this marker, so it is spelled once
 * here rather than threaded through the call site; when a localised label joins
 * the contract this is the only line that has to change.
 */
const MORE_LINES_SUFFIX = 'more lines';

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
 * Fill the `{count}` and `{bytes}` slots of the prompt.
 *
 * I. Why both spellings are accepted
 *
 * 1. The message tables store the prompt as a template, while a caller that has
 *    already interpolated it passes a finished sentence. Both reach this
 *    component, and a helper that understood only one of them would print a
 *    literal `{bytes}` on the highest-stakes screen in the application.
 * 2. A template with no slots is returned untouched, so the helper never appends
 *    a value the sentence already carries.
 *
 * @param template - Prompt text, possibly carrying slots.
 * @param count - Target count for the `{count}` slot.
 * @param bytes - Byte total for the `{bytes}` slot.
 * @returns The prompt with its slots resolved.
 */
function fillPrompt(template: string, count: number, bytes: number): string {
  if (!/\{(count|bytes)\}/.test(template)) return template;
  return template.replace(/\{(count|bytes)\}/g, (_match: string, name: string) =>
    name === 'count' ? formatCount(count) : formatBytes(bytes),
  );
}

/**
 * Wrap text to a width with a greedy word wrap.
 *
 * I. Why this exists next to Ink's own wrapper
 *
 * 1. The dialog must know the prompt's line count before it can budget the rows
 *    below it, and Ink only reports that after layout. A dozen lines of pure
 *    string work is cheaper than a second render pass, and it is testable
 *    without a terminal.
 * 2. The wrap is deliberately naive — spaces only, no hyphenation — because the
 *    input is a one-sentence safety prompt, not prose. A word wider than the line
 *    is left whole and clipped later by `pad`.
 *
 * @param text - Text to wrap; explicit newlines start a new paragraph.
 * @param width - Available columns.
 * @returns One string per rendered row.
 */
function wrapLines(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      if (current.length === 0) {
        // A single word can exceed the cell on its own, which happens as soon
        // as a Chinese paragraph is wrapped: it must be cut rather than emitted
        // whole, because Ink cannot wrap what it is handed as one cell width.
        current = displayWidth(word) > width ? truncateToWidth(word, width) : word;
      } else if (displayWidth(current) + 1 + displayWidth(word) <= width) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = displayWidth(word) > width ? truncateToWidth(word, width) : word;
      }
    }
    lines.push(current);
  }
  return lines;
}

/**
 * Keep the first `count` lines, ellipsizing the last kept one.
 *
 * Used when the prompt is squeezed below the number of rows it wants, so the cut
 * is visible rather than implied by a sentence that stops mid-thought.
 *
 * @param lines - Wrapped prompt lines.
 * @param count - Rows available.
 * @param width - Available columns.
 * @returns At most `count` lines.
 */
function clipLines(lines: readonly string[], count: number, width: number): string[] {
  if (count >= lines.length) return lines.slice(0, Math.max(0, count));
  const shown = lines.slice(0, Math.max(0, count));
  const lastIndex = shown.length - 1;
  if (lastIndex >= 0) {
    const last = shown[lastIndex] ?? '';
    shown[lastIndex] = width <= 1 ? last.slice(0, Math.max(0, width)) : `${last.slice(0, width - 1)}…`;
  }
  return shown;
}

/**
 * Bound a preview to a fixed number of content rows.
 *
 * I. Marker arithmetic
 *
 * 1. The marker occupies a row of its own, so two or more available rows show
 *    `capacity - 1` lines plus the marker, and a single available row shows the
 *    marker alone: "there are N more lines" is still information, whereas showing
 *    one line and silently dropping the rest is not.
 *
 * @param lines - Preview split into lines.
 * @param capacity - Content rows the box can hold.
 * @returns The lines to render, marker included when text was dropped.
 */
function clipPreview(lines: readonly string[], capacity: number): string[] {
  if (capacity <= 0) return [];
  if (lines.length <= capacity) return [...lines];
  const visible = capacity >= 2 ? lines.slice(0, capacity - 1) : [];
  return [...visible, `… ${lines.length - visible.length} ${MORE_LINES_SUFFIX}`];
}

/** Which blocks a content column of a given height can afford. */
interface DialogLayout {
  /** True when the blank row under the title is drawn. */
  readonly separator: boolean;
  /** Prompt lines that fit, the last one ellipsized when it was cut. */
  readonly prompt: readonly string[];
  /** True when the byte band is drawn. */
  readonly showSize: boolean;
  /** True when the counts row is drawn. */
  readonly showDetails: boolean;
  /** Preview lines that fit, marker included when text was dropped. */
  readonly preview: readonly string[];
  /** Total rows the preview box occupies, border included; 0 when hidden. */
  readonly previewBlock: number;
}

/**
 * Decide which blocks fit, in priority order.
 *
 * I. Priority
 *
 * 1. The title and the key hints are paid for by the caller; everything handed
 *    out here is discretionary. The prompt is bought first because it carries the
 *    irreversible-operation warning, then the byte band, then the counts row, and
 *    the preview gets whatever is left over.
 * 2. The preview is only bought when the remainder can hold its own border plus a
 *    content row. A box with no inside is not a preview, it is a frame around a
 *    promise.
 *
 * @param contentHeight - Rows between the two borders.
 * @param inner - Content width in columns.
 * @param promptText - Prompt with its slots already resolved.
 * @param previewText - Raw preview, or undefined when none was supplied.
 * @returns The block decisions for one frame.
 */
function dialogLayout(
  contentHeight: number,
  inner: number,
  promptText: string,
  previewText: string | undefined,
): DialogLayout {
  const separator = contentHeight >= TITLE_SEPARATOR_MIN_HEIGHT;
  // I. Reserve the title line, the optional separator and the hints line.
  let budget = contentHeight - 1 - (separator ? 1 : 0) - 1;

  // II. The prompt goes first: it carries the irreversible-operation warning.
  const promptLines = wrapLines(promptText, inner);
  const promptRows = Math.max(0, Math.min(promptLines.length, budget));
  const prompt = clipLines(promptLines, promptRows, inner);
  budget -= promptRows;

  // III. The byte band, then the counts row.
  const showSize = budget >= 1;
  if (showSize) budget -= 1;
  const showDetails = budget >= 1;
  if (showDetails) budget -= 1;

  // IV. The preview takes what is left, but only when it can hold its border.
  const previewAll = previewText === undefined ? [] : previewText.split('\n');
  const capacity = budget >= PREVIEW_MIN_BLOCK ? Math.min(previewAll.length, budget - 2) : 0;
  const previewBlock = capacity > 0 ? capacity + 2 : 0;
  const preview = previewBlock > 0 ? clipPreview(previewAll, capacity) : [];

  return { separator, prompt, showSize, showDetails, preview, previewBlock };
}

/**
 * Render the confirmation dialog.
 *
 * I. Row budget
 *
 * 1. The title and the key hints are reserved first; they frame the dialog and
 *    are the two rows whose absence would make it unreadable rather than merely
 *    terser.
 * 2. The remaining rows are handed out in priority order: prompt, byte band,
 *    detail row, preview. At a healthy terminal height every block fits; on a
 *    short one the preview is the first casualty and the byte band the last.
 * 3. Blocks are rendered in reading order regardless of the order they were
 *    budgeted in, so the visual hierarchy never changes with the terminal.
 *
 * @param props - Summary numbers, copy and frame size.
 * @returns A framed dialog of exactly `width` x `height`, or null when even a
 *   bare frame would not fit.
 */
export function ConfirmDialog({
  title,
  targetCount,
  totalBytes,
  lockedSkippedCount,
  dangerCount,
  theme,
  width,
  height,
  labels,
  previewText,
}: ConfirmDialogProps): ReactNode {
  const frameWidth = Math.max(0, Math.floor(width));
  const frameHeight = Math.max(0, Math.floor(height));
  const inner = Math.max(0, frameWidth - FRAME_INSET);
  // Half a border is worse than an honest gap: below a readable frame there is
  // no arrangement of this dialog that is not a lie about its own size.
  if (frameHeight < MIN_FRAME_HEIGHT || inner < 8) return null;

  const layout = dialogLayout(
    frameHeight - 2,
    inner,
    fillPrompt(labels.prompt, targetCount, totalBytes),
    previewText,
  );
  const previewInner = Math.max(0, inner - PREVIEW_INSET);

  const dangerStyle =
    dangerCount > 0
      ? textStyle(theme, theme.colors.danger, { bold: true })
      : textStyle(theme, theme.colors.dim, { dim: true });

  return (
    <Box
      flexDirection="column"
      width={frameWidth}
      height={frameHeight}
      borderStyle="double"
      borderColor={theme.plain ? undefined : theme.colors.primary}
      paddingX={1}
      overflow="hidden"
    >
      {/* I. Identity of the frame. */}
      <Text {...textStyle(theme, theme.colors.primary, { bold: true })} wrap="truncate-end">
        {centre(title, inner)}
      </Text>

      {layout.separator ? <Text> </Text> : null}

      {/* II. What is about to happen, wrapped to the row budget. */}
      {layout.prompt.length > 0 ? (
        <Text {...textStyle(theme, theme.colors.text)} wrap="truncate-end">
          {layout.prompt.map((line) => pad(line, inner)).join('\n')}
        </Text>
      ) : null}

      {/* III. The number being traded for the directories, as a filled band in
             the warning ink: it is the size of the trade, not the frame. */}
      {layout.showSize ? (
        <Box backgroundColor={barBackground(theme, theme.colors.warning)} width={inner}>
          <Text {...barStyle(theme, theme.colors.warning)} wrap="truncate-end">
            {centre(withValue(labels.size, formatBytes(totalBytes)), inner)}
          </Text>
        </Box>
      ) : null}

      {/* IV. Counts: the dangerous one is the only one allowed to shout. */}
      {layout.showDetails ? (
        <Text {...textStyle(theme, theme.colors.muted)} wrap="truncate-end">
          {withValue(labels.targets, formatCount(targetCount))}
          {'  '}
          <Text {...dangerStyle}>{withValue(labels.danger, formatCount(dangerCount))}</Text>
          {'  '}
          <Text {...textStyle(theme, theme.colors.dim)}>
            {withValue(labels.skipped, formatCount(lockedSkippedCount))}
          </Text>
        </Text>
      ) : null}

      {/* V. Raw preview, verbatim, bounded by its own box. */}
      {layout.previewBlock > 0 ? (
        <Box
          flexDirection="column"
          width={inner}
          height={layout.previewBlock}
          borderStyle="single"
          borderColor={theme.plain ? undefined : theme.colors.dim}
          paddingX={1}
          overflow="hidden"
        >
          <Text {...textStyle(theme, theme.colors.muted)} wrap="truncate-end">
            {layout.preview.map((line) => pad(line, previewInner)).join('\n')}
          </Text>
        </Box>
      ) : null}

      {/* VI. Slack sinks here, which pins the hints to the bottom edge. */}
      <Box flexGrow={1} />

      {/* VII. The two answers, deliberately asymmetric. */}
      <Text wrap="truncate-end">
        <Text {...barStyle(theme, theme.colors.accent)}>{`[ ${labels.yes} ]`}</Text>
        <Text {...textStyle(theme, theme.colors.dim, { dim: true })}>{`  [ ${labels.no} ]`}</Text>
      </Text>
    </Box>
  );
}
