/**
 * Plan Executor
 *
 * Executes a {@link CleanPlan} one target at a time, re-verifying every safety
 * condition immediately before each unlink and recording the outcome of each
 * attempt independently.
 *
 * I. Why the executor accepts only a `CleanPlan`
 *
 * 1. A `CleanPlan` can only be produced by `core/planner.ts`, which is the only
 *    module that knows the lock rules. Accepting a report, a path list or a
 *    predicate here would create a second, unchecked way to reach `fs.rm`, and
 *    the confirmation gate in `commands/clean.ts` would become advisory.
 * 2. The executor therefore never re-derives targets. It walks `plan.targets`,
 *    in the order the planner produced them, and nothing else.
 *
 * II. Why every check is repeated here even though the planner ran them
 *
 * 1. The planner is pure and runs against a *report*, which describes the
 *    filesystem as it was when the scan finished. The delete happens later, and
 *    the filesystem is shared: another process can replace a directory with a
 *    symlink, drop a new project in the whitelist, or change the config on disk.
 * 2. The re-check is the last moment at which the tool can notice that, so it
 *    recomputes everything from scratch — including `realpath` — instead of
 *    trusting a value computed minutes earlier.
 * 3. Every failure is recorded, never thrown. One unwritable target must not
 *    abort a batch, and it must not leave `CleanExecution` unable to say what
 *    happened (FR-43, NFR-7, NFR-8).
 *
 * @module core/executor
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { realpath, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { isWhitelisted } from '../rules/engine.js';
import { formatBytes, formatDuration } from './format.js';
import { isDirectory, measureDirectory } from './measure.js';
import { findContainingRoot, isProtectedResolvedPath, normalizeForCompare } from './platform.js';
import type { CleanExecution, CleanOptions, CleanResult, CleanTarget, ResolvedConfig } from './types.js';

/** Options accepted by {@link executePlan}; identical to {@link CleanOptions}. */
export interface ExecuteOptions extends CleanOptions {}

/**
 * A `CleanExecution` plus the size-drift evidence behind its numbers.
 *
 * I. Why this is additive rather than a change to `CleanExecution`
 *
 * 1. `CleanExecution` is the contract the reporters and the TUI compile
 *    against; adding a required field would break every constructor of it.
 * 2. `CleanExecutionReport` is a structural superset, so a caller that only
 *    needs `CleanExecution` can ignore this type entirely. Only a caller that
 *    wants to explain a surprising `freedBytes` needs to name it.
 */
export interface CleanExecutionReport extends CleanExecution {
  /**
   * Ids of targets whose pre-delete measurement differed from the plan by more
   * than {@link SIZE_DRIFT_TOLERANCE}.
   *
   * The deletion still happened — the user confirmed a path, not a byte count —
   * but the caller can now say "four targets changed size between the preview
   * and the run" instead of leaving the user to wonder why the freed total
   * differs from the plan's.
   */
  readonly driftedTargetIds: readonly string[];
}

/**
 * Relative size change above which a plan's byte claim is treated as stale.
 *
 * I. Why a tolerance exists at all
 *
 * 1. A build writing into `dist` while the preview is on screen will always
 *    move the number a little; without a tolerance every run would look
 *    anomalous and the signal would be worthless.
 * 2. Twenty percent is wide enough to absorb that noise and narrow enough to
 *    catch a directory that was purged or replaced, which is the case the user
 *    actually needs told about.
 */
const SIZE_DRIFT_TOLERANCE = 0.2;

/** `fs.rm` retry policy: transient sharing violations on Windows resolve. */
const REMOVE_OPTIONS = { recursive: true, force: false, maxRetries: 3, retryDelay: 200 } as const;

/** A deletion attempt's result plus the drift evidence for it. */
interface DeleteOutcome {
  /** The per-target record. */
  readonly result: CleanResult;
  /** True when the fresh measurement drifted beyond the tolerance. */
  readonly drifted: boolean;
}

