/**
 * Presentation Formatting Helpers
 *
 * Pure, dependency-free formatters shared by the CLI output, the Markdown
 * reporter and the Ink TUI, so a byte count reads identically everywhere.
 *
 * I. Why this is its own module
 *
 * 1. Formatting is the one place where "logic" and "presentation" genuinely
 *    blur, and duplicating it across three front-ends guarantees drift.
 * 2. Every function here is pure and allocation-light, which makes the TUI's
 *    per-frame rendering cheap and the formatters trivially unit-testable.
 *
 * @module core/format
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * Format a raw byte count for humans.
 *
 * I. Behaviour
 *
 * 1. Uses binary multiples (1024) because that is what `du`-style intuition
 *    expects and what every package manager reports.
 * 2. Precision shrinks as magnitude grows: bytes are integers, everything else
 *    keeps one decimal, and values at or above 100 units drop the decimal so
 *    columns stay aligned in the TUI.
 * 3. Negative values are rendered with a leading sign, which the report diff
 *    relies on for shrink/grow deltas.
 *
 * @param bytes - Raw byte count; may be negative for a delta.
 * @returns A short human string such as `1.4 GB` or `0 B`.
 *
 * @example
 * ```ts
 * formatBytes(0)        // '0 B'
 * formatBytes(1536)     // '1.5 KB'
 * formatBytes(-2048)    // '-2 KB'
 * ```
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'n/a';
  const sign = bytes < 0 ? '-' : '';
  const absolute = Math.abs(bytes);
  if (absolute < 1024) return `${sign}${Math.round(absolute)} B`;

  let value = absolute;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 100 ? Math.round(value).toString() : value.toFixed(1);
  // Strip a trailing `.0` so `2.0 MB` reads as `2 MB`.
  const trimmed = rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded;
  return `${sign}${trimmed} ${BYTE_UNITS[unitIndex]}`;
}

/**
 * Format a byte count with an explicit sign, for report diffs.
 *
 * @param bytes - Signed byte delta.
 * @returns A string such as `+1.2 GB`, `-300 MB`, or `0 B`.
 */
export function formatSignedBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  return bytes > 0 ? `+${formatBytes(bytes)}` : formatBytes(bytes);
}

/**
 * Format a percentage of a whole.
 *
 * @param part - Numerator.
 * @param whole - Denominator; a non-positive value yields `0%`.
 * @param fractionDigits - Digits after the decimal point; defaults to 1.
 * @returns A string such as `13.4%`.
 */
export function formatPercent(part: number, whole: number, fractionDigits = 1): string {
  if (whole <= 0) return '0%';
  const value = (part / whole) * 100;
  // At the extremes the decimal is noise, so collapse to a whole number.
  if (value >= 99.95) return '100%';
  if (value > 0 && value < 0.05) return '<0.1%';
  return `${value.toFixed(fractionDigits)}%`;
}

/**
 * Format a duration for log lines and summaries.
 *
 * @param milliseconds - Elapsed time in milliseconds.
 * @returns `450ms`, `2.4s`, or `1m 12s`.
 */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'n/a';
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

/**
 * Format a whole number with thin thousands separators.
 *
 * @param value - The number to format.
 * @returns A grouped string such as `1,204,553`.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  const sign = value < 0 ? '-' : '';
  const digits = Math.trunc(Math.abs(value)).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Render a text progress bar.
 *
 * @param ratio - Completion between 0 and 1; clamped.
 * @param width - Total character width including brackets; defaults to 20.
 * @param filled - Character used for the completed portion.
 * @param empty - Character used for the remainder.
 * @returns A string such as `[####------]`.
 */
export function formatBar(ratio: number, width = 20, filled = '#', empty = '-'): string {
  const inner = Math.max(1, width - 2);
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const filledCount = Math.round(clamped * inner);
  return `[${filled.repeat(filledCount)}${empty.repeat(inner - filledCount)}]`;
}

/**
 * Code point ranges rendered two terminal columns wide.
 *
 * This is the subset of Unicode's East Asian Width property that a developer
 * tool realistically meets: the CJK blocks, Hangul, fullwidth forms, and the
 * emoji planes. Treating these as one column is the single most common source
 * of broken terminal alignment, because a Chinese label is twice as wide as it
 * is long.
 */
function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

/**
 * Measure the number of terminal columns a string occupies.
 *
 * I. Why this cannot be `String.length`
 *
 * 1. `.length` counts UTF-16 code units. A CJK ideograph is one code unit but
 *    two columns, and a surrogate pair is two code units but one or two
 *    columns. Padding by `.length` therefore under-pads by exactly the number
 *    of wide characters, the content box overflows, and Ink's `truncate-end`
 *    silently eats the panel's right border — the row looks broken rather than
 *    merely long.
 * 2. Control characters and combining marks are given zero width because they
 *    occupy no cell; a colour escape sequence never reaches here (callers pass
 *    plain text) but a stray `\t` should not inflate a measurement.
 *
 * II. Deliberate simplification
 *
 * 1. Ambiguous-width characters (Greek, Cyrillic, box drawing) are counted as
 *    one column, which is what almost every terminal does by default and what
 *    the `wcwidth` locale defaults to outside CJK locales.
 *
 * @param value - The string to measure.
 * @returns Its display width in terminal columns.
 *
 * @example
 * ```ts
 * displayWidth('abc')      // 3
 * displayWidth('确认删除')  // 8
 * ```
 */
