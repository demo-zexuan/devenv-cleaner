/**
 * TUI Summary Panel
 *
 * The headline numbers of a scan: what exists, what is actually reclaimable,
 * what is currently selected, and how the total splits across the lifecycle
 * layers.
 *
 * I. Total versus reclaimable
 *
 * 1. `totalBytes` counts every discovered directory, including locked ones; it
 *    answers "how much space do these caches occupy". `reclaimableBytes` answers
 *    "how much could be freed right now". Presenting only one of them is the
 *    single most misleading thing a cleanup tool can do, so both sit on the
 *    first row, side by side, and the selection bar is scaled against the
 *    *reclaimable* figure — the only denominator a user can act on.
 *
 * II. Bounded height
 *
 * 1. The panel is a fixed seven content rows: three summary rows plus one row
 *    per lifecycle layer (the report contract always emits all four). A summary
 *    that grows with the number of targets would push the results table off the
 *    screen, which is the opposite of a summary.
 *
 * III. Layers
 *
 * 1. Each layer row is labelled through the injected `layerLabel` and coloured
 *    through `layerColor`, so the panel stays localisation-agnostic and the layer
 *    colours match the rows in the results table exactly.
 *
 * @module tui/components/SummaryPanel
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { formatBar, formatBytes, formatCount, formatPercent, pad } from '../../core/format.js';
import type { ScanSummary, TargetLayer } from '../../core/types.js';
import { colored, layerColor, type Theme, textStyle } from '../theme.js';

/** Props accepted by {@link SummaryPanel}. */
export interface SummaryPanelProps {
  /** Aggregates produced by the scan. */
  readonly summary: ScanSummary;
  /** Bytes covered by the current selection. */
  readonly selectedBytes: number;
  /** Number of targets in the current selection. */
  readonly selectedCount: number;
  /** Number of detected projects. */
  readonly projects: number;
  /** Active theme. */
  readonly theme: Theme;
  /** Total terminal width in columns. */
  readonly width: number;
  /** Localised row labels. */
  readonly labels: {
    readonly total: string;
    readonly reclaimable: string;
    readonly selected: string;
    readonly targets: string;
    readonly projects: string;
    readonly largest: string;
  };
  /** Localised lifecycle-layer label. */
  readonly layerLabel: (layer: TargetLayer) => string;
}

/** Space reserved by the round border (2) plus the horizontal padding (2). */
const FRAME_INSET = 4;
/** Below this content width the bars are dropped and only numbers are shown. */
const BAR_MIN_WIDTH = 56;
/** Widest label column for a layer row. */
const LAYER_LABEL_MAX = 14;

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
 * Render the summary panel.
 *
 * @param props - Aggregates, selection totals and layout width.
 * @returns A framed panel of seven content rows.
 */
export function SummaryPanel({
  summary,
  selectedBytes,
  selectedCount,
  projects,
  theme,
  width,
  labels,
  layerLabel,
}: SummaryPanelProps): ReactNode {
  const inner = Math.max(8, width - FRAME_INSET);
  const showBars = inner >= BAR_MIN_WIDTH;

  // I. Totals justify themselves on one row, split into two equal columns.
  const half = Math.floor(inner / 2);
  const totalsRow =
    pad(withValue(labels.total, formatBytes(summary.totalBytes)), half) +
    pad(withValue(labels.reclaimable, formatBytes(summary.reclaimableBytes)), inner - half);

  // II. Selection against the reclaimable figure, with the only bar whose
  //     denominator the user can change.
  const selectedText = withValue(
    labels.selected,
    `${formatBytes(selectedBytes)} (${formatCount(selectedCount)} ${labels.targets})`,
  );
  const percentText = pad(formatPercent(selectedBytes, summary.reclaimableBytes), 6, 'right');
  // The bar only takes the room the label leaves behind. Sizing it first and
  // truncating the label to fit would cut the very numbers it is explaining.
  const selectionBarWidth = Math.min(24, inner - selectedText.length - percentText.length - 2);
  const showSelectionBar = showBars && selectionBarWidth >= 10;
  const ratio = selectedBytes / Math.max(1, summary.reclaimableBytes);
  const selectionBar = formatBar(ratio, selectionBarWidth);
  // The coloured twin must never be measured: it carries escapes that count as
  // columns, which would truncate the label it is supposed to sit beside.
  const selectionRightPlain = showSelectionBar ? `${selectionBar} ${percentText}` : percentText;
  const selectionRight = showSelectionBar
    ? `${colored(selectionBar, theme.colors.success, theme)} ${percentText}`
    : percentText;

  // III. Inventory facts that do not fit on either row above.
  const factsRow = [
    withValue(labels.targets, formatCount(summary.targetCount)),
    withValue(labels.projects, formatCount(projects)),
    withValue(labels.largest, formatBytes(summary.largestTargetBytes)),
  ].join('  ');

  // IV. Per-layer breakdown: label and bar in the layer's own colour, numbers
  //     in the ordinary foreground so the magnitudes stay comparable.
  const labelWidth = Math.max(6, Math.min(LAYER_LABEL_MAX, inner - 24));
  const layerBarWidth = Math.max(8, Math.min(18, inner - labelWidth - 24));
  const showLayerBars = showBars && layerBarWidth >= 8;

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor={theme.plain ? undefined : theme.colors.primary}
      paddingX={1}
      flexShrink={0}
    >
      <Text {...textStyle(theme, theme.colors.text)} wrap="truncate-end">
        {totalsRow}
      </Text>
      <Text {...textStyle(theme, theme.colors.muted)} wrap="truncate-end">
        {pad(selectedText, Math.max(1, inner - selectionRightPlain.length)) + selectionRight}
      </Text>
      <Text {...textStyle(theme, theme.colors.muted, { dim: true })} wrap="truncate-end">
        {pad(factsRow, inner)}
      </Text>

      {summary.byLayer.map((entry) => {
        const color = layerColor(theme, entry.layer);
        const labelCell = colored(`${pad(layerLabel(entry.layer), labelWidth)} `, color, theme);
        const bytesCell = `${pad(formatBytes(entry.bytes), 9, 'right')} `;
        const percent = inner >= labelWidth + 12 ? formatPercent(entry.bytes, summary.totalBytes) : '';
        const bar = showLayerBars
          ? `${colored(formatBar(entry.bytes / Math.max(1, summary.totalBytes), layerBarWidth), color, theme)} `
          : '';
        return (
          <Text key={entry.layer} {...textStyle(theme, theme.colors.muted)} wrap="truncate-end">
            {`${labelCell}${bytesCell}${bar}${percent}`}
          </Text>
        );
      })}
    </Box>
  );
}