/**
 * Execute a plan.
 *
 * I. Dry run is first-class
 *
 * 1. When `dryRun` is set, every target is returned with `outcome: 'skipped'`,
 *    `skipReason: 'dry-run'` and `freedBytes: 0`, and the filesystem is not
 *    touched at all — not even read. The dry run exists so the confirmation
 *    step costs nothing, and a preview that cannot mutate is a preview the TUI
 *    may recompute freely.
 * 2. Because nothing is read, a dry run never reports a re-check failure. That
 *    is deliberate: a re-check answers "may I delete this right now", and
 *    during a dry run the answer is never "yes", so pretending to have asked
 *    would only imply a guarantee the run did not make.
 * 3. Timings are still real per-target measurements of the little work the dry
 *    run does, so the field is never a fabricated value.
 *
 * II. Deletion is serial, never concurrent
 *
 * 1. **Predictable I/O.** Every deletion contends for the same volume; running
 *    them in parallel turns a linear reclaim into a thrashing one, and the
 *    "freed so far" number stops being monotonic in wall-clock time.
 * 2. **Honest progress.** One target at a time means the progress line always
 *    names the directory being removed right now, rather than a set of in-flight
 *    paths that finish in an order nobody can follow.
 * 3. **Clean aborts.** With one deletion in flight, the signal is checked
 *    between targets and a Ctrl-C can never leave a half-removed sibling
 *    started in parallel. A concurrent executor would need a per-target
 *    cancellation barrier, which is exactly the complexity that leaves debris.
 * 4. **Failure isolation stays readable.** A failure is caught, recorded and
 *    the loop continues; serialisation makes "which target failed" and "what
 *    happened before it" trivially readable in `execution.results`.
 *
 * III. Cancellation
 *
 * 1. The signal is checked *between* targets. An abort returns the partial
 *    execution with every completed result preserved and never throws (NFR-9).
 * 2. Targets that were never attempted are simply absent from `results`. They
 *    are not reported as skipped, because "the user stopped me" and "the target
 *    was refused" are different facts and conflating them would corrupt the
 *    skip statistics.
 *
 * @param options - The plan, the config to re-check against, and the run flags.
 * @returns The execution report; partial when the signal aborted the run.
 *
 * @example
 * ```ts
 * const execution = await executePlan({ plan, config, dryRun: true })
 * console.log(formatExecutionSummary(execution)) // 'freed 0 B · 0 deleted · …'
 * ```
 */
export async function executePlan(options: ExecuteOptions): Promise<CleanExecutionReport> {
  const { plan, config, dryRun, onProgress, signal } = options;

  const startedAt = new Date().toISOString();
  const startedMs = performance.now();

  // I. Roots are resolved once per execution, and only when a deletion can
  //    actually happen. Section II of `deleteTarget` explains why the resolved
  //    form matters for containment.
  const roots = dryRun ? config.roots : await resolveRoots(config.roots);

  const results: CleanResult[] = [];
  const driftedTargetIds: string[] = [];

  for (const target of plan.targets) {
    // I. Cancellation is honoured at the boundary between two targets, which is
    //    the only point at which no deletion is in flight.
    if (signal?.aborted === true) break;

    const targetStartedMs = performance.now();
    const outcome = dryRun
      ? dryRunOutcome(target, targetStartedMs)
      : await deleteTarget(target, config, roots, targetStartedMs);

    results.push(outcome.result);
    if (outcome.drifted) driftedTargetIds.push(target.id);

    // II. Progress is emitted once per target, after the outcome is known, so a
    //     consumer never has to render a row whose result is still in doubt.
    onProgress?.(outcome.result);
  }

  return summarize(results, startedAt, startedMs, driftedTargetIds);
}

/**
 * Resolve the configured roots to their real paths, once per run.
 *
 * I. Why the roots are resolved too
 *
 * 1. `realpath` is mandatory for the target because a symlink swapped in since
 *    the scan must not smuggle a deletion outside the roots. The same aliasing
 *    applies to the roots themselves: on macOS `/tmp` resolves to
 *    `/private/tmp`, so comparing a resolved target against an unresolved root
 *    would reject *every* legitimate target under a temporary directory.
 * 2. Resolving both sides keeps the gate exactly as strict — a resolved path is
 *    still compared against resolved containment — while removing that
 *    false-negative class.
 * 3. A root that cannot be resolved keeps its configured form. Dropping it
 *    would silently widen the gate for every other root, and widening a delete
 *    gate is never the safe direction.
 *
 * @param roots - Configured absolute roots.
 * @returns Roots in the same order, resolved where possible.
 */