export function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    // Control characters and the surrogate range occupy no cell.
    if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) continue;
    // Zero-width joiner and the combining diacritical marks.
    if (codePoint === 0x200d || (codePoint >= 0x0300 && codePoint <= 0x036f)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

/**
 * Cut a string to a maximum display width, marking the cut with an ellipsis.
 *
 * @param value - The string to cut.
 * @param width - Maximum display width in columns.
 * @returns A string whose `displayWidth` is at most `width`.
 */
export function truncateToWidth(value: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(value) <= width) return value;

  const ellipsis = '…';
  const budget = width - displayWidth(ellipsis);

  // I. No room for even an ellipsis: fall back to the longest prefix that fits
  //    the cell on its own. Emitting nothing would waste a column that the
  //    caller has deliberately allocated, which shows up as a ragged column in
  //    a narrow terminal.
  if (budget <= 0) {
    let prefix = '';
    let used = 0;
    for (const character of value) {
      const characterWidth = displayWidth(character);
      if (used + characterWidth > width) break;
      prefix += character;
      used += characterWidth;
    }
    return prefix;
  }

  let kept = '';
  let used = 0;
  for (const character of value) {
    const characterWidth = displayWidth(character);
    // A wide character that would straddle the boundary is dropped whole; half
    // a glyph is worse than a shorter label.
    if (used + characterWidth > budget) break;
    kept += character;
    used += characterWidth;
  }
  return `${kept}${ellipsis}`;
}

/**
 * Pad a string to a target display width, truncating with an ellipsis when too
 * long.
 *
 * I. Why the width is measured in columns
 *
 * 1. Terminals have no layout engine, so every column in the TUI is padded by
 *    hand; centralising it keeps the tables from drifting out of alignment.
 * 2. The measurement is `displayWidth`, not `.length`, so a Chinese label and
 *    an English one with the same column budget produce rows of identical
 *    width. Padding by code units silently overflows on any CJK text.
 *
 * @param value - The input string.
 * @param width - Target display width in columns.
 * @param align - `left` pads on the right, `right` pads on the left.
 * @returns A string occupying exactly `width` columns when `width` is positive.
 */
export function pad(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (width <= 0) return '';
  const text = displayWidth(value) > width ? truncateToWidth(value, width) : value;
  const padding = ' '.repeat(Math.max(0, width - displayWidth(text)));
  return align === 'left' ? text + padding : padding + text;
}

/**
 * Shorten an absolute path to fit a width, keeping the meaningful tail.
 *
 * I. Strategy
 *
 * 1. Paths are read right-to-left by humans, so the tail is preserved and the
 *    head is elided — the opposite of naive truncation.
 * 2. When even the tail does not fit, the last path component is truncated.
 * 3. Every measurement is in display columns, so a path containing CJK
 *    directory names still lands exactly inside its budget.
 *
 * @param value - Absolute path.
 * @param width - Available display width in columns.
 * @returns A path that fits, with a leading `…/` when it was shortened.
 */
export function ellipsizePath(value: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(value) <= width) return value;
  const separator = value.includes('\\') ? '\\' : '/';
  const segments = value.split(/[\\/]/).filter((segment) => segment.length > 0);
  const tail: string[] = [];
  let length = 0;

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] as string;
    const segmentWidth = displayWidth(segment);
    const addition = tail.length === 0 ? segmentWidth : segmentWidth + 1;
    if (length + addition + 2 > width) break;
    tail.unshift(segment);
    length += addition;
  }

  if (tail.length === 0) {
    // Nothing fit: keep the tail of the last segment, cut by display width.
    const last = segments.at(-1) ?? value;
    if (displayWidth(last) <= width) return last;
    const budget = width - 1;
    if (budget <= 0) return '';
    let kept = '';
    let used = 0;
    for (let index = last.length - 1; index >= 0; index -= 1) {
      const character = last[index] as string;
      const characterWidth = displayWidth(character);
      if (used + characterWidth > budget) break;
      kept = character + kept;
      used += characterWidth;
    }
    return `…${kept}`;
  }
  return `…${separator}${tail.join(separator)}`;
}

/**
 * Format an age in days as a compact human string.
 *
 * @param days - Age in days; fractional values are accepted.
 * @returns `today`, `3d`, `2.1y`, or `—` when the value is not finite.
 */
export function formatAge(days: number): string {
  if (!Number.isFinite(days)) return '—';
  if (days < 1) return 'today';
  if (days < 60) return `${Math.floor(days)}d`;
  if (days < 730) return `${Math.floor(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

/**
 * Format epoch milliseconds as a local ISO-like timestamp.
 *
 * @param mtimeMs - Modification time in epoch milliseconds.
 * @returns `2026-09-29 22:37` in the host timezone.
 */
export function formatTimestamp(mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs)) return 'n/a';
  const date = new Date(mtimeMs);
  const pad2 = (value: number): string => value.toString().padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}
