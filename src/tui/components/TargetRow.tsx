/**
 * TUI Target Row
 *
 * One selectable line of the results table: selection state, size, risk, age,
 * the rule that produced it, and the path itself.
 *
 * I. One row, one highlight bar
 *
 * 1. The row is laid out as a fixed-width cell grid because a terminal has no
 *    table engine. {@link targetColumnWidths} is the single definition of that
 *    grid, shared with the list header so the two can never drift.
 * 2. Every character of the row — including the one-space gutters and the
 *    padding at the end of the path — is emitted inside a styled text node.
 *    Ink writes children after it paints a box background, so any *unstyled*
 *    character would punch a hole straight through the focus bar.
 *
 * II. Three visual states, three levels of emphasis
 *
 * 1. Focused: a full-width fill, and every cell in one contrasting ink. Per-cell
 *    colour is deliberately suppressed here — a red risk badge on a magenta bar
 *    is noise, and the bar already says where the cursor is.
 * 2. Selected but not focused: the accent marker. Selection has to survive the
 *    cursor moving away, so it cannot live in the fill.
 * 3. Locked: dim, an `x` marker, and the lock reason appended. A locked target
 *    can still hold the cursor (the container walks every row) but it is filled
 *    with grey rather than the accent, and it never renders a selection marker.
 *
 * III. Width degradation
 *
 * 1. The grid loses the rule and age columns together, then the risk column, as
 *    the row narrows. What never disappears is the marker, the size and a path
 *    tail, because those are the three things a person scans for.
 * 2. The thresholds are evaluated against the width the row is *given*, which
 *    inside a round-framed panel is already four columns narrower than the panel
 *    (two border columns, two padding columns). The rule and age columns
 *    therefore disappear from a panel of 64 columns rather than of 60; the row
 *    has no way to know about a frame it does not draw, and inventing that
 *    knowledge would make a standalone row render four columns short.
 * 3. `showProject` swaps the absolute path for a project label plus the path
 *    *relative* to that project, which is what makes a grouped-by-project list
 *    readable instead of repeating one 40-character prefix on every line. The
 *    label appears only when the target really lives under `projectPath`.
 *
 * @module tui/components/TargetRow
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { ellipsizePath, formatAge, formatBytes, pad } from '../../core/format.js';
import type { CleanTarget } from '../../core/types.js';
import {
  barBackground,
  barStyle,
  centre,
  chip,
  riskColor,
  type TextStyle,
  type Theme,
  textStyle,
} from '../theme.js';

/** Props accepted by {@link TargetRow}. */
export interface TargetRowProps {
  /** Target to render. */
  readonly target: CleanTarget;
  /** True when the target is in the current selection. */
  readonly selected: boolean;
  /** True when the cursor is on this row. */
  readonly focused: boolean;
  /** True when the path column should show a project label instead of the head. */
  readonly showProject: boolean;
  /** Active theme. */
  readonly theme: Theme;
  /** Width available to the row, in columns; the highlight bar is exactly this wide. */
  readonly width: number;
  /** Localised risk label for this target, e.g. `Low`. */
  readonly riskLabel: string;
  /** Localised lock reason, or null when the target is selectable. */
  readonly lockLabel: string | null;
}

/** Column widths of the row grid, resolved for one available width. */
export interface TargetColumnLayout {
  /** Selection-marker column. */
  readonly marker: number;
  /** Right-aligned byte column. */
  readonly size: number;
  /** Risk chip column; 0 when hidden. */
  readonly risk: number;
  /** Age column; 0 when hidden. */
  readonly age: number;
  /** Rule column; 0 when hidden. */
  readonly rule: number;
  /** Remaining width for the path; 0 only on a degenerate terminal. */
  readonly path: number;
  /** True when the risk column is rendered. */
  readonly showRisk: boolean;
  /** True when the age column is rendered. */
  readonly showAge: boolean;
  /** True when the rule column is rendered. */
  readonly showRule: boolean;
}

/** Marker column width, including the space after the glyph. */
const MARKER_WIDTH = 2;
/** Byte column width; `1023.9 KB` is the widest value `formatBytes` produces. */
const SIZE_WIDTH = 9;
/** Risk chip width. */
const RISK_WIDTH = 7;
/** Age column width; `today` is the widest value `formatAge` produces. */
const AGE_WIDTH = 6;
/** Rule column width, ellipsized by `pad`. */
const RULE_WIDTH = 22;
/** One-space gutter between two columns. */
const GAP = 1;
/** Below this width the row can only afford a marker, a size and a path. */
const NARROW_WIDTH = 40;
/** From this width up the full grid, including rule and age, is affordable. */
const WIDE_WIDTH = 60;

/**
 * Resolve the column grid for an available width.
 *
 * I. Tiers
 *
 * 1. `>= 60`: marker, size, risk, age, rule and the remaining path.
 * 2. `40 .. 59`: the rule and age columns go together. They are dropped as a
 *    pair because the rule text without its age is the less useful half, and
 *    freeing 22 + 6 + 2 gutters is what keeps the path readable.
 * 3. `< 40`: only the marker, the size and the path survive.
 * 4. Degenerate widths: the byte column itself shrinks so that the marker, one
 *    byte value and a path stub still fit without overflowing the frame.
 *
 * @param width - Available width for the whole row, in columns.
 * @returns The resolved grid.
 */