async function resolveRoots(roots: readonly string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    try {
      resolved.push(await realpath(root));
    } catch {
      resolved.push(root);
    }
  }
  return resolved;
}

/**
 * Apply the four path gates to a resolved path.
 *
 * I. Why this is a helper rather than four more inline branches
 *
 * 1. The resolved path is checked against the *same* four gates the raw path
 *    already passed, and the value of that second pass depends on it being
 *    genuinely the same check: a gate that silently drifted (a whitelist read
 *    from a different field, a containment test against the wrong root list)
 *    would turn the symlink defence into decoration.
 * 2. Sharing one implementation also keeps the skip reason identical for both
 *    passes, so a caller can match on `outside-root` without caring whether the
 *    verdict came from the raw path or the resolved one.
 *
 * @param path - Path to test; always a resolved path in the current call site.
 * @param roots - Realpath-resolved roots for the containment gate.
 * @param config - Resolved configuration in effect.
 * @returns The failing check as a skip reason, or null when all four pass.
 */
async function pathGateFailure(
  path: string,
  roots: readonly string[],
  config: ResolvedConfig,
): Promise<string | null> {
  // (1) Still a directory.
  if (!(await isDirectory(path))) return 'not-a-directory';
  // (2) The built-in denylist, evaluated in its *resolved* form. The strict
  //     variant is required here because this path came from `realpath`: on
  //     macOS `/tmp` and `/var` canonicalise to `/private/...`, and a plain
  //     prefix test against the denylist's `/private` entry would refuse every
  //     legitimate temporary directory.
  if (isProtectedResolvedPath(path)) return 'protected-path';
  // (3) Containment in the roots the user configured.
  if (findContainingRoot(path, roots) === null) return 'outside-root';
  // (4) The user's whitelist.
  if (isWhitelisted(path, config.whitelist)) return 'whitelisted';
  return null;
}

/**
 * Re-check one target and, if it survives every gate, delete it.
 *
 * I. Re-check order (fixed; the first failure classifies the result)
 *
 * 1. `isDirectory(path)` — the target is still the directory the scan measured.
 * 2. `isProtectedResolvedPath(path)` — recomputed, never read off the plan.
 * 3. `findContainingRoot(path, config.roots)` — still inside a configured root.
 * 4. `isWhitelisted(path, config.whitelist)` — still not on the user's list.
 * 5. `fs.realpath(path)`, then (1)-(4) again on the *resolved* path. This is
 *    the gate that defeats a symlink swapped in between scan and delete.
 *
 * II. Why step (1) does not return immediately
 *
 * 1. `isDirectory` uses `lstat`, so a path that has been replaced by a symlink
 *    reads as "not a directory". Returning there would be safe but would report
 *    the least useful reason: for the attack step (5) exists to catch — a link
 *    pointing outside the root — the informative verdict is `outside-root`,
 *    which is only reachable once the link has been resolved.
 * 2. The structural failure is therefore remembered and applied after step (5):
 *    a path that is not a directory *and* resolves to a directory inside the
 *    roots is still skipped, because deleting the link would free nothing and
 *    deleting its target would delete a directory the plan never measured.
 *
 * III. The trust boundary
 *
 * 1. Steps (2) and (4) are evaluated against the raw path *and* the resolved
 *    path, because a whitelisted or denylisted directory reached through a link
 *    must be refused in both forms.
 *
 * @param target - Plan target being executed.
 * @param config - Resolved config to re-check against.
 * @param roots - Realpath-resolved roots for the resolved-path containment gate.
 * @param startedMs - Monotonic start of this target's attempt.
 * @returns The per-target result and its drift flag.
 */
