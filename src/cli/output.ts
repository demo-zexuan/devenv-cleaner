/**
 * JSON Output Renderers
 *
 * Stable, machine-readable output for the non-interactive commands.
 *
 * I. Why a dedicated module instead of `console.log(JSON.stringify(...))`
 *
 * 1. CI gates read this output. A stable key order and a stable sort make the
 *    text diffable between runs, which is what lets a pipeline comment on a pull
 *    request with "this branch adds 400 MB".
 * 2. Errors must be reported *in the same channel* as success so a consumer has
 *    one parser. A failure therefore emits `{ "ok": false, "error": ... }` on
 *    stdout rather than only printing to stderr.
 *
 * @module cli/output
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { formatBytes, formatSignedBytes } from '../core/format.js';
import type {
  CleanExecution,
  CleanPlan,
  CleanTarget,
  DoctorCheck,
  ReportDiff,
  ScanReport,
  TargetLayer,
} from '../core/index.js';

/** A successful envelope for a machine-readable command. */
export interface JsonOk<T> {
  readonly ok: true;
  readonly data: T;
}

/** A failed envelope for a machine-readable command. */
export interface JsonError {
  readonly ok: false;
  readonly error: string;
  /** Process exit code the CLI will use. */
  readonly code: number;
}

/** Emit one JSON document with a trailing newline. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Emit a failure envelope.
 *
 * @param message - Human-readable error.
 * @param code - Process exit code to end with.
 */
export function printJsonError(message: string, code: number): void {
  printJson({ ok: false, error: message, code } satisfies JsonError);
}

/**
 * Project a report onto a compact, CI-friendly summary.
 *
 * The full report is available through `dvc report export`; this is the shape a
 * pipeline wants for a gate, where a 20 MB document would be unusable.
 *
 * @param report - The scan report.
 * @param top - How many largest targets to include.
 * @returns A plain serializable object.
 */
export function reportToSummaryJson(report: ScanReport, top = 10): unknown {
  return {
    schemaVersion: report.schemaVersion,
    toolVersion: report.toolVersion,
    scannedAt: report.scannedAt,
    root: report.root,
    platform: report.platform,
    durationMs: report.durationMs,
    truncated: report.truncated,
    totals: {
      bytes: report.summary.totalBytes,
      reclaimableBytes: report.summary.reclaimableBytes,
      human: formatBytes(report.summary.totalBytes),
      reclaimableHuman: formatBytes(report.summary.reclaimableBytes),
      targets: report.summary.targetCount,
      locked: report.summary.lockedCount,
      files: report.summary.fileCount,
    },
    byLayer: report.summary.byLayer.map((layer) => ({
      layer: layer.layer,
      bytes: layer.bytes,
      reclaimableBytes: layer.reclaimableBytes,
      targets: layer.targetCount,
    })),
    byRule: report.summary.byRule.map((rule) => ({
      ruleId: rule.ruleId,
      label: rule.label,
      bytes: rule.bytes,
      reclaimableBytes: rule.reclaimableBytes,
      targets: rule.targetCount,
    })),
    byEcosystem: report.summary.byEcosystem,
    projects: report.projects.map((project) => ({
      path: project.path,
      name: project.name,
      ecosystems: project.ecosystems,
      bytes: project.bytes,
    })),
    topTargets: report.targets.slice(0, top).map((target) => ({
      id: target.id,
      path: target.path,
      ruleId: target.ruleId,
      layer: target.layer,
      bytes: target.bytes,
      ageDays: target.ageDays,
      locked: target.locked,
      lockedReason: target.lockedReason,
    })),
  };
}

/**
 * Render a plan as a machine-readable object.
 *
 * @param plan - The plan.
 * @returns A plain serializable object.
 */
export function planToJson(plan: CleanPlan): unknown {
  return {
    totalBytes: plan.totalBytes,
    totalHuman: formatBytes(plan.totalBytes),
    targetCount: plan.targets.length,
    skippedCount: plan.skipped.length,
    skipReasons: plan.skipReasons,
    targets: plan.targets.map((target) => ({
      id: target.id,
      path: target.path,
      ruleId: target.ruleId,
      layer: target.layer,
      risk: target.risk,
      bytes: target.bytes,
    })),
  };
}

