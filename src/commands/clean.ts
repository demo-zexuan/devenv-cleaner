/**
 * Clean Command
 *
 * Turns a scan into a reviewed plan and, when the user is explicit about it,
 * executes it. This is the non-interactive counterpart to the TUI's
 * select → preview → confirm flow.
 *
 * I. Why the CLI path is defined in terms of the same three steps
 *
 * 1. The TUI is a convenience over a protocol, not the protocol itself. Making
 *    the CLI express the identical plan-then-execute contract is what guarantees
 *    the two front-ends cannot diverge in safety behaviour.
 * 2. `--dry-run` is therefore not a debugging aid bolted on; it is the default
 *    expression of step two, and a real deletion requires the user to say
 *    `--yes`.
 *
 * @module commands/clean
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import pc from 'picocolors';
import { executionToJson, planToJson, printJson } from '../cli/output.js';
import {
  buildPlan,
  type CleanExecutionReport,
  type CleanPlan,
  executePlan,
  formatBytes,
  formatDuration,
  formatPlanPreview,
  type PlanResult,
  type ResolvedConfig,
  type ScanReport,
  scan,
  type TargetLayer,
} from '../core/index.js';

/** Options accepted by {@link runClean}. */
export interface CleanCommandOptions {
  /** Resolved scan roots. */
  readonly roots: readonly string[];
  /** Resolved configuration. */
  readonly config: ResolvedConfig;
  /** Explicit target ids to act on. */
  readonly selectedIds?: readonly string[] | undefined;
  /** Restrict to these layers. */
  readonly layers?: readonly TargetLayer[] | undefined;
  /** Restrict to these rule ids. */
  readonly ruleIds?: readonly string[] | undefined;
  /** Only targets at least this large. */
  readonly minBytes?: number | undefined;
  /** Only targets at least this old. */
  readonly olderThanDays?: number | undefined;
  /** Only targets whose path contains this substring. */
  readonly pathContains?: string | undefined;
  /** Consider locked targets where the lock is overridable. */
  readonly includeLocked: boolean;
  /** Actually delete. Without it the command only previews. */
  readonly yes: boolean;
  /** Preview only; this is the default and is stated explicitly for clarity. */
  readonly dryRun: boolean;
  /** Ask the scanner to also probe machine-global caches. */
  readonly includeGlobal: boolean;
  /** Emit JSON. */
  readonly json: boolean;
  /** Suppress colour. */
  readonly noColor: boolean;
  /** Terminal width used to lay out the preview table. */
  readonly width: number;
}

/** Outcome of a clean run, so the caller can choose an exit code. */
export interface CleanCommandResult {
  /** The report the plan was derived from. */
  readonly report: ScanReport;
  /** The plan that was (or would be) executed. */
  readonly plan: PlanResult;
  /** Present only when a deletion actually ran. */
  readonly execution: CleanExecutionReport | null;
}

/**
 * Scan, plan, preview and optionally execute a cleanup.
 *
 * I. Order of operations
 *
 * 1. Scan always. Deriving a plan from a stale report file would let a user
 *    delete a directory that no longer matches what they reviewed.
 * 2. Plan and preview unconditionally, even under `--yes`, so the run is
 *    self-documenting in a log.
 * 3. Execute only when `--yes` is present *and* `--dry-run` is absent.
 *
 * @param options - Command options.
 * @returns The report, plan and execution (when one happened).
 */
export async function runClean(options: CleanCommandOptions): Promise<CleanCommandResult> {
  const report = await scan({
    roots: options.roots,
    config: options.config,
    includeGlobalTargets: options.includeGlobal,
  });

  const plan = buildPlan({
    report,
    config: options.config,
    ...(options.selectedIds ? { selectedIds: options.selectedIds } : {}),
    ...(options.layers ? { layers: options.layers } : {}),
    ...(options.ruleIds ? { ruleIds: options.ruleIds } : {}),
    ...(options.minBytes !== undefined ? { minBytes: options.minBytes } : {}),
    ...(options.olderThanDays !== undefined ? { olderThanDays: options.olderThanDays } : {}),
    ...(options.pathContains ? { pathContains: options.pathContains } : {}),
    includeLocked: options.includeLocked,
  });

  // I. A plan that selects nothing must not silently succeed as a no-op: the
  //    user asked for a deletion and got none, which is the most confusing
  //    possible outcome. The unknown ids are surfaced so a typo is visible.
  if (plan.targets.length === 0) {
    if (options.json) {
      printJson({ ok: true, data: { plan: planToJson(plan), execution: null, note: 'nothing selected' } });
    } else {
      process.stdout.write(`\n${describeEmptyPlan(plan, options.noColor)}\n`);
    }
    return { report, plan, execution: null };
  }

  if (options.json) {
    // JSON mode reports the plan first so a pipeline can inspect it before a
    // later invocation performs the deletion.
    const execution = shouldExecute(options)
      ? await executePlan({ plan, config: options.config, dryRun: false })
      : null;
    printJson({
      ok: true,
      data: { plan: planToJson(plan), execution: execution ? executionToJson(execution) : null },
    });
    return { report, plan, execution };
  }

  printPreview(plan, options);

  if (!shouldExecute(options)) {
    process.stdout.write(
      `\n${options.noColor ? '' : pc.yellow('preview only')} — nothing was deleted. ` +
        `Re-run with --yes to delete the ${plan.targets.length} target(s) above.\n`,
    );
    return { report, plan, execution: null };
  }

  process.stdout.write(`\ndeleting ${plan.targets.length} target(s)…\n`);
  const execution = await executePlan({ plan, config: options.config, dryRun: false });
  printExecution(execution, options.noColor);
  return { report, plan, execution };
}