async function deleteTarget(
  target: CleanTarget,
  config: ResolvedConfig,
  roots: readonly string[],
  startedMs: number,
): Promise<DeleteOutcome> {
  const path = target.path;

  // I. Steps (1)-(4) on the planned path. Step (1)'s answer is remembered
  //    rather than acted on yet; section II of the JSDoc explains why.
  const directDirectory = await isDirectory(path);
  // The strict variant: `path` comes from a report produced under a
  // canonicalized root, so on macOS it is already `/private/tmp/...` and the
  // plain denylist test would refuse every legitimate aliased location.
  if (isProtectedResolvedPath(path)) return skipOutcome(target, 'protected-path', startedMs);
  if (findContainingRoot(path, config.roots) === null) return skipOutcome(target, 'outside-root', startedMs);
  if (isWhitelisted(path, config.whitelist)) return skipOutcome(target, 'whitelisted', startedMs);

  // II. Step (5): resolve the real path and re-apply (1)-(4) to it.
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return skipOutcome(target, 'missing', startedMs);
    return failOutcome(target, `realpath failed: ${describeError(error)}`, startedMs);
  }

  if (normalizeForCompare(resolved) !== normalizeForCompare(path)) {
    const failure = await pathGateFailure(resolved, roots, config);
    if (failure !== null) return skipOutcome(target, failure, startedMs);
  }

  // III. The raw path stopped being a directory and step (5) did not produce a
  //      more specific verdict: refuse, without touching the link or its target.
  if (!directDirectory) return skipOutcome(target, 'not-a-directory', startedMs);

  // IV. Measure immediately before the unlink.
  //
  //     1. The plan's `bytes` is a claim from scan time. Reporting it as
  //        "freed" would be a lie whenever the directory changed in between —
  //        and `CleanExecution.freedBytes` is the one number a user is most
  //        likely to check against their disk.
  //     2. The fresh measurement is therefore what is recorded, always. A
  //        drift beyond the tolerance does *not* cancel the deletion: the user
  //        confirmed a path, not a byte count, and refusing at this point would
  //        be a surprise in the opposite direction.
  //     3. Drift is surfaced through `driftedTargetIds` instead of being
  //        smuggled into `error` or `skipReason`, either of which would
  //        misreport the outcome.
  const fresh = await measureDirectory(path);
  const freedBytes = fresh.bytes;
  const drifted = hasDrifted(target.bytes, freedBytes);

  // V. The unlink itself.
  try {
    await rm(path, REMOVE_OPTIONS);
  } catch (error) {
    // (1) Something else removed it first: nothing was freed, nothing failed.
    if (errorCode(error) === 'ENOENT') return skipOutcome(target, 'missing', startedMs);
    // (2) A real failure: permissions, a busy file, a read-only volume.
    return failOutcome(target, describeError(error), startedMs);
  }

  return {
    result: {
      targetId: target.id,
      path,
      outcome: 'deleted',
      freedBytes,
      durationMs: elapsed(startedMs),
      error: null,
      skipReason: null,
    },
    drifted,
  };
}

/**
 * The dry-run record for one target.
 *
 * Nothing on disk is read or written, so the honest freed size is zero and the
 * reason is the flag that produced it.
 *
 * @param target - Plan target being previewed.
 * @param startedMs - Monotonic start of this target's preview.
 * @returns A skipped outcome carrying real timing.
 */
function dryRunOutcome(target: CleanTarget, startedMs: number): DeleteOutcome {
  return {
    result: {
      targetId: target.id,
      path: target.path,
      outcome: 'skipped',
      freedBytes: 0,
      durationMs: elapsed(startedMs),
      error: null,
      skipReason: 'dry-run',
    },
    drifted: false,
  };
}

/** Build a skipped outcome. */
function skipOutcome(target: CleanTarget, skipReason: string, startedMs: number): DeleteOutcome {
  return {
    result: {
      targetId: target.id,
      path: target.path,
      outcome: 'skipped',
      freedBytes: 0,
      durationMs: elapsed(startedMs),
      error: null,
      skipReason,
    },
    drifted: false,
  };
}

/** Build a failed outcome. */
function failOutcome(target: CleanTarget, error: string, startedMs: number): DeleteOutcome {
  return {
    result: {
      targetId: target.id,
      path: target.path,
      outcome: 'failed',
      freedBytes: 0,
      durationMs: elapsed(startedMs),
      error,
      skipReason: null,
    },
    drifted: false,
  };
}

