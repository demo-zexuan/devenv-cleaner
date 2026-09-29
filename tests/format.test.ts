/**
 * Pure Formatter Behaviour
 *
 * Pins the presentation contract of `src/core/format.ts`. Every assertion here
 * is about a boundary a caller can observe: the byte-unit switch, the decimal
 * that disappears above 100 units, the percentage collapse at the extremes, and
 * the truncation rules the TUI's fixed-width columns depend on.
 *
 * I. Why boundaries and not examples
 *
 * 1. These functions are pure and tiny, so a test that asserts `formatBytes(1536)`
 *    proves almost nothing. The risk they carry is a boundary moving by one
 *    byte, one millisecond or one character — which reflows every table in the
 *    product without failing any example-based test.
 * 2. Where a value is genuinely surprising (a rounded `1000ms` that technically
 *    exceeded the sub-second branch) the expectation is written down explicitly
 *    with a comment, so a future change is a deliberate decision rather than an
 *    accident.
 *
 * @module tests/format
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { describe, expect, it } from 'vitest';

import {
  displayWidth,
  ellipsizePath,
  formatAge,
  formatBar,
  formatBytes,
  formatCount,
  formatDuration,
  formatPercent,
  formatSignedBytes,
  formatTimestamp,
  pad,
  truncateToWidth,
} from '../src/core/format.js';

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

describe('formatBytes', () => {
  it('renders zero and sub-kilobyte values as whole bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('rounds sub-kilobyte values to the nearest byte instead of switching unit', () => {
    // A value just under the switch rounds up to 1024 but stays in the byte
    // unit, because the unit decision uses the unrounded magnitude.
    expect(formatBytes(1023.4)).toBe('1023 B');
    expect(formatBytes(1023.6)).toBe('1024 B');
  });

  it('switches to the next binary unit exactly at 1024', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(GIB)).toBe('1 GB');
    expect(formatBytes(1024 * GIB)).toBe('1 TB');
    expect(formatBytes(1024 * 1024 * GIB)).toBe('1 PB');
  });

  it('keeps one decimal below 100 units and drops it at or above 100', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(99.5 * KIB)).toBe('99.5 KB');
    expect(formatBytes(99 * KIB)).toBe('99 KB');
    expect(formatBytes(100 * KIB)).toBe('100 KB');
    expect(formatBytes(150 * KIB)).toBe('150 KB');
    // 102399 bytes is 99.999 KB, which rounds to "100.0" and then has its
    // decimal stripped: the two rules compose rather than conflict.
    expect(formatBytes(102399)).toBe('100 KB');
  });

  it('strips a trailing .0 so a whole number of units is not padded', () => {
    expect(formatBytes(2 * MIB)).toBe('2 MB');
    expect(formatBytes(3 * GIB)).toBe('3 GB');
  });

  it('keeps a leading minus sign for negative deltas', () => {
    expect(formatBytes(-1)).toBe('-1 B');
    expect(formatBytes(-1536)).toBe('-1.5 KB');
    expect(formatBytes(-2 * GIB)).toBe('-2 GB');
    expect(formatBytes(-0)).toBe('0 B');
  });

  it('caps the unit scale at PB rather than inventing a larger unit', () => {
    expect(formatBytes(1024 ** 6)).toBe('1024 PB');
  });

  it('reports a non-finite value as n/a instead of NaN', () => {
    expect(formatBytes(Number.NaN)).toBe('n/a');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('n/a');
  });
});

describe('formatSignedBytes', () => {
  it('renders an explicit plus for growth and the natural minus for shrinkage', () => {
    expect(formatSignedBytes(1536)).toBe('+1.5 KB');
    expect(formatSignedBytes(-1536)).toBe('-1.5 KB');
    expect(formatSignedBytes(2 * GIB)).toBe('+2 GB');
  });

  it('renders a zero delta without a sign', () => {
    expect(formatSignedBytes(0)).toBe('0 B');
  });
});

describe('formatPercent', () => {
  it('returns 0% for a non-positive whole instead of dividing by zero', () => {
    expect(formatPercent(5, 0)).toBe('0%');
    expect(formatPercent(5, -1)).toBe('0%');
  });

  it('collapses the top of the range to exactly 100%', () => {
    expect(formatPercent(1, 1)).toBe('100%');
    expect(formatPercent(2, 1)).toBe('100%');
    // 99.95 is the inclusive threshold: below it the decimal is still shown.
    expect(formatPercent(1999, 2000)).toBe('100%');
    expect(formatPercent(1998, 2000)).toBe('99.9%');
  });

  it('collapses a positive share below 0.05% to <0.1%', () => {
    expect(formatPercent(1, 100_000)).toBe('<0.1%');
    // Exactly 0.05% is not "below" the threshold, so it is shown rounded.
    expect(formatPercent(1, 2000)).toBe('0.1%');
  });

  it('shows a plain zero without the inequality marker', () => {
    expect(formatPercent(0, 100)).toBe('0.0%');
  });

  it('honours the requested fraction digits', () => {
    expect(formatPercent(1, 3, 2)).toBe('33.33%');
    expect(formatPercent(1, 3, 0)).toBe('33%');
  });
});

describe('formatDuration', () => {
  it('renders sub-second durations in whole milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(1)).toBe('1ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('rounds a sub-second duration up to the millisecond boundary', () => {
    // 999.6 ms rounds to 1000 but the branch was chosen before rounding, so the
    // output is "1000ms" rather than "1.0s". Pinned deliberately.
    expect(formatDuration(999.6)).toBe('1000ms');
  });

  it('switches to seconds at exactly 1000ms', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(59_900)).toBe('59.9s');
  });

  it('switches to minutes and seconds at exactly 60s', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(72_000)).toBe('1m 12s');
    expect(formatDuration(3_600_000)).toBe('60m 0s');
  });

  it('reports a negative or non-finite duration as n/a', () => {
    expect(formatDuration(-1)).toBe('n/a');
    expect(formatDuration(Number.NaN)).toBe('n/a');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('n/a');
  });
});

describe('formatCount', () => {
  it('groups thousands with commas at the correct boundaries', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1000)).toBe('1,000');
    expect(formatCount(1_204_553)).toBe('1,204,553');
  });

  it('keeps the sign outside the grouped digits', () => {
    expect(formatCount(-1_234_567)).toBe('-1,234,567');
  });

  it('truncates a fractional count rather than rounding it', () => {
    expect(formatCount(1234.9)).toBe('1,234');
  });

  it('reports a non-finite count as n/a', () => {
    expect(formatCount(Number.NaN)).toBe('n/a');
  });
});

describe('pad', () => {
  it('pads on the requested side to exactly the target width', () => {
    expect(pad('abc', 5)).toBe('abc  ');
    expect(pad('abc', 5, 'right')).toBe('  abc');
    expect(pad('abc', 3)).toBe('abc');
  });

  it('truncates an over-long value with a single-character ellipsis', () => {
    expect(pad('abcdef', 4)).toBe('abc…');
    expect(pad('abcdef', 4).length).toBe(4);
  });

  it('drops the ellipsis when there is no room for one', () => {
    expect(pad('abcdef', 1)).toBe('a');
  });

  it('returns an empty string for a non-positive width', () => {
    expect(pad('abc', 0)).toBe('');
    expect(pad('abc', -5)).toBe('');
  });
});

describe('ellipsizePath', () => {
  it('leaves a path that already fits untouched', () => {
    expect(ellipsizePath('/a/b/c', 20)).toBe('/a/b/c');
  });

  it('keeps the tail and elides the head for a POSIX path', () => {
    // Right-to-left reading is the point: the meaningful part of a path is its
    // end, so "…/to/node_modules" beats "/very/long/path…".
    expect(ellipsizePath('/very/long/path/to/node_modules', 20)).toBe('…/to/node_modules');
  });

  it('keeps the tail and preserves the backslash separator for a Windows path', () => {
    const shortened = ellipsizePath('C:\\very\\long\\path\\to\\node_modules', 20);
    expect(shortened).toBe('…\\to\\node_modules');
    expect(shortened).not.toContain('/');
  });

  it('cuts the last segment when no whole segment fits', () => {
    expect(ellipsizePath('/a/longsegment', 5)).toBe('…ment');
    expect(ellipsizePath('/abcdefg', 6)).toBe('…cdefg');
  });

  it('returns an empty string for a non-positive width', () => {
    expect(ellipsizePath('/a/b', 0)).toBe('');
  });
});

describe('formatAge', () => {
  it('buckets days under one as today', () => {
    expect(formatAge(0)).toBe('today');
    expect(formatAge(0.9)).toBe('today');
  });

  it('renders whole days below 60 and months below two years', () => {
    expect(formatAge(1)).toBe('1d');
    expect(formatAge(59.9)).toBe('59d');
    expect(formatAge(60)).toBe('2mo');
    expect(formatAge(729)).toBe('24mo');
  });

  it('renders years with one decimal from two years onward', () => {
    expect(formatAge(730)).toBe('2.0y');
    expect(formatAge(1000)).toBe('2.7y');
  });

  it('reports a non-finite age with an em dash', () => {
    expect(formatAge(Number.NaN)).toBe('—');
  });
});

describe('formatBar', () => {
  it('renders an empty and a full bar at the ratio extremes', () => {
    expect(formatBar(0, 10)).toBe('[--------]');
    expect(formatBar(1, 10)).toBe('[########]');
  });

  it('clamps a ratio outside 0..1 and treats a non-finite ratio as empty', () => {
    expect(formatBar(2, 10)).toBe('[########]');
    expect(formatBar(-1, 10)).toBe('[--------]');
    expect(formatBar(Number.NaN, 10)).toBe('[--------]');
  });
});

describe('formatTimestamp', () => {
  it('renders local time padded to a sortable shape', () => {
    // Constructed from local components, so the assertion holds in every zone.
    const local = new Date(2026, 8, 29, 22, 37, 5).getTime();
    expect(formatTimestamp(local)).toBe('2026-09-29 22:37');
  });

  it('reports a non-finite timestamp as n/a', () => {
    expect(formatTimestamp(Number.NaN)).toBe('n/a');
  });
});

/**
 * Display-width accounting.
 *
 * I. Why this is its own block
 *
 * 1. Every column in the TUI is padded by hand, so a width helper that measures
 *    UTF-16 code units instead of terminal columns silently overflows the moment
 *    a label is Chinese — the content box grows past its frame and Ink truncates
 *    the right border away.
 * 2. These assertions are the guard against that regression: each one pins a
 *    cell that must come out exactly as wide as it was asked to be.
 */
