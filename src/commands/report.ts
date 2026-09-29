/**
 * Report Command
 *
 * List, export and compare persisted scan reports.
 *
 * I. Why snapshots are the feature and export is only plumbing
 *
 * 1. A single scan answers "where did my disk go". Only a *comparison* answers
 *    "what grew since last week", which is the question that predicts a full
 *    disk instead of explaining one.
 * 2. Reports are therefore the durable artifact: a JSON contract with a schema
 *    version, written to a predictable directory, diffable by path.
 *
 * @module commands/report
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import pc from 'picocolors';
import { diffToJson, printJson } from '../cli/output.js';
import {
  formatBytes,
  formatSignedBytes,
  type ReportDiff,
  type ResolvedConfig,
  type ScanReport,
  scan,
} from '../core/index.js';
import { diffReports, formatDiffSummary } from '../report/diff.js';
import { readReportJson, writeReportJson } from '../report/json.js';
import { reportToMarkdown } from '../report/markdown.js';

/** One persisted report on disk. */
export interface StoredReport {
  /** Absolute path of the file. */
  readonly path: string;
  /** File size in bytes. */
  readonly bytes: number;
  /** Last modification time in epoch milliseconds. */
  readonly mtimeMs: number;
}

/**
 * List the reports in a directory, newest first.
 *
 * @param directory - Directory to scan for `.json` report files.
 * @returns The reports found.
 */
export async function listStoredReports(directory: string): Promise<StoredReport[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    // A missing report directory simply means nothing has been exported yet.
    return [];
  }

  const stored: StoredReport[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const info = await stat(join(directory, name));
      if (!info.isFile()) continue;
      stored.push({ path: join(directory, name), bytes: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // A file that vanished mid-listing is not an error worth reporting.
    }
  }
  return stored.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

/**
 * Run a scan and persist it, returning both the report and the written path.
 *
 * @param options - Export options.
 * @returns The written path and the report.
 */
export async function exportReport(options: {
  /** Scan roots. */
  readonly roots: readonly string[];
  /** Resolved config. */
  readonly config: ResolvedConfig;
  /** Directory reports are written to. */
  readonly directory: string;
  /** Explicit output path, overriding the generated name. */
  readonly out?: string | undefined;
  /** Output format. */
  readonly format: 'json' | 'markdown';
  /** Also probe global caches. */
  readonly includeGlobal: boolean;
}): Promise<{ path: string; report: ScanReport }> {
  const report = await scan({
    roots: options.roots,
    config: options.config,
    includeGlobalTargets: options.includeGlobal,
  });

  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true });

  const stamp = report.scannedAt.replace(/[:.]/g, '-');
  const extension = options.format === 'markdown' ? 'md' : 'json';
  const target = options.out ?? join(directory, `scan-${stamp}.${extension}`);

  if (options.format === 'markdown') {
    await writeFile(target, reportToMarkdown(report), 'utf8');
  } else {
    await writeReportJson(report, target);
  }
  return { path: target, report };
}

/**
 * Compare two persisted reports.
 *
 * @param options - Diff options.
 * @returns The diff.
 * @throws Error when either file cannot be read or fails validation.
 */
export async function compareReports(options: {
  /** Path of the older report. */
  readonly from: string;
  /** Path of the newer report. */
  readonly to: string;
}): Promise<ReportDiff> {
  const from = await readReportJson(options.from);
  if (!from.ok) throw new Error(`cannot read ${options.from}: ${from.error}`);

  const to = await readReportJson(options.to);
  if (!to.ok) throw new Error(`cannot read ${options.to}: ${to.error}`);

  return diffReports(from.report, to.report);
}

/**
 * Print a report listing or a diff.
 *
 * @param options - Command options.
 * @returns 0 normally, or 2 when a growth gate is breached and `failOnGrowth`
 *   is set — a distinct code so CI can tell "policy refused" from "tool broke".
 */