/**
 * Render an execution as a machine-readable object.
 *
 * @param execution - The execution result.
 * @returns A plain serializable object.
 */
export function executionToJson(execution: CleanExecution): unknown {
  return {
    startedAt: execution.startedAt,
    durationMs: execution.durationMs,
    freedBytes: execution.freedBytes,
    freedHuman: formatBytes(execution.freedBytes),
    deleted: execution.deletedCount,
    skipped: execution.skippedCount,
    failed: execution.failedCount,
    results: execution.results.map((result) => ({
      targetId: result.targetId,
      path: result.path,
      outcome: result.outcome,
      freedBytes: result.freedBytes,
      durationMs: result.durationMs,
      error: result.error,
      skipReason: result.skipReason,
    })),
  };
}

/**
 * Render a diff as a machine-readable object.
 *
 * @param diff - The diff.
 * @param limit - Maximum number of entries to include.
 * @returns A plain serializable object.
 */
export function diffToJson(diff: ReportDiff, limit: number): unknown {
  return {
    from: { scannedAt: diff.from.scannedAt, totalBytes: diff.from.summary.totalBytes },
    to: { scannedAt: diff.to.scannedAt, totalBytes: diff.to.summary.totalBytes },
    deltaBytes: diff.deltaBytes,
    deltaHuman: formatSignedBytes(diff.deltaBytes),
    entries: diff.entries.slice(0, limit).map((entry) => ({
      path: entry.path,
      ruleId: entry.ruleId,
      change: entry.change,
      fromBytes: entry.fromBytes,
      toBytes: entry.toBytes,
      deltaBytes: entry.deltaBytes,
    })),
  };
}

/**
 * Render doctor checks as a machine-readable object.
 *
 * @param checks - The checks.
 * @returns A plain serializable object.
 */
export function doctorToJson(checks: readonly DoctorCheck[]): unknown {
  return {
    ok: checks.every((check) => check.status !== 'fail'),
    checks: checks.map((check) => ({
      name: check.name,
      status: check.status,
      detail: check.detail,
      hint: check.hint,
    })),
  };
}

/** One row in a rendered plain-text table. */
export type TableRow = readonly string[];

/**
 * Render a fixed-width text table without a dependency.
 *
 * I. Why hand-rolled
 *
 * 1. The table style is intentionally plain — aligned columns, no borders — so
 *    the output stays greppable and pipe-friendly, which no table library
 *    defaults to.
 * 2. Column alignment is derived from the rows, so callers do not repeat widths.
 *
 * @param header - Column headings.
 * @param rows - Body rows; cells may be shorter than their column.
 * @param aligns - Per-column alignment; defaults to left.
 * @returns The rendered table, without a trailing newline.
 */
export function renderTable(
  header: readonly string[],
  rows: readonly TableRow[],
  aligns: readonly ('left' | 'right')[] = [],
): string {
  const widths = header.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => (row[index] ?? '').length)),
  );

  const renderRow = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => {
        const width = widths[index] ?? cell.length;
        const align = aligns[index] ?? 'left';
        const value = cell ?? '';
        return align === 'right' ? value.padStart(width) : value.padEnd(width);
      })
      .join('  ')
      .trimEnd();

  const lines = [renderRow(header), widths.map((width) => '-'.repeat(width)).join('  ')];
  for (const row of rows) lines.push(renderRow(row));
  return lines.join('\n');
}

/** Convert a byte count into a right-aligned human cell. */
export function byteCell(bytes: number): string {
  return formatBytes(bytes);
}

/** Ordered layer labels, used when a command renders a layer column. */
export const LAYER_COLUMN_ORDER: readonly TargetLayer[] = ['dependencies', 'build', 'cache', 'artifacts'];

/** Narrow a target list to what a JSON consumer needs. */
export function targetsToJson(targets: readonly CleanTarget[]): unknown[] {
  return targets.map((target) => ({
    id: target.id,
    path: target.path,
    ruleId: target.ruleId,
    label: target.label,
    projectPath: target.projectPath,
    layer: target.layer,
    kind: target.kind,
    risk: target.risk,
    bytes: target.bytes,
    files: target.files,
    ageDays: target.ageDays,
    locked: target.locked,
    lockedReason: target.lockedReason,
  }));
}
