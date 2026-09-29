/**
 * TUI Scan Progress View
 *
 * The live screen shown while the scanner walks the filesystem: which phase is
 * running, how much has been seen, and which directory is being measured.
 *
 * I. The activity indicator is derived, never timed
 *
 * 1. This component owns no state and no timer. The glyph advances because the
 *    *numbers the container passes* advance, which is a property no test can
 *    flake on: pass the same props twice and the frame is byte-identical.
 * 2. It follows that the indicator is honest in the only sense that matters —
 *    it moves when the scan moves and freezes when the scan stalls, so it can
 *    never animate a wedged process into looking healthy.
 *
 * II. The progress bar is an asymptotic estimate
 *
 * 1. The scanner cannot know how many directories exist until it has walked
 *    them, so a true percentage does not exist during the first two phases. The
 *    bar therefore creeps from the phase's floor toward its ceiling as the
 *    observed counters grow, and only the finalizing phase lands near full.
 * 2. No percentage is printed next to the bar for exactly that reason: a number
 *    would claim a precision the process does not have. The bar communicates
 *    "still moving, and how far this phase typically gets", nothing more.
 *
 * @module tui/components/ProgressView
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { ellipsizePath, formatBar, formatBytes, formatCount } from '../../core/format.js';
import type { ScanProgress } from '../../core/types.js';
import { type Theme, textStyle } from '../theme.js';

/** Props accepted by {@link ProgressView}. */
export interface ProgressViewProps {
  /** Phase the scanner is currently in. */
  readonly phase: ScanProgress['phase'];
  /** Localised phase name, e.g. "Measuring directories". */
  readonly phaseLabel: string;
  /** Directories visited so far. */
  readonly directoriesVisited: number;
  /** Targets discovered so far. */
  readonly targetsFound: number;
  /** Bytes measured so far. */
  readonly bytesFound: number;
  /** Directory being walked right now, for the live label. */
  readonly currentPath: string;
  /** Height of the panel, borders included. */
  readonly height: number;
  /** Total terminal width in columns. */
  readonly width: number;
  /** Active theme. */
  readonly theme: Theme;
  /** Localised labels for the counter row and the activity indicator. */
  readonly labels: { readonly dirs: string; readonly targets: string; readonly scanning: string };
}

/**
 * Activity glyphs, cycled by observed progress.
 *
 * ASCII only: a spinner made of ambiguous-width glyphs would shift the text
 * after it on terminals that measure those glyphs as two columns.
 */
const SPINNER: readonly string[] = ['|', '/', '-', '\\'];

/** Floor and ceiling of the estimated bar, per phase. */
const PHASE_BAR: Readonly<Record<ScanProgress['phase'], { readonly base: number; readonly span: number }>> = {
  discovering: { base: 0.02, span: 0.3 },
  measuring: { base: 0.32, span: 0.55 },
  finalizing: { base: 0.88, span: 0.1 },
};

/**
 * Counter at which the creep has covered about half of its phase span.
 *
 * Chosen so that a scan of a large home directory visibly advances within the
 * first second and has visibly slowed by the time it reaches tens of thousands
 * of directories — the shape of real scanning work.
 */
const CREEP_HALF_LIFE = 1500;

/**
 * Append a value to a label without doubling a separator.
 *
 * The container supplies the label, and the localisation tables spell some of
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
 * Render the scan progress screen.
 *
 * I. Layout
 *
 * 1. Rows are emitted in descending importance — phase, counters, bar, path —
 *    and the panel clips from the bottom, so a short terminal loses the current
 *    path first and the bar last.
 * 2. The counter pair shares one row from 44 columns of content, which is the
 *    width at which both values plus their labels fit with a real gutter.
 */
export function ProgressView({
  phase,
  phaseLabel,
  directoriesVisited,
  targetsFound,
  bytesFound,
  currentPath,
  height,
  width,
  theme,
  labels,
}: ProgressViewProps): ReactNode {
  const frameHeight = Math.max(0, Math.floor(height));
  if (frameHeight < 3) return null;

  const inner = Math.max(4, width - 4);
  const started = phaseBarRatio(phase, directoriesVisited + targetsFound);
  const spinner = SPINNER[Math.abs(directoriesVisited + targetsFound) % SPINNER.length] ?? '|';
  const activity = `${labels.scanning} ${spinner}`;
  const wideCounters = inner >= 44;
  const barWidth = Math.max(8, Math.min(inner, 40));

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
        {/* II. Which phase, and the derived activity glyph. */}
        <Box flexDirection="row" width={inner} justifyContent="space-between">
          <Text {...textStyle(theme, theme.colors.primary, { bold: true })} wrap="truncate-end">
            {phaseLabel}
          </Text>
          <Text {...textStyle(theme, theme.colors.muted)} wrap="truncate-end">
            {wideCounters ? activity : spinner}
          </Text>
        </Box>

        {/* III. Counters: one row when they fit side by side, otherwise two. */}
        {wideCounters ? (
          <Box flexDirection="row" width={inner} justifyContent="space-between">
            <Text {...textStyle(theme, theme.colors.muted)} wrap="truncate-end">
              {withValue(labels.dirs, formatCount(directoriesVisited))}
            </Text>
            <Text {...textStyle(theme, theme.colors.muted)} wrap="truncate-end">
              {withValue(labels.targets, `${formatCount(targetsFound)} (${formatBytes(bytesFound)})`)}
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column" width={inner}>
            <Text {...textStyle(theme, theme.colors.muted)} wrap="truncate-end">
              {withValue(labels.dirs, formatCount(directoriesVisited))}
            </Text>
            <Text {...textStyle(theme, theme.colors.muted)} wrap="truncate-end">
              {withValue(labels.targets, `${formatCount(targetsFound)} (${formatBytes(bytesFound)})`)}
            </Text>
          </Box>
        )}

        {/* IV. Estimated phase progress, no percentage. */}
        <Box>
          <Text {...textStyle(theme, theme.colors.success)} wrap="truncate-end">
            {formatBar(started, barWidth)}
          </Text>
        </Box>

        {/* V. The live path: the first thing a short terminal gives up. */}
        <Box>
          <Text {...textStyle(theme, theme.colors.dim, { dim: true })} wrap="truncate-end">
            {ellipsizePath(currentPath, inner)}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Estimate how far the current phase has crept.
 *
 * I. Shape
 *
 * 1. The curve is `base + span * (1 - 1 / (1 + n / halfLife))`: it starts at the
 *    phase floor, rises with every directory and target the scanner reports, and
 *    approaches the ceiling without ever reaching it. A scan that never finishes
 *    therefore never looks finished.
 *
 * @param phase - Current scan phase.
 * @param signal - Directories visited plus targets found.
 * @returns A ratio in `[0, 1)` for {@link formatBar}.
 */
function phaseBarRatio(phase: ScanProgress['phase'], signal: number): number {
  const { base, span } = PHASE_BAR[phase];
  const observed = Math.max(0, signal);
  const creep = 1 - 1 / (1 + observed / CREEP_HALF_LIFE);
  return Math.min(0.99, base + span * creep);
}
