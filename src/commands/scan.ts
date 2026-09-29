/**
 * Scan Command
 *
 * Non-interactive disk scan with human, JSON and Markdown output.
 *
 * I. Why this command matters beyond the TUI
 *
 * 1. It is the only way DevEnvClean can be used in CI, where there is no TTY
 *    and a human is not present to press space.
 * 2. It produces the report files that `dvc report diff` compares, so the
 *    growth gate depends on it working without the TUI ever loading.
 *
 * @module commands/scan
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { writeFile } from 'node:fs/promises';
import pc from 'picocolors';
import { renderTable } from '../cli/output.js';
import type { ScanProgress, ScanReport } from '../core/index.js';
import { formatBytes, formatDuration, scan, scanId } from '../core/index.js';
import { reportToJson, writeReportJson } from '../report/json.js';
import { reportToMarkdown } from '../report/markdown.js';

/** Options accepted by {@link runScan}. */
export interface ScanCommandOptions {
  /** Resolved scan roots; defaults to the home directory. */
  readonly roots: readonly string[];
  /** Depth limit passed to the scanner. */
  readonly maxDepth: number;
  /** Minimum target size in bytes. */
  readonly minSizeBytes: number;
  /** Emit JSON instead of a table. */
  readonly json: boolean;
  /** Write a report file to this path. */
  readonly out?: string | undefined;
  /** Write the report in this format; inferred from `out` when omitted. */
  readonly format?: 'json' | 'markdown' | undefined;
  /** Also probe machine-global package-manager caches. */
  readonly includeGlobal: boolean;
  /** Suppress colour. */
  readonly noColor: boolean;
  /** Print progress lines; off for JSON and CI. */
  readonly quiet: boolean;
  /** Resolved configuration from the config layer. */
  readonly config: import('../core/index.js').ResolvedConfig;
  /** Called with each progress sample. */
  readonly onProgress?: (progress: ScanProgress) => void;
}

/** Width of the transient progress line, in characters. */
const PROGRESS_LINE_WIDTH = 72;

/**
 * Erase the transient progress line.
 *
 * I. Why the order matters
 *
 * 1. A carriage return alone only moves the cursor; it does not erase. The line
 *    must be overwritten with spaces *after* returning to column zero, then the
 *    cursor returned again so whatever prints next starts clean.
 * 2. `'\r'.padEnd(n)` looks like it pads the line but actually pads the bare
 *    carriage return, appending spaces after it — which clears nothing.
 */
function clearProgressLine(): void {
  process.stderr.write(`\r${' '.repeat(PROGRESS_LINE_WIDTH)}\r`);
}

/**
 * Run a scan and print or persist its result.
 *
 * @param options - Command options.
 * @returns The report, so the caller can decide the exit code.
 */
export async function runScan(options: ScanCommandOptions): Promise<ScanReport> {
  const started = Date.now();
  let lastRender = 0;

  const report = await scan({
    roots: options.roots,
    config: options.config,
    includeGlobalTargets: options.includeGlobal,
    onProgress: (progress) => {
      options.onProgress?.(progress);
      if (options.quiet || options.json) return;
      // Throttle to ~10 fps: repainting a terminal faster than a human can read
      // wastes CPU that the scan itself needs.
      const now = Date.now();
      if (now - lastRender < 100) return;
      lastRender = now;
      const line =
        `\r${pc.dim('scanning')} ${progress.directoriesVisited} dirs · ` +
        `${progress.targetsFound} targets · ${formatBytes(progress.bytesFound)}`;
      process.stderr.write(line.padEnd(PROGRESS_LINE_WIDTH + 1).slice(0, PROGRESS_LINE_WIDTH + 1));
    },
  });

  if (!options.quiet && !options.json) clearProgressLine();

  if (options.out) {
    await writeReport(report, options.out, options.format ?? inferFormat(options.out));
    if (!options.json) process.stdout.write(`${pc.green('report written')} ${options.out}\n`);
  }

  if (options.json) {
    process.stdout.write(`${reportToJson(report)}\n`);
  } else if (!options.quiet) {
    printReport(report, options.noColor, Date.now() - started);
  }

  return report;
}

/**
 * Infer the report format from a file extension.
 *
 * @param outPath - Output path.
 * @returns `markdown` for `.md`, otherwise `json`.
 */
