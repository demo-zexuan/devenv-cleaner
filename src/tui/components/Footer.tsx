/**
 * TUI Footer: Status Line and Key Hints
 *
 * The bottom strip of the application: an optional transient message plus the
 * keys that are live on the current screen.
 *
 * I. Why the hints are rendered as items rather than as one string
 *
 * 1. Each hint is its own text node inside a wrapping row, so Ink's own flex
 *    layout decides where a line breaks. Hand-packing a hint string would have to
 *    re-derive exactly the same measurement Ink already performs, and the two
 *    would disagree the moment a localised label changed length.
 * 2. `columnGap` keeps a consistent gutter between hints, so a wrapped second
 *    line still lines up in visible columns.
 *
 * II. Disabled hints
 *
 * 1. A hint whose key is unavailable in the current state is *shown*, dimmed —
 *    hiding it would make the interface feel like it loses capabilities as the
 *    user moves around. The key is additionally wrapped in parentheses, which is
 *    the only cue that survives `theme.plain`, where colour and dimming are
 *    gone.
 * 2. The message tone defaults to `info`; a missing tone must never be treated
 *    as `danger`, because a mis-coloured reassurance is worse than a neutral one.
 *
 * @module tui/components/Footer
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { type Theme, textStyle } from '../theme.js';

/** One key hint shown in the footer bar. */
export interface KeyHint {
  /** Key or chord as the user types it, e.g. `space` or `ctrl+c`. */
  readonly key: string;
  /** What the key does, already localised. */
  readonly label: string;
  /** True when the key is unavailable in the current state. */
  readonly disabled?: boolean;
}

/** Props accepted by {@link Footer}. */
export interface FooterProps {
  /** Hints to render, in priority order: the first ones survive narrow layouts. */
  readonly hints: readonly KeyHint[];
  /** Active theme. */
  readonly theme: Theme;
  /** Total terminal width in columns. */
  readonly width: number;
  /** Transient status line shown above the hints. */
  readonly message?: string;
  /** Semantic tone of `message`; defaults to `info`. */
  readonly messageTone?: 'info' | 'success' | 'warning' | 'danger';
}

/** Palette token used for each message tone. */
const TONE_TOKEN: Readonly<Record<'info' | 'success' | 'warning' | 'danger', keyof Theme['colors']>> = {
  info: 'primary',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
};

/**
 * Render the footer strip.
 *
 * I. Degradation
 *
 * 1. The message line is kept as long as it is set; it is ellipsized to one line
 *    rather than wrapped, so the height of the footer depends only on whether a
 *    message exists.
 * 2. Hints wrap as whole items; past the available height the excess is clipped
 *    by the container, which is why hints are ordered most-important-first.
 */
export function Footer({ hints, theme, width, message, messageTone = 'info' }: FooterProps): ReactNode {
  const inner = Math.max(1, width - 2);
  const showMessage = message !== undefined && message.length > 0;

  if (!showMessage && hints.length === 0) return null;

  return (
    <Box flexDirection="column" width={width} paddingX={1} flexShrink={0}>
      {showMessage ? (
        <Text
          {...textStyle(theme, theme.colors[TONE_TOKEN[messageTone]], { bold: messageTone === 'danger' })}
          wrap="truncate-end"
        >
          {message}
        </Text>
      ) : null}

      <Box flexDirection="row" flexWrap="wrap" columnGap={2} width={inner}>
        {hints.map((hint) => {
          const disabled = hint.disabled === true;
          const keyText = disabled ? `(${hint.key})` : hint.key;
          return (
            <Text
              key={`${hint.key}:${hint.label}`}
              {...textStyle(theme, disabled ? theme.colors.dim : theme.colors.muted, { dim: disabled })}
              wrap="truncate-end"
            >
              <Text
                {...textStyle(theme, disabled ? theme.colors.dim : theme.colors.accent, { bold: !disabled })}
              >
                {keyText}
              </Text>
              {` ${hint.label}`}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