describe('display width', () => {
  it('counts ASCII as one column per character', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('')).toBe(0);
    expect(displayWidth(' ')).toBe(1);
  });

  it('counts CJK ideographs as two columns', () => {
    expect(displayWidth('确认删除')).toBe(8);
    expect(displayWidth('依赖')).toBe(4);
    expect(displayWidth('构建产物')).toBe(8);
  });

  it('counts a fullwidth form as two columns', () => {
    expect(displayWidth('（')).toBe(2);
    expect(displayWidth('！')).toBe(2);
  });

  it('gives control characters and combining marks no width', () => {
    expect(displayWidth('a\tb')).toBe(2);
    expect(displayWidth('e\u0301')).toBe(1);
  });

  it('pads a CJK string to exactly the requested column count', () => {
    const out = pad('确认删除', 12);
    expect(displayWidth(out)).toBe(12);
    expect(out).toBe('确认删除    ');
  });

  it('pads a CJK string on the left for right alignment', () => {
    const out = pad('依赖', 10, 'right');
    expect(displayWidth(out)).toBe(10);
    expect(out.endsWith('依赖')).toBe(true);
  });

  it('truncates a CJK string without straddling a wide glyph', () => {
    const out = truncateToWidth('这是一个很长的中文标签', 8);
    expect(displayWidth(out)).toBeLessThanOrEqual(8);
    expect(out.endsWith('…')).toBe(true);
  });

  it('keeps a single column usable instead of dropping the ellipsis slot', () => {
    expect(displayWidth(truncateToWidth('abcdef', 1))).toBeLessThanOrEqual(1);
    expect(truncateToWidth('abcdef', 1)).toBe('a');
  });

  it('ellipsizes a CJK path within its column budget', () => {
    const out = ellipsizePath('/Users/dev/内容/项目/node_modules', 20);
    expect(displayWidth(out)).toBeLessThanOrEqual(20);
    expect(out.includes('node_modules')).toBe(true);
  });

  it('never exceeds the requested width for any of the padding helpers', () => {
    const samples = ['abc', '确认删除', '/Users/dev/内容/项目/dist', '！（全角）'];
    for (const sample of samples) {
      for (const width of [1, 2, 5, 12, 30]) {
        expect(displayWidth(pad(sample, width))).toBeLessThanOrEqual(width);
        expect(displayWidth(truncateToWidth(sample, width))).toBeLessThanOrEqual(width);
        expect(displayWidth(ellipsizePath(sample, width))).toBeLessThanOrEqual(width);
      }
    }
  });
});