/**
 * Decide whether a real deletion is permitted.
 *
 * I. Both conditions are required
 *
 * 1. `--yes` is the explicit intent.
 * 2. The absence of `--dry-run` is the absence of an explicit *veto*. A caller
 *    that writes both flags is asking for a preview, and the veto wins because
 *    the conservative reading of an ambiguous destructive request is correct.
 *
 * @param options - Command options.
 * @returns True when the plan should be executed for real.
 */
function shouldExecute(options: CleanCommandOptions): boolean {
  return options.yes && !options.dryRun;
}

/**
 * Explain why a plan came out empty.
 *
 * @param plan - The empty plan.
 * @param noColor - Suppress colour.
 * @returns A multi-line explanation.
 */
function describeEmptyPlan(plan: PlanResult, noColor: boolean): string {
  const dim = noColor ? (value: string): string => value : pc.dim;
  const lines = ['nothing to clean: no target matched the current selection'];

  if (plan.unknownIds.length > 0) {
    lines.push(`${dim('unknown target ids:')} ${plan.unknownIds.slice(0, 10).join(', ')}`);
    lines.push(`${dim('target ids change between runs; re-run "dvc scan" and copy an id from the output')}`);
  }
  if (plan.skipped.length > 0) {
    lines.push(`${dim(`${plan.skipped.length} target(s) matched but are locked:`)}`);
    for (const reason of plan.skipReasons.slice(0, 5)) lines.push(`  ${dim('·')} ${reason}`);
    lines.push(`${dim('pass --include-locked to reconsider locks that are overridable')}`);
  }
  return lines.join('\n');
}

/**
 * Print the plan preview table.
 *
 * I. Why there is no summary line here
 *
 * 1. `formatPlanPreview` already ends with the totals row, so printing
 *    `summarizePlan` underneath repeated the same sentence verbatim — the kind
 *    of duplication that makes a user wonder whether two different numbers are
 *    being reported.
 *
 * @param plan - The plan.
 * @param options - Command options.
 */
function printPreview(plan: CleanPlan, options: CleanCommandOptions): void {
  const bold = options.noColor ? (value: string): string => value : pc.bold;

  process.stdout.write(
    `\n${bold('cleanup preview')} ${formatBytes(plan.totalBytes)} across ${plan.targets.length} target(s)\n\n`,
  );
  process.stdout.write(`${formatPlanPreview(plan, { width: options.width, maxRows: 0 })}\n`);
}

/**
 * Print the execution outcome.
 *
 * @param execution - The execution record.
 * @param noColor - Suppress colour.
 */
function printExecution(execution: CleanExecutionReport, noColor: boolean): void {
  const green = noColor ? (value: string): string => value : pc.green;
  const red = noColor ? (value: string): string => value : pc.red;
  const dim = noColor ? (value: string): string => value : pc.dim;

  process.stdout.write(`\n${green('freed')} ${formatBytes(execution.freedBytes)}\n`);
  process.stdout.write(
    `${execution.deletedCount} deleted · ${execution.skippedCount} skipped · ` +
      `${execution.failedCount} failed · ${formatDuration(execution.durationMs)}\n`,
  );

  if (execution.failedCount > 0) {
    process.stdout.write(`\n${red('failures')}\n`);
    for (const result of execution.results.filter((entry) => entry.outcome === 'failed').slice(0, 20)) {
      process.stdout.write(`  ${result.path}\n    ${dim(result.error ?? 'unknown error')}\n`);
    }
  }
  if (execution.driftedTargetIds.length > 0) {
    process.stdout.write(
      `\n${dim(`${execution.driftedTargetIds.length} target(s) changed size between the preview and the run;`)}\n` +
        `${dim('the freed total reflects the fresh measurement, not the plan estimate')}\n`,
    );
  }
}

/**
 * Choose the process exit code for a clean run.
 *
 * @param result - The command result.
 * @returns 0 on success, 1 when any target failed to delete.
 */
export function cleanExitCode(result: CleanCommandResult): number {
  if (!result.execution) return 0;
  return result.execution.failedCount > 0 ? 1 : 0;
}
