/**
 * TUI Filter Bar
 *
 * One compact line that answers "what am I looking at, and why": the search
 * term, the active layer chip, the sort key, the grouping, and how much of the
 * result set survived the filter.
 *
 * I. One line, measured rather than flexed
 *
 * 1. The bar sits directly above a table whose columns are laid out by hand, so
 *    it has to be exactly as wide as that table. Two flex children competing for
 *    the leftover space would let the right-hand counter drift as the search
 *    term grew, which is precisely the wobble a hand-laid-out table cannot
 *    tolerate.
 * 2. The counter is therefore reserved first and the width is handed out in
 *    priority order: the layer chip, then the sort key, then the grouping. The
 *    search field takes whatever remains, because its length is the one thing
 *    the user controls and the one thing that can be ellipsized without losing
 *    meaning.
 *
 * II. Colours are applied to settled text
 *
 * 1. Every measurement runs on plain strings; colour is applied afterwards in
 *    nested `<Text>` nodes, whose escapes Ink does not count as columns. Padding
 *    a string that already carries escapes would count those escapes as visible
 *    characters and every column after it would shift right.
 * 2. This is also what keeps `theme.plain` honest: nested styles come from
 *    `theme.ts` helpers, which return empty props when colour is suppressed, so
 *    a plain frame contains no escape at all.
 *
 * III. The chip is the only emphasis
 *
 * 1. The active layer is the one piece of filter state a glance should recover,
 *    so it is drawn in the layer's own colour — the same colour the table uses
 *    for that layer's rows. The `all` state is a filled highlight instead,
 *    because "no filter" is a state worth confirming rather than a layer with a
 *    hue of its own.
 * 2. The brackets around the chip are deliberate redundancy: they are the entire
 *    signal in `theme.plain`, where the fill is gone.
 *
 * @module tui/components/FilterBar
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { formatCount, pad } from '../../core/format.js';
import type { TargetLayer } from '../../core/types.js';
import { barStyle, layerColor, type TextStyle, type Theme, textStyle } from '../theme.js';

/** Props accepted by {@link FilterBar}. */
export interface FilterBarProps {
  /** Current search term; empty means no search is active. */
  readonly query: string;
  /** Active layer filter, or `all` when the list is unfiltered. */
  readonly activeLayer: TargetLayer | 'all';
  /** Active sort key. */
  readonly sortKey: 'size' | 'age' | 'path';
  /** Active grouping. */
  readonly groupBy: 'project' | 'layer' | 'rule';
  /** Targets that survived the filter. */
  readonly matchedCount: number;
  /** Targets before filtering. */
  readonly totalCount: number;
  /** Active theme. */
  readonly theme: Theme;
  /** Total terminal width in columns. */
  readonly width: number;
  /** Localised segment labels. */
  readonly labels: {
    readonly search: string;
    readonly filter: string;
    readonly sort: string;
    readonly group: string;
    readonly all: string;
    readonly matched: string;
  };
  /** Localised lifecycle-layer label. */
  readonly layerLabel: (layer: TargetLayer) => string;
}

/** Gutter between two segments of the bar. */
const JOIN = '  ';
/** From this width up the sort and group segments are affordable. */
const WIDE_WIDTH = 70;
/** From this width up the layer chip is affordable. */
const CHIP_WIDTH = 50;
/**
 * Columns the search field must keep for a segment to survive.
 *
 * The value is the width of `Search: ab…`, so the field can always show its own
 * label plus the first characters of the query. A segment that would leave less
 * than this is dropped instead, because a query the user cannot read is worse
 * than a sort key they cannot see.
 */
const MIN_SEARCH = 12;
/**
 * Cursor drawn at the end of the search field.
 *
 * Plain ASCII on purpose: a block glyph has ambiguous width in several terminal
 * fonts, and a cursor that sometimes measures as two columns would push the
 * counter off the right edge of the bar it is meant to clarify.
 */
const CURSOR = '_';

/** One rendered segment: its plain text, and the style it settles into. */
interface Segment {
  /** React key and the segment's role. */
  readonly key: string;
  /** Visible text, measured before any colour is applied. */
  readonly text: string;
  /** Ink style props for the text, empty when the theme is plain. */
  readonly style: TextStyle;
}

/**
 * Compose a `label: value` pair without doubling a separator.
 *
 * The container supplies the labels, and the localisation tables spell some of
 * them with a trailing colon and some without. Normalising here means either
 * spelling renders correctly, which is worth two branches.
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
 * Total visible width of a segment run, gutters included.
 *
 * @param segments - Segments in display order.
 * @returns The number of columns the run occupies.
 */
function segmentWidth(segments: readonly Segment[]): number {
  return segments.reduce((total, segment) => total + segment.text.length, 0) + segments.length * JOIN.length;
}