/**
 * Decide whether a fresh measurement disagrees with the plan.
 *
 * @param plannedBytes - The plan's claim, i.e. the scan-time size.
 * @param freshBytes - The measurement taken immediately before deletion.
 * @returns True when the relative change exceeds {@link SIZE_DRIFT_TOLERANCE}.
 */
function hasDrifted(plannedBytes: number, freshBytes: number): boolean {
  // A plan that claimed nothing cannot produce a relative change; any non-zero
  // fresh measurement is then a pure surprise and worth flagging.
  if (plannedBytes <= 0) return freshBytes > 0;
  return Math.abs(freshBytes - plannedBytes) / plannedBytes > SIZE_DRIFT_TOLERANCE;
}

/**
 * Read the `code` off a Node filesystem error without trusting its shape.
 *
 * @param error - A caught value of unknown type.
 * @returns The error code, or undefined when there is none.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Render a caught value as a one-line message.
 *
 * @param error - A caught value of unknown type.
 * @returns `error.message` for an `Error`, otherwise the stringified value.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Monotonic milliseconds since a target's attempt began, rounded to microseconds.
 *
 * I. Why `performance.now()` and not `Date.now()`
 *
 * 1. A deletion can run for minutes on a large tree; a wall-clock adjustment
 *    (NTP, a laptop waking from sleep) during that window would produce a
 *    negative or wildly inflated duration. The monotonic clock cannot.
 * 2. Rounding to three decimals keeps `durationMs` readable in a snapshot
 *    without discarding the sub-millisecond cost of a dry-run row.
 *
 * @param startedMs - Start reading from `performance.now()`.
 * @returns Elapsed milliseconds.
 */
function elapsed(startedMs: number): number {
  return Math.round((performance.now() - startedMs) * 1000) / 1000;
}

/**
 * Aggregate per-target results into the execution report.
 *
 * I. Counting rules
 *
 * 1. `freedBytes` sums only `deleted` results. A skipped or failed target freed
 *    nothing, whatever the plan claimed for it, and `freedBytes` must stay the
 *    measured truth rather than a restatement of the plan.
 * 2. The three counters partition `results` exactly, so a consumer can render
 *    "deleted / skipped / failed" without inspecting `error` (FR-43).
 *
 * @param results - Per-target results, in execution order.
 * @param startedAt - ISO-8601 start timestamp.
 * @param startedMs - Monotonic start reading.
 * @param driftedTargetIds - Ids whose measurement drifted beyond tolerance.
 * @returns The complete execution report.
 */
function summarize(
  results: readonly CleanResult[],
  startedAt: string,
  startedMs: number,
  driftedTargetIds: readonly string[],
): CleanExecutionReport {
  let freedBytes = 0;
  let deletedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const result of results) {
    if (result.outcome === 'deleted') {
      deletedCount += 1;
      freedBytes += result.freedBytes;
    } else if (result.outcome === 'skipped') {
      skippedCount += 1;
    } else {
      failedCount += 1;
    }
  }

  return {
    results,
    freedBytes,
    deletedCount,
    skippedCount,
    failedCount,
    durationMs: elapsed(startedMs),
    startedAt,
    driftedTargetIds,
  };
}

/**
 * Summarise an execution in one line.
 *
 * I. Why all three counters are printed
 *
 * 1. FR-43 requires the final summary to aggregate `deletedCount`,
 *    `skippedCount` and `failedCount`, and a one-line summary that omits the
 *    skips is unreadable after a dry run: `freed 0 B · 0 deleted · 0 failed`
 *    looks identical whether nothing matched or everything was a preview.
 *
 * @param execution - The execution to summarise.
 * @returns A string such as `freed 4.1 GB · 12 deleted · 3 skipped · 1 failed · 8.3s`.
 *
 * @example
 * ```ts
 * formatExecutionSummary(execution) // 'freed 4.1 GB · 12 deleted · 3 skipped · 1 failed · 8.3s'
 * ```
 */
export function formatExecutionSummary(execution: CleanExecution): string {
  return [
    `freed ${formatBytes(execution.freedBytes)}`,
    `${execution.deletedCount} deleted`,
    `${execution.skippedCount} skipped`,
    `${execution.failedCount} failed`,
    formatDuration(execution.durationMs),
  ].join(' · ');
}
