/**
 * TUI Target List
 *
 * The framed, windowed table of discovered targets: one border, one column
 * header, and the slice of rows the viewport can hold.
 *
 * I. Why the windowing lives here
 *
 * 1. A scan of a developer home routinely finds thousands of targets. Ink lays
 *    out every node it is given, so rendering the whole array would make the
 *    frame cost grow with the result set instead of with the screen. The list
 *    slices to the viewport and nothing else is ever mounted.
 * 2. The scroll offset is a *prop*, not state. Scrolling is a key-handling
 *    concern, and key handling belongs to the container; a list that tracked its
 *    own offset would silently disagree with the cursor index it is also given.
 *
 * II. One panel, not one box per row
 *
 * 1. The border belongs to the list. Individual rows are bare flex lines, so the
 *    table reads as a single surface and the focus fill can run edge to edge
 *    inside the frame.
 * 2. The column header is built from the exact same grid as the rows — both call
 *    {@link targetColumnWidths} — which is the only reason the header can never
 *    drift out of alignment with the data.
 *
 * @module tui/components/TargetList
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { pad } from '../../core/format.js';
import type { CleanTarget, LockReason, RiskLevel } from '../../core/types.js';
import { centre, type Theme, textStyle } from '../theme.js';
import { TargetRow, targetColumnWidths } from './TargetRow.js';

/** Props accepted by {@link TargetList}. */
export interface TargetListProps {
  /** Targets to display, already filtered and sorted by the container. */
  readonly targets: readonly CleanTarget[];
  /** Ids of the selected targets. */
  readonly selectedIds: ReadonlySet<string>;
  /** Index into `targets` that holds the cursor. */
  readonly focusedIndex: number;
  /** Height of the panel, borders included. */
  readonly height: number;
  /** Scroll offset in rows, managed by the container. */
  readonly offset: number;
  /** True when rows should lead with a project label. */
  readonly showProject: boolean;
  /** Active theme. */
  readonly theme: Theme;
  /** Total terminal width in columns. */
  readonly width: number;
  /** Text shown when there is nothing to display. */
  readonly emptyLabel: string;
  /** Localised risk label resolver. */
  readonly riskLabel: (risk: RiskLevel) => string;
  /** Localised lock reason resolver. */
  readonly lockLabel: (reason: LockReason) => string;
  /** Localised column headings. */
  readonly header: {
    readonly size: string;
    readonly path: string;
    readonly rule: string;
    readonly risk: string;
    readonly age: string;
  };
}

/** Space reserved by the round border (2) plus the horizontal padding (2). */
const FRAME_INSET = 4;
/** From this panel height the header gets its own separating rule. */
const HEADER_RULE_MIN_HEIGHT = 8;

/**
 * Render the target table.
 *
 * I. Height accounting
 *
 * 1. The border consumes two rows and the header one; the separating rule takes
 *    a fourth on any panel tall enough to have room for it. Everything left over
 *    is row budget.
 * 2. A panel too short to hold a frame (under three rows) renders nothing at
 *    all: half a border is worse than an honest gap.
 */
export function TargetList({
  targets,
  selectedIds,
  focusedIndex,
  height,
  offset,
  showProject,
  theme,
  width,
  emptyLabel,
  riskLabel,
  lockLabel,
  header,
}: TargetListProps): ReactNode {
  const frameHeight = Math.max(0, Math.floor(height));
  if (frameHeight < 3) return null;

  const inner = Math.max(1, width - FRAME_INSET);
  const layout = targetColumnWidths(inner);
  const showHeaderRule = frameHeight >= HEADER_RULE_MIN_HEIGHT;
  const contentHeight = Math.max(1, frameHeight - 2);
  const visibleRows = Math.max(1, contentHeight - 1 - (showHeaderRule ? 1 : 0));

  const start = Math.max(0, Math.min(Math.floor(offset), Math.max(0, targets.length - 1)));
  const visible = targets.slice(start, start + visibleRows);

  const headerStyle = textStyle(theme, theme.colors.muted, { bold: true });
  const headerCells: Array<{ readonly key: string; readonly text: string }> = [
    { key: 'marker', text: pad('', layout.marker) },
    { key: 'size', text: pad(header.size, layout.size, 'right') },
  ];
  if (layout.showRisk) headerCells.push({ key: 'risk', text: centre(header.risk, layout.risk) });
  if (layout.showAge) headerCells.push({ key: 'age', text: pad(header.age, layout.age) });
  if (layout.showRule) headerCells.push({ key: 'rule', text: pad(header.rule, layout.rule) });
  if (layout.path > 0) headerCells.push({ key: 'path', text: pad(header.path, layout.path) });

  return (
    <Box
      flexDirection="column"
      width={width}
      height={frameHeight}
      borderStyle="round"
      borderColor={theme.plain ? undefined : theme.colors.primary}
      paddingX={1}
      overflow="hidden"
    >
      {/* I. The content column never shrinks. A short frame then clips its
             bottom rows, which is the degradation this screen wants; letting
             Yoga compress the rows instead would overlap their text nodes. */}
      <Box flexDirection="column" width={inner} flexShrink={0}>
        {/* II. Column headings, on the same grid as the rows below. */}
        <Box flexDirection="row" width={inner}>
          {headerCells.map((cell, index) => (
            <Text key={cell.key} {...headerStyle} wrap="truncate-end">
              {index === 0 ? cell.text : ` ${cell.text}`}
            </Text>
          ))}
        </Box>

        {showHeaderRule ? (
          <Text {...textStyle(theme, theme.colors.dim)} wrap="truncate-end">
            {'─'.repeat(inner)}
          </Text>
        ) : null}

        {/* III. The visible slice, or the empty-state line. */}
        {visible.length === 0 ? (
          <Text {...textStyle(theme, theme.colors.muted, { dim: true })} wrap="truncate-end">
            {pad(`  ${emptyLabel}`, inner)}
          </Text>
        ) : (
          visible.map((target, index) => {
            const reason = target.locked && target.lockedReason !== null ? target.lockedReason : null;
            return (
              <TargetRow
                key={target.id}
                target={target}
                selected={selectedIds.has(target.id)}
                focused={start + index === focusedIndex}
                showProject={showProject}
                theme={theme}
                width={inner}
                riskLabel={riskLabel(target.risk)}
                lockLabel={reason === null ? null : lockLabel(reason)}
              />
            );
          })
        )}
      </Box>
    </Box>
  );
}
