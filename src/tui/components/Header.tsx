/**
 * TUI Header Bar
 *
 * The one-line identity strip at the top of the application: what the tool is,
 * where it is looking, and which version is running.
 *
 * I. Layout strategy
 *
 * 1. The title owns the left edge and the version is pushed to the right edge of
 *    the same row, so the header reads as a masthead rather than as two labels.
 * 2. Every optional element is *dropped* on a narrow terminal instead of being
 *    allowed to wrap. A wrapped header pushes the whole layout down and breaks
 *    the fixed-height arithmetic the container relies on, which is a far worse
 *    failure than a missing version number.
 * 3. The root path is rendered with `ellipsizePath`, so the meaningful tail
 *    survives; the head of a deep path is the least informative part of it.
 *
 * II. Purity
 *
 * 1. The component reads nothing and remembers nothing: title, root and version
 *    all arrive as props, which keeps the container free to localise them and
 *    keeps this file free of `i18n` imports.
 *
 * @module tui/components/Header
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { ellipsizePath } from '../../core/format.js';
import { type Theme, textStyle } from '../theme.js';

/** Props accepted by {@link Header}. */
export interface HeaderProps {
  /** Application name, already localised. */
  readonly title: string;
  /** One-line description of the current screen or run. */
  readonly subtitle?: string;
  /** Absolute directory being scanned, shown on the right of the subtitle row. */
  readonly root?: string;
  /** Package version, right-aligned against the title. */
  readonly version?: string;
  /** Active theme. */
  readonly theme: Theme;
  /** Total terminal width in columns. */
  readonly width: number;
}

/**
 * Render the application header.
 *
 * I. Width rules
 *
 * 1. Below 40 columns the version is dropped: the title alone is the identity,
 *    and two strings on one row would either collide or wrap.
 * 2. The version is also dropped when it cannot sit at least two columns away
 *    from the title, which is what stops `space-between` from collapsing the gap
 *    to zero on a medium-width terminal.
 * 3. The root path appears only from 60 columns, where it has room to be
 *    genuinely readable rather than a three-character stub.
 */
export function Header({ title, subtitle, root, version, theme, width }: HeaderProps): ReactNode {
  const inner = Math.max(1, width - 2);
  const fitsVersion = version !== undefined && width >= 40 && title.length + version.length + 2 <= inner;
  const showRoot = root !== undefined && root.length > 0 && width >= 60;

  return (
    <Box flexDirection="column" width={width} paddingX={1} flexShrink={0}>
      {/* I. Masthead row: identity on the left, build on the right. */}
      <Box flexDirection="row" width={inner} justifyContent="space-between">
        <Text {...textStyle(theme, theme.colors.primary, { bold: true })} wrap="truncate-end">
          {title}
        </Text>
        {fitsVersion ? (
          <Text {...textStyle(theme, theme.colors.dim, { dim: true })} wrap="truncate-end">
            {version}
          </Text>
        ) : null}
      </Box>

      {/* II. Context rows: description first, then the scan root. */}
      {subtitle !== undefined && subtitle.length > 0 ? (
        <Text {...textStyle(theme, theme.colors.muted)} wrap="truncate-end">
          {subtitle}
        </Text>
      ) : null}
      {showRoot ? (
        <Text {...textStyle(theme, theme.colors.dim, { dim: true })} wrap="truncate-end">
          {ellipsizePath(root, inner)}
        </Text>
      ) : null}

      {/* III. Rule: separates the masthead from the panels below without a box. */}
      <Text {...textStyle(theme, theme.colors.dim)} wrap="truncate-end">
        {'─'.repeat(inner)}
      </Text>
    </Box>
  );
}