export function targetColumnWidths(width: number): TargetColumnLayout {
  const total = Math.max(0, Math.floor(width));
  const showRule = total >= WIDE_WIDTH;
  const showAge = total >= WIDE_WIDTH;
  const showRisk = total >= NARROW_WIDTH;

  const fixed =
    MARKER_WIDTH +
    GAP +
    SIZE_WIDTH +
    GAP +
    (showRisk ? RISK_WIDTH + GAP : 0) +
    (showAge ? AGE_WIDTH + GAP : 0) +
    (showRule ? RULE_WIDTH + GAP : 0);
  const path = total - fixed;

  if (path >= 4) {
    return {
      marker: MARKER_WIDTH,
      size: SIZE_WIDTH,
      risk: showRisk ? RISK_WIDTH : 0,
      age: showAge ? AGE_WIDTH : 0,
      rule: showRule ? RULE_WIDTH : 0,
      path,
      showRisk,
      showAge,
      showRule,
    };
  }

  // I. Degenerate: keep the marker, shrink the byte column to whatever is left.
  return {
    marker: MARKER_WIDTH,
    size: Math.max(1, total - MARKER_WIDTH - GAP),
    risk: 0,
    age: 0,
    rule: 0,
    path: 0,
    showRisk: false,
    showAge: false,
    showRule: false,
  };
}

/**
 * Build the path cell text, optionally relative to its project.
 *
 * @param target - Target being rendered.
 * @param showProject - Whether to lead with a project label.
 * @param width - Column width available.
 * @returns Text that fits `width`.
 */
function displayPath(target: CleanTarget, showProject: boolean, width: number): string {
  if (!showProject || target.projectName === null) return ellipsizePath(target.path, width);

  const prefix = target.projectPath;
  // The label is only honest when the target really lives under that project, so
  // a stale `projectPath` cannot relabel an unrelated directory.
  if (prefix === null || !target.path.startsWith(prefix)) return ellipsizePath(target.path, width);

  const label = `[${target.projectName}] `;
  // A label wider than its column would push the row past the frame, so at that
  // point the absolute path is the lesser evil.
  if (label.length + 6 > width) return ellipsizePath(target.path, width);

  const relative = target.path.slice(prefix.length).replace(/^[/\\]/, '');
  return label + ellipsizePath(relative, Math.max(1, width - label.length));
}

/**
 * Render one target row.
 *
 * @param props - Row state and layout width.
 * @returns A single-line row, sized exactly to `props.width`.
 */
export function TargetRow({
  target,
  selected,
  focused,
  showProject,
  theme,
  width,
  riskLabel,
  lockLabel,
}: TargetRowProps): ReactNode {
  const layout = targetColumnWidths(width);
  const locked = target.locked;
  const barColor = locked ? theme.colors.muted : theme.colors.accent;
  const barText = barStyle(theme, barColor);

  // I. Per-cell style. On the focused row every cell shares one ink, so the bar
  //    reads as a single surface; everywhere else the cell keeps its meaning.
  const cellStyle = (color?: string): TextStyle =>
    focused ? barText : textStyle(theme, color, { dim: locked });

  // II. Marker: lock wins over selection, and focus is shown by the bar itself
  //     when colour is available — the caret is the plain-text fallback.
  const marker = locked ? 'x' : selected ? '●' : focused ? '>' : ' ';
  const markerColor = locked ? theme.colors.dim : theme.colors.accent;

  // III. Risk chip is pre-coloured, so it only keeps that colour when the row is
  //      neither focused (one ink) nor locked (dim).
  const riskPreColoured = !focused && !locked;
  const riskText = riskPreColoured
    ? chip(theme, riskLabel, riskColor(theme, target.risk), layout.risk)
    : centre(riskLabel, layout.risk);

  // IV. Lock reason: appended to the rule cell when it exists, otherwise carved
  //     out of the path so a narrow terminal still explains why the row is inert.
  //     It is only carved out when the path keeps a readable stub afterwards.
  const annotation = lockLabel !== null && lockLabel.length > 0 ? `(${lockLabel})` : '';
  const suffixCandidate = annotation.length > 0 && !layout.showRule ? ` ${annotation}` : '';
  const suffix =
    suffixCandidate.length > 0 && layout.path >= suffixCandidate.length + 6 ? suffixCandidate : '';
  const pathWidth = suffix.length > 0 ? layout.path - suffix.length : layout.path;
  const pathText =
    layout.path > 0
      ? pad(displayPath(target, showProject, Math.max(1, pathWidth)) + suffix, layout.path)
      : '';

  const cells: Array<{ readonly key: string; readonly text: string; readonly color?: string }> = [];
  cells.push({ key: 'marker', text: pad(marker, layout.marker), color: markerColor });
  cells.push({ key: 'size', text: pad(formatBytes(target.bytes), layout.size, 'right') });
  if (layout.showRisk) {
    cells.push({
      key: 'risk',
      text: riskText,
      color: riskPreColoured ? undefined : locked ? theme.colors.dim : undefined,
    });
  }
  if (layout.showAge) {
    cells.push({ key: 'age', text: pad(formatAge(target.ageDays), layout.age) });
  }
  if (layout.showRule) {
    const ruleText = annotation.length > 0 ? `${target.label} ${annotation}` : target.label;
    cells.push({ key: 'rule', text: pad(ruleText, layout.rule) });
  }
  if (layout.path > 0) {
    cells.push({ key: 'path', text: pathText });
  }

  return (
    <Box
      flexDirection="row"
      width={width}
      flexShrink={0}
      backgroundColor={focused ? barBackground(theme, barColor) : undefined}
    >
      {cells.map((cell, index) => (
        <Text key={cell.key} {...cellStyle(cell.color)} wrap="truncate-end">
          {index === 0 ? cell.text : ` ${cell.text}`}
        </Text>
      ))}
    </Box>
  );
}