function inferFormat(outPath: string): 'json' | 'markdown' {
  return outPath.endsWith('.md') ? 'markdown' : 'json';
}

/**
 * Persist a report in the requested format.
 *
 * @param report - The report.
 * @param outPath - Destination path.
 * @param format - Output format.
 */
async function writeReport(report: ScanReport, outPath: string, format: 'json' | 'markdown'): Promise<void> {
  if (format === 'markdown') {
    const markdown = reportToMarkdown(report);
    await writeFile(outPath, markdown, 'utf8');
    return;
  }
  await writeReportJson(report, outPath);
}

/**
 * Render a human-readable scan result.
 *
 * @param report - The report.
 * @param noColor - Suppress colour.
 * @param wallMs - Wall-clock time including startup, which a user perceives as
 *   the real duration rather than the scanner's internal timer.
 */
function printReport(report: ScanReport, noColor: boolean, wallMs: number): void {
  const dim = noColor ? (value: string): string => value : pc.dim;
  const bold = noColor ? (value: string): string => value : pc.bold;
  const green = noColor ? (value: string): string => value : pc.green;
  const yellow = noColor ? (value: string): string => value : pc.yellow;

  const out = process.stdout;
  out.write(`${bold('DevEnvClean scan')} ${dim(`v${report.toolVersion}`)}\n`);
  out.write(`${dim('root')} ${report.root}\n`);
  out.write(
    `${dim('scanned')} ${report.directoriesVisited} directories in ${formatDuration(report.durationMs)} ` +
      `(${formatDuration(wallMs)} wall)\n`,
  );
  if (report.truncated) {
    out.write(`${yellow('warning')} directory ceiling reached; totals are a lower bound\n`);
  }
  if (report.skippedDirectories > 0) {
    out.write(`${dim('skipped')} ${report.skippedDirectories} unreadable directories\n`);
  }
  out.write('\n');

  out.write(`${bold('total')}        ${formatBytes(report.summary.totalBytes)}\n`);
  out.write(`${bold('reclaimable')}  ${green(formatBytes(report.summary.reclaimableBytes))}\n`);
  out.write(
    `${dim('targets')}      ${report.summary.targetCount} (${report.summary.lockedCount} locked) · ` +
      `${report.summary.fileCount.toLocaleString('en-US')} files\n`,
  );
  // The active guards are printed because a target that is absent and a target
  // that is locked both look like "nothing here" without them, and the user
  // cannot tell a small directory from a missing rule.
  out.write(
    `${dim('guards')}       min size ${formatBytes(report.config.minSizeBytes)} · ` +
      `depth ${report.config.maxDepth}\n\n`,
  );

  if (report.targets.length === 0) {
    out.write(`${dim('no cleanup targets found under this root')}\n`);
    return;
  }

  out.write(`${bold('by layer')}\n`);
  out.write(
    `${renderTable(
      ['layer', 'size', 'reclaimable', 'targets'],
      report.summary.byLayer.map((layer) => [
        layer.layer,
        formatBytes(layer.bytes),
        formatBytes(layer.reclaimableBytes),
        String(layer.targetCount),
      ]),
      ['left', 'right', 'right', 'right'],
    )}\n\n`,
  );

  out.write(`${bold('largest targets')}\n`);
  const top = report.targets.slice(0, 15);
  out.write(
    `${renderTable(
      ['size', 'layer', 'rule', 'age', 'status', 'path'],
      top.map((target) => [
        formatBytes(target.bytes),
        target.layer,
        target.label,
        `${Math.round(target.ageDays)}d`,
        target.locked ? `locked:${target.lockedReason ?? 'yes'}` : 'ready',
        target.path,
      ]),
      ['right', 'left', 'left', 'right', 'left', 'left'],
    )}\n`,
  );

  if (report.targets.length > top.length) {
    out.write(`${dim(`… ${report.targets.length - top.length} more; use --json or export a report`)}\n`);
  }
  out.write('\n');
  out.write(`${dim('next')} dvc clean --dry-run   ${dim('review before deleting')}\n`);
}

/** Suggested report filename for a scan, used by the TUI's export action. */
export function suggestedReportName(report: ScanReport): string {
  const stamp = report.scannedAt.replace(/[:.]/g, '-');
  return `scan-${stamp}-${scanId(report.root, report.scannedAt)}.json`;
}

/** Re-exported so the TUI can persist a report without importing Node fs. */
export { reportToJson };