/**
 * Render the filter bar.
 *
 * I. Degradation
 *
 * 1. Below {@link WIDE_WIDTH} the sort and group segments go together: they are
 *    two names for the same question ("how is this list ordered"), and freeing
 *    both is what keeps the search field long enough to be worth typing in.
 * 2. Below {@link CHIP_WIDTH} the chip goes as well, leaving the search term and
 *    the counter — the two facts that answer "is this list complete".
 * 3. Both limits are checked again against the *measured* line, so a long
 *    localised label drops a segment rather than overflowing the frame. The
 *    `filter` prefix on the chip is the first thing to go and the group segment
 *    the second; the counter and the query are never sacrificed.
 *
 * @param props - Filter state, counts and layout width.
 * @returns A single line that is never wider than `props.width`.
 */
export function FilterBar({
  query,
  activeLayer,
  sortKey,
  groupBy,
  matchedCount,
  totalCount,
  theme,
  width,
  labels,
  layerLabel,
}: FilterBarProps): ReactNode {
  const frameWidth = Math.max(0, Math.floor(width));
  const inner = Math.max(0, frameWidth - 2);
  const filtering = query.length > 0;
  const matched = Math.max(0, Math.floor(matchedCount));
  const total = Math.max(0, Math.floor(totalCount));

  // I. The counter is reserved before anything else is promised, and is itself
  //    clamped so a degenerate width still yields a line inside the frame.
  const rightPlain = `${formatCount(matched)}/${formatCount(total)} ${labels.matched}`;
  const right = pad(rightPlain, Math.min(rightPlain.length, Math.max(0, inner - 1)));

  // II. Candidate segments, most important first. The display order and the
  //     drop order are therefore the same array read in opposite directions.
  const buildSegments = (prefixed: boolean): Segment[] => {
    const segments: Segment[] = [];
    if (frameWidth >= CHIP_WIDTH) {
      const chipText = `[${activeLayer === 'all' ? labels.all : layerLabel(activeLayer)}]`;
      segments.push({
        key: 'filter',
        text: prefixed ? withValue(labels.filter, chipText) : chipText,
        style:
          activeLayer === 'all'
            ? barStyle(theme, theme.colors.primary)
            : textStyle(theme, layerColor(theme, activeLayer), { bold: true }),
      });
    }
    if (frameWidth >= WIDE_WIDTH) {
      segments.push({
        key: 'sort',
        text: withValue(labels.sort, sortKey),
        style: textStyle(theme, theme.colors.muted, { dim: true }),
      });
      segments.push({
        key: 'group',
        text: withValue(labels.group, groupBy),
        style: textStyle(theme, theme.colors.muted, { dim: true }),
      });
    }
    return segments;
  };
  const usable = (candidate: readonly Segment[]): boolean =>
    inner - segmentWidth(candidate) - right.length - 1 >= MIN_SEARCH;

  // III. The `filter` label is decoration, so it is the first thing sacrificed:
  //      a chip without its prefix still names a layer, whereas a search field
  //      reduced to an ellipsis names nothing. The prefixed run is only taken
  //      when it leaves a usable query behind it.
  const prefixed = buildSegments(true);
  const segments = usable(prefixed) ? [...prefixed] : [...buildSegments(false)];

  // IV. Then drop the least important segment until the search field fits. This
  //     loop is the second half of the width guarantee: the tier limits above
  //     are about intent, this one is about the columns actually available.
  while (segments.length > 0 && !usable(segments)) {
    segments.pop();
  }
  const fixedWidth = segmentWidth(segments);

  // V. The search field takes the remainder, ellipsized by `pad`. When the query
  //    is empty the field still renders, dimmed, so the bar never collapses to a
  //    bare label while the user is typing.
  const searchPlain = `${withValue(labels.search, query)}${CURSOR}`;
  const searchWidth = Math.max(0, Math.min(searchPlain.length, inner - fixedWidth - right.length - 1));
  const searchStyle = filtering
    ? textStyle(theme, theme.colors.accent, { bold: true })
    : textStyle(theme, theme.colors.dim, { dim: true });

  // VI. Whatever is left over becomes the gutter that pushes the counter to the
  //     right edge. The sum of the four widths is exactly `inner`.
  const fill = ' '.repeat(Math.max(0, inner - searchWidth - fixedWidth - right.length));

  return (
    <Box flexDirection="row" width={frameWidth} paddingX={1}>
      <Text wrap="truncate-end">
        {searchWidth > 0 ? <Text {...searchStyle}>{pad(searchPlain, searchWidth)}</Text> : null}
        {segments.map((segment) => (
          <Text key={segment.key}>
            {JOIN}
            <Text {...segment.style}>{segment.text}</Text>
          </Text>
        ))}
        {fill}
        <Text {...textStyle(theme, theme.colors.muted)}>{right}</Text>
      </Text>
    </Box>
  );
}