export async function runReport(options: {
  /** Sub-action. */
  readonly action: 'list' | 'diff';
  /** Report directory, for `list`. */
  readonly directory: string;
  /** Older report path, for `diff`. */
  readonly from?: string | undefined;
  /** Newer report path, for `diff`. */
  readonly to?: string | undefined;
  /** Emit JSON. */
  readonly json: boolean;
  /** Suppress colour. */
  readonly noColor: boolean;
  /** Exit 2 when the net delta exceeds this many bytes. */
  readonly failOnGrowth?: number | undefined;
  /** Cap on diff rows printed. */
  readonly limit: number;
}): Promise<number> {
  if (options.action === 'list') {
    const stored = await listStoredReports(resolve(options.directory));
    if (options.json) {
      printJson({ ok: true, data: { directory: resolve(options.directory), reports: stored } });
      return 0;
    }
    const dim = options.noColor ? (value: string): string => value : pc.dim;
    process.stdout.write(`${dim(resolve(options.directory))}\n`);
    if (stored.length === 0) {
      process.stdout.write(`no reports yet; create one with "dvc report export"\n`);
      return 0;
    }
    for (const entry of stored) {
      process.stdout.write(
        `  ${new Date(entry.mtimeMs).toISOString()}  ${formatBytes(entry.bytes).padStart(8)}  ${entry.path}\n`,
      );
    }
    return 0;
  }

  // I. `diff` requires both sides; a missing argument is a usage error, not a
  //    silent empty diff, because "no growth" and "no comparison" are different
  //    answers and a CI gate must not confuse them.
  if (!options.from || !options.to) {
    process.stderr.write(`dvc report diff requires both --from and --to\n`);
    return 1;
  }

  const diff = await compareReports({ from: options.from, to: options.to });

  if (options.json) {
    printJson({ ok: true, data: diffToJson(diff, options.limit) });
  } else {
    printDiff(diff, options);
  }

  if (options.failOnGrowth !== undefined && diff.deltaBytes > options.failOnGrowth) {
    if (!options.json) {
      process.stderr.write(
        `\n${options.noColor ? '' : pc.red('growth gate failed')}: ` +
          `${formatSignedBytes(diff.deltaBytes)} exceeds the limit of ${formatBytes(options.failOnGrowth)}\n`,
      );
    }
    return 2;
  }
  return 0;
}

/**
 * Render a diff for humans.
 *
 * @param diff - The diff.
 * @param options - Command options.
 */
function printDiff(diff: ReportDiff, options: { noColor: boolean; limit: number }): void {
  const bold = options.noColor ? (value: string): string => value : pc.bold;
  const dim = options.noColor ? (value: string): string => value : pc.dim;
  const red = options.noColor ? (value: string): string => value : pc.red;
  const green = options.noColor ? (value: string): string => value : pc.green;

  const out = process.stdout;
  out.write(`\n${bold('disk usage change')}\n\n`);
  out.write(`  from  ${diff.from.scannedAt}  ${formatBytes(diff.from.summary.totalBytes)}\n`);
  out.write(`  to    ${diff.to.scannedAt}  ${formatBytes(diff.to.summary.totalBytes)}\n`);

  const tone = diff.deltaBytes > 0 ? red : diff.deltaBytes < 0 ? green : dim;
  out.write(`  net   ${tone(formatSignedBytes(diff.deltaBytes))}\n\n`);
  out.write(`${dim(formatDiffSummary(diff))}\n\n`);

  if (diff.entries.length === 0) {
    out.write(`${dim('no individual path changed size between the two scans')}\n`);
    return;
  }

  const width = Math.max(...diff.entries.slice(0, options.limit).map((entry) => entry.path.length), 20);
  for (const entry of diff.entries.slice(0, options.limit)) {
    const delta = formatSignedBytes(entry.deltaBytes);
    // Grown paths are the actionable ones, so they get the alarm colour; a
    // shrink is good news and is coloured as such.
    const deltaTone = entry.deltaBytes > 0 ? red : entry.deltaBytes < 0 ? green : dim;
    out.write(`  ${deltaTone(delta.padStart(10))}  ${entry.change.padEnd(8)}  ${entry.path.padEnd(width)}\n`);
  }
  if (diff.entries.length > options.limit) {
    out.write(`${dim(`  … ${diff.entries.length - options.limit} more`)}\n`);
  }
  out.write('\n');
}
