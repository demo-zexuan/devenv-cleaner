/**
 * Clean Plan Builder
 *
 * Turns a scan report plus the active configuration into the exact, ordered set
 * of targets a cleanup run will act on, and explains every target it leaves
 * behind.
 *
 * I. Where this module sits
 *
 * 1. The scanner decides what *exists*; the planner decides what may be
 *    *touched*. Keeping the two apart is what lets `dvc scan` stay read-only
 *    while `dvc clean --dry-run` reuses a report produced minutes ago.
 * 2. The planner performs no I/O. Every input is already in the report or the
 *    config, so a plan is a pure function of its arguments: cheap to recompute
 *    on every TUI keystroke and testable without a filesystem (NFR-10).
 * 3. `CleanPlan` stays the only thing `core/executor.ts` accepts, so the
 *    confirmation gate cannot be bypassed by handing the executor a raw target
 *    list.
 *
 * II. Two independent safety layers
 *
 * 1. The report already carries `locked` / `lockedReason` from the scan. The
 *    planner honours those flags but never *only* trusts them: the permanently
 *    non-overridable reasons are recomputed here from the live config, so a
 *    stale or hand-edited report cannot talk the planner into proposing a
 *    protected path for deletion.
 * 2. `--include-locked` is a deny-list, not an allow-list. Only the reasons
 *    this file explicitly names as policy-level hesitations may be overridden;
 *    every other reason — including one added to `types.ts` after this file was
 *    written — stays locked.
 *
 * @module core/planner
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { isWhitelisted, LAYER_ORDER } from '../rules/engine.js';
import { ellipsizePath, formatBytes, formatCount, pad } from './format.js';
import { findContainingRoot, isProtectedResolvedPath, normalizeForCompare } from './platform.js';
import type { CleanPlan, CleanTarget, LockReason, ResolvedConfig, ScanReport, TargetLayer } from './types.js';

/** Options accepted by {@link buildPlan}. */
export interface PlanOptions {
  readonly report: ScanReport;
  readonly config: ResolvedConfig;
  /** Explicit target ids chosen by the user (TUI or --target). */
  readonly selectedIds?: readonly string[];
  /** When true, ignore `locked` and consider locked targets too. */
  readonly includeLocked?: boolean;
  /** Only include targets of these layers. */
  readonly layers?: readonly TargetLayer[];
  /** Only include targets whose ruleId is in this set. */
  readonly ruleIds?: readonly string[];
  /** Only include targets at least this large. */
  readonly minBytes?: number;
  /** Only include targets older than this many days. */
  readonly olderThanDays?: number;
  /** Only include targets whose path contains this substring (case-insensitive). */
  readonly pathContains?: string;
}

/**
 * The result of {@link buildPlan}: a `CleanPlan` plus the selection bookkeeping
 * that has no home in the declared report contract.
 *
 * I. Why an extended object instead of editing `types.ts`
 *
 * 1. `CleanPlan` is the executor's input contract and is owned by another
 *    module; adding a field to it would change a shape every teammate compiles
 *    against.
 * 2. `PlanResult` is a structural superset, so every consumer that accepts a
 *    `CleanPlan` — including `core/executor.ts` and `report/markdown.ts` —
 *    accepts this unchanged. Only callers that want the diagnostics need to
 *    name the richer type.
 * 3. `unknownIds` is deliberately *not* dropped on the floor: a `--select` that
 *    silently matches nothing is the single most confusing way for a cleanup to
 *    do nothing, so the ids that were asked for and never found are carried all
 *    the way to {@link formatPlanPreview}.
 */
export interface PlanResult extends CleanPlan {
  /**
   * Selected ids that do not exist in the report, de-duplicated and sorted.
   *
   * Empty when no explicit selection was given, because "the user typed nothing
   * that could be unknown" and "every id the user typed was found" are
   * different statements.
   */
  readonly unknownIds: readonly string[];
}

/**
 * Lock reasons a user may override with `includeLocked`.
 *
 * I. Deny-list semantics
 *
 * 1. Membership is opt-in per reason, so a reason that is not listed here is
 *    permanent by construction. A new `LockReason` in `types.ts` therefore
 *    fails closed: it needs a deliberate edit *here* before it can be
 *    overridden, rather than silently becoming overridable by default.
 */
const OVERRIDABLE_LOCK_REASONS: ReadonlySet<LockReason> = new Set<LockReason>([
  'too-recent',
  'risk-exceeds-policy',
  'user-config',
]);

/** Human wording for every lock reason, used by `skipReasons` and the preview. */
const LOCK_REASON_TEXT: Readonly<Record<LockReason, string>> = {
  'protected-path': 'protected system path',
  whitelisted: 'whitelisted in the config',
  'too-small': 'below the configured size floor',
  'too-recent': 'modified too recently',
  'risk-exceeds-policy': 'risk exceeds the configured policy',
  'outside-root': 'outside every configured root',
  'user-config': 'locked by user configuration',
};

/** Wording for a lock the report set without declaring a reason. */
const UNSPECIFIED_LOCK_TEXT = 'locked by an unspecified policy';

/** Rank of each layer in review order; unknown layers sort last. */
const LAYER_RANK: ReadonlyMap<TargetLayer, number> = new Map(
  LAYER_ORDER.map((layer, index) => [layer, index] as const),
);

/** Default terminal width assumed by {@link formatPlanPreview}. */
const PREVIEW_DEFAULT_WIDTH = 100;

/** Narrowest preview that still fits every column without collapsing the path. */
const PREVIEW_MIN_WIDTH = 44;

/** Rows rendered before the preview truncates, unless the caller overrides it. */
const PREVIEW_DEFAULT_MAX_ROWS = 20;

/** Spaces between two preview columns. */
const PREVIEW_COLUMN_GAP = 2;

/** Number of columns in the preview table, used to reserve the gap budget. */
const PREVIEW_COLUMN_COUNT = 5;

/** Longest rule label rendered before it is ellipsized. */
const PREVIEW_LABEL_WIDTH = 20;

/** Narrowest path column; below this the table stops being useful. */
const PREVIEW_PATH_MIN_WIDTH = 12;

/** Marker placed in the lock column of a row that is locked in the report. */
const PREVIEW_LOCK_MARKER = 'lock';

/** How many unknown selection ids the preview names before summarising. */
const PREVIEW_UNKNOWN_ID_LIMIT = 5;

/**
 * Decide whether a target is locked for a reason no config may override.
 *
 * I. Why these checks are recomputed rather than read off the target
 *
 * 1. `target.locked` is a *claim* recorded at scan time. A report is a file:
 *    it can be edited, it can be produced under a different config, and the
 *    config passed to the planner may be newer than the scan. The four guards
 *    below are the safety floor of the whole product, so they are re-evaluated
 *    against the live config instead of being trusted.
 *
 * II. Guard order (first match wins, so `lockedReason` stays single-valued)
 *
 * 1. `protected-path` — the built-in denylist.
 * 2. `outside-root` — containment in `config.roots`, the gate that stops a
 *    pattern from reaching a volume the user never asked to scan.
 * 3. `whitelisted` — the user's own never-delete list.
 * 4. `too-small` — the size floor, including a rule-level floor.
 *
 * @param target - Candidate target.
 * @param config - Resolved configuration in effect.
 * @returns The permanent reason, or null when no permanent guard applies.
 */
function permanentLockReason(target: CleanTarget, config: ResolvedConfig): LockReason | null {
  // I. Absolute path guards, in the order documented above.
  //
  //    The strict resolved-path variant is used because roots are canonicalized
  //    at the CLI boundary, so `target.path` is canonical too. On macOS the
  //    plain check would see the canonical `/private/tmp/...` for a legitimate
  //    `/tmp` project and lock every target in it as `protected-path`, which
  //    presents as a cleanup that silently refuses to do anything.
  if (isProtectedResolvedPath(target.path)) return 'protected-path';
  if (findContainingRoot(target.path, config.roots) === null) return 'outside-root';
  if (isWhitelisted(target.path, config.whitelist)) return 'whitelisted';

  // II. Size floor: the global floor or a per-rule override, whichever is
  //     higher. `config.rules` is an open record, so the lookup is guarded.
  const perRuleFloor = config.rules[target.ruleId]?.minSizeBytes ?? 0;
  if (target.bytes < Math.max(config.minSizeBytes, perRuleFloor)) return 'too-small';

  return null;
}

/** A locked target together with the wording that explains it. */
interface LockVerdict {
  /** Machine-readable reason; null when the report locked without saying why. */
  readonly reason: LockReason | null;
  /** Human sentence assembled into `CleanPlan.skipReasons`. */
  readonly text: string;
}

/**
 * Judge one target against the permanent guards and the report's own lock.
 *
 * I. Branch order
 *
 * 1. A permanent guard always wins, whatever the report or `includeLocked`
 *    says.
 * 2. A lock the report declared is honoured. When its reason is one this
 *    module knows how to override *and* the caller asked for locked targets,
 *    the target is released into the plan.
 * 3. A lock with no declared reason is treated as permanent. Overriding it
 *    would mean guessing that an unlabelled lock is a policy hesitation, and
 *    guessing in that direction is the one guess a deletion tool must not make.
 *
 * II. The security property, written as the test that must never go red
 *
 * 1. **given** a report target whose `lockedReason` is `'whitelisted'`,
 *    **when** `buildPlan({ config, includeLocked: true })` runs, **then** the
 *    target appears in `plan.skipped` and in no case in `plan.targets`.
 * 2. The same assertion holds for `'protected-path'`, `'outside-root'` and
 *    `'too-small'`, and it holds whether the reason came from the scan or is
 *    recomputed by `permanentLockReason`. These four are the floor: no flag, no
 *    config value and no CLI option may lift them.
 * 3. **given** a target locked as `'too-recent'` or `'risk-exceeds-policy'`,
 *    **when** `includeLocked: true` runs, **then** it moves into
 *    `plan.targets`; **when** `includeLocked` is omitted it stays in
 *    `plan.skipped`. That asymmetry is the entire meaning of the flag.
 * 4. Overriding a lock is not a way to sneak past `core/executor.ts`: every
 *    promoted target still carries `locked: true` and its original
 *    `lockedReason`, so the executor's own re-checks and the preview's lock
 *    column both still see it.
 *
 * @param target - Candidate target.
 * @param config - Resolved configuration in effect.
 * @param includeLocked - True when policy-level locks may be overridden.
 * @returns A verdict when the target stays locked, or null when it is actionable.
 */
function judgeLock(target: CleanTarget, config: ResolvedConfig, includeLocked: boolean): LockVerdict | null {
  // I. Permanent guards, recomputed from the live config.
  const permanent = permanentLockReason(target, config);
  if (permanent !== null) return { reason: permanent, text: LOCK_REASON_TEXT[permanent] };

  // II. A lock the report recorded.
  if (target.locked) {
    // (1) No declared reason: fail closed rather than invent an override.
    if (target.lockedReason === null) return { reason: null, text: UNSPECIFIED_LOCK_TEXT };

    // (2) A reason the user may release, and a caller that asked to release it.
    if (includeLocked && OVERRIDABLE_LOCK_REASONS.has(target.lockedReason)) return null;

    // (3) Every other reason stays locked.
    return { reason: target.lockedReason, text: LOCK_REASON_TEXT[target.lockedReason] };
  }

  // III. Unlocked, and no permanent guard fired.
  return null;
}

/**
 * Total order over planned targets.
 *
 * I. Why this order (and why it is total)
 *
 * 1. **Layer first, cheapest-to-lose first.** The plan is reviewed top-down by
 *    a human deciding how far to scroll: caches and build outputs cost only
 *    time to recreate, dependencies cost a network round trip, and artifacts
 *    may be irreplaceable. Reviewing `cache` rows first means the user can stop
 *    reading early and still have seen the safe work.
 * 2. **Bytes descending inside a layer.** The biggest win per confirmation is
 *    the most valuable row, and it is also the row most likely to justify the
 *    whole cleanup.
 * 3. **Path ascending, then id.** Two rules can match one directory and two
 *    targets can share a size; without these last keys the order would depend
 *    on the report's input order and a snapshot test would be flaky.
 *
 * @param left - First target.
 * @param right - Second target.
 * @returns Negative, zero or positive, per `Array.prototype.sort`.
 */
function compareTargets(left: CleanTarget, right: CleanTarget): number {
  const leftRank = LAYER_RANK.get(left.layer) ?? LAYER_ORDER.length;
  const rightRank = LAYER_RANK.get(right.layer) ?? LAYER_ORDER.length;
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.bytes !== right.bytes) return right.bytes - left.bytes;
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

/** The filter set, compiled once per plan so every test is O(1). */
interface CompiledFilters {
  /** Selected ids, or null when the caller did not narrow the selection. */
  readonly selection: ReadonlySet<string> | null;
  /** Permitted layers, or null for all. */
  readonly layers: ReadonlySet<TargetLayer> | null;
  /** Permitted rule ids, or null for all. */
  readonly rules: ReadonlySet<string> | null;
  /** Size floor in bytes, or null for none. */
  readonly minBytes: number | null;
  /** Age floor in days, or null for none. */
  readonly olderThanDays: number | null;
  /** Normalized, lower-cased path substring, or null for none. */
  readonly pathNeedle: string | null;
}

/**
 * Compile the caller's filters into sets and scalars.
 *
 * @param options - Plan options carrying the filters.
 * @returns The compiled filter set.
 */
function compileFilters(options: PlanOptions): CompiledFilters {
  return {
    selection: options.selectedIds === undefined ? null : new Set(options.selectedIds),
    layers: options.layers === undefined ? null : new Set(options.layers),
    rules: options.ruleIds === undefined ? null : new Set(options.ruleIds),
    minBytes: options.minBytes ?? null,
    olderThanDays: options.olderThanDays ?? null,
    pathNeedle:
      options.pathContains === undefined ? null : normalizeForCompare(options.pathContains).toLowerCase(),
  };
}

/**
 * Test one target against the compiled filter pipeline.
 *
 * I. Pipeline order
 *
 * 1. Explicit selection.
 * 2. Layer.
 * 3. Rule id.
 * 4. Minimum size.
 * 5. Minimum age.
 * 6. Path substring.
 *
 * The stages are commutative on the surviving set, so the order is fixed not
 * for semantics but for two practical reasons: the set memberships (1-3) are
 * cheaper than the scans (4-6), and a fixed order makes the pipeline
 * reproducible when a user reports "this target should have been included".
 *
 * @param target - Candidate target.
 * @param filters - Compiled filters.
 * @returns True when the target survives every stage.
 */
function passesFilters(target: CleanTarget, filters: CompiledFilters): boolean {
  // (1) Explicit selection.
  if (filters.selection !== null && !filters.selection.has(target.id)) return false;
  // (2) Layer.
  if (filters.layers !== null && !filters.layers.has(target.layer)) return false;
  // (3) Rule.
  if (filters.rules !== null && !filters.rules.has(target.ruleId)) return false;
  // (4) Size floor.
  if (filters.minBytes !== null && target.bytes < filters.minBytes) return false;
  // (5) Staleness floor, measured on the freshest file in the tree.
  if (filters.olderThanDays !== null && target.ageDays < filters.olderThanDays) return false;
  // (6) Free-text path match, separator-normalized on both sides so a
  //     Windows-style query matches a Windows-style path.
  const path = normalizeForCompare(target.path).toLowerCase();
  if (filters.pathNeedle !== null && !path.includes(filters.pathNeedle)) return false;
  return true;
}

/** The candidate split, before totals are computed. */
interface SplitTargets {
  /** Actionable targets in execution order. */
  readonly targets: CleanTarget[];
  /** Locked targets in review order, kept for transparency. */
  readonly skipped: CleanTarget[];
  /** Distinct human reasons across `skipped`, sorted. */
  readonly skipReasons: string[];
}

/**
 * Partition candidates into actionable and skipped, and order both.
 *
 * @param candidates - Filtered candidates.
 * @param config - Resolved configuration in effect.
 * @param includeLocked - True when policy-level locks may be overridden.
 * @returns The two ordered lists plus the distinct skip reasons.
 */
function splitByLock(
  candidates: readonly CleanTarget[],
  config: ResolvedConfig,
  includeLocked: boolean,
): SplitTargets {
  const targets: CleanTarget[] = [];
  const skipped: CleanTarget[] = [];
  const skipTexts: string[] = [];

  for (const target of candidates) {
    const verdict = judgeLock(target, config, includeLocked);
    if (verdict === null) {
      targets.push(target);
      continue;
    }
    // The entry is rewritten so the plan states the planner's verdict rather
    // than the scan's. `verdict.reason` is normally a real `LockReason`, but it
    // is null for a target the report marked locked without saying why; that
    // case stays locked (`locked: true`) with a null reason on purpose, because
    // "locked, reason unknown" is the truthful description and the executor
    // treats an unlabelled lock as non-overridable.
    skipped.push({ ...target, locked: true, lockedReason: verdict.reason });
    skipTexts.push(verdict.text);
  }

  targets.sort(compareTargets);
  skipped.sort(compareTargets);
  return { targets, skipped, skipReasons: [...new Set(skipTexts)].sort() };
}

/**
 * Collect the selected ids that the report does not contain.
 *
 * @param selectedIds - The caller's explicit selection, if any.
 * @param report - Report the selection was resolved against.
 * @returns Unknown ids, de-duplicated and sorted.
 */
function collectUnknownIds(selectedIds: readonly string[] | undefined, report: ScanReport): string[] {
  if (selectedIds === undefined) return [];
  const known = new Set(report.targets.map((target) => target.id));
  const unknown: string[] = [];
  for (const id of new Set(selectedIds)) {
    if (!known.has(id)) unknown.push(id);
  }
  unknown.sort();
  return unknown;
}

/** Sum the byte counts of a target list. */
function sumBytes(targets: readonly CleanTarget[]): number {
  let total = 0;
  for (const target of targets) total += target.bytes;
  return total;
}

/**
 * Build the plan a cleanup run will execute.
 *
 * I. What the pipeline guarantees
 *
 * 1. Every stage is a pure predicate over the report, so the same arguments
 *    always produce byte-identical plans and a snapshot test is meaningful.
 * 2. A locked target is never dropped: it moves to `skipped` so the user can
 *    see that a directory exists, how big it is, and why it will not be
 *    touched.
 * 3. `totalBytes` sums `targets` only, because it is the plan's *claim* about
 *    what the run will free; `skipped` bytes are precisely what it will not.
 *
 * @param options - Report, config, selection and filters.
 * @returns The plan plus the unknown-id diagnostics.
 *
 * @example
 * ```ts
 * const plan = buildPlan({ report, config, includeLocked: false })
 * console.log(summarizePlan(plan)) // '12 targets · 4.2 GB · 3 locked'
 * ```
 */
export function buildPlan(options: PlanOptions): PlanResult {
  const { report, config, includeLocked } = options;
  const filters = compileFilters(options);

  const candidates: CleanTarget[] = [];
  for (const target of report.targets) {
    if (passesFilters(target, filters)) candidates.push(target);
  }

  const split = splitByLock(candidates, config, includeLocked === true);

  return {
    targets: split.targets,
    totalBytes: sumBytes(split.targets),
    skipped: split.skipped,
    skipReasons: split.skipReasons,
    unknownIds: collectUnknownIds(options.selectedIds, report),
  };
}

/**
 * Build a plan for everything the active config would allow right now.
 *
 * @param report - Scan report to plan from.
 * @param config - Resolved configuration in effect.
 * @returns The plan with every unlocked target selected.
 */
export function planFromReport(report: ScanReport, config: ResolvedConfig): PlanResult {
  return buildPlan({ report, config });
}

/** One rendered table row, already formatted for its column. */
interface PreviewRow {
  /** `formatBytes` output, right-aligned. */
  readonly size: string;
  /** Layer name. */
  readonly layer: string;
  /** Rule label. */
  readonly label: string;
  /** Absolute path, ellipsized at render time. */
  readonly path: string;
  /** Lock column marker, empty for an actionable row. */
  readonly marker: string;
}

/** Render one target as a preview row. */
function previewRow(target: CleanTarget, locked: boolean): PreviewRow {
  return {
    size: formatBytes(target.bytes),
    layer: target.layer,
    label: target.label,
    path: target.path,
    marker: locked ? PREVIEW_LOCK_MARKER : '',
  };
}

/** The longest string in a list, floored at a column's header width. */
function widest(values: readonly string[], floor: number): number {
  let width = floor;
  for (const value of values) {
    if (value.length > width) width = value.length;
  }
  return width;
}

/** A full-width dash rule for one column. */
function dashes(width: number): string {
  return '-'.repeat(width);
}

/** `1 target` / `3 targets`. */
function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/**
 * Read the optional `unknownIds` carried by {@link PlanResult}.
 *
 * A bare `CleanPlan` has no such field, so the lookup is a structural probe
 * rather than a contract change: `formatPlanPreview` must accept every
 * `CleanPlan`, including ones a caller assembled by hand.
 */
function unknownIdsOf(plan: CleanPlan): readonly string[] {
  const extended = plan as CleanPlan & { readonly unknownIds?: readonly string[] };
  return extended.unknownIds ?? [];
}

/**
 * Render a plan as a fixed-width terminal table.
 *
 * I. Why the preview is text and not Ink components
 *
 * 1. The same text is needed by the TUI, by `dvc clean --dry-run` on a plain
 *    terminal and by snapshot tests. Rendering it as one pure string keeps a
 *    single source of truth for the table's shape.
 * 2. It is deliberately free of ANSI colour: colour is a presentation concern
 *    of the CLI layer, and a snapshot that contains escape codes is unreadable
 *    in a diff.
 *
 * II. Layout
 *
 * 1. Header, separator, one row per target, then the locked rows, a separator,
 *    and a trailing totals line from {@link summarizePlan}.
 * 2. Actionable rows come first because the order of `plan.targets` is already
 *    the review order; locked rows are appended so they explain what was left
 *    out without interleaving with what will happen.
 * 3. Column widths are computed over *every* row, including ones beyond
 *    `maxRows`, so truncating the preview never reflows the columns.
 *
 * @param plan - The plan to render.
 * @param options - `maxRows` caps the row count (non-positive means no cap);
 *   `width` is the total table width in characters.
 * @returns A newline-joined table, with no trailing newline.
 */
export function formatPlanPreview(
  plan: CleanPlan,
  options: { maxRows?: number; width?: number } = {},
): string {
  const width = Math.max(PREVIEW_MIN_WIDTH, options.width ?? PREVIEW_DEFAULT_WIDTH);
  const maxRows =
    options.maxRows === undefined
      ? PREVIEW_DEFAULT_MAX_ROWS
      : options.maxRows <= 0
        ? Number.POSITIVE_INFINITY
        : Math.floor(options.maxRows);

  // I. Rows: actionable first, then the transparency rows.
  const rows: PreviewRow[] = [
    ...plan.targets.map((target) => previewRow(target, target.locked)),
    ...plan.skipped.map((target) => previewRow(target, true)),
  ];
  const visible = rows.slice(0, maxRows);

  // II. Column widths.
  const sizeWidth = widest(
    rows.map((row) => row.size),
    'SIZE'.length,
  );
  const layerWidth = widest(
    LAYER_ORDER.map((layer) => layer),
    'LAYER'.length,
  );
  const labelWidth = Math.min(
    PREVIEW_LABEL_WIDTH,
    widest(
      rows.map((row) => row.label),
      'RULE'.length,
    ),
  );
  const markerWidth = 'LOCK'.length;
  const gap = ' '.repeat(PREVIEW_COLUMN_GAP);
  const reserved =
    sizeWidth + layerWidth + labelWidth + markerWidth + PREVIEW_COLUMN_GAP * (PREVIEW_COLUMN_COUNT - 1);
  const pathWidth = Math.max(PREVIEW_PATH_MIN_WIDTH, width - reserved);

  const header = [
    pad('SIZE', sizeWidth, 'right'),
    pad('LAYER', layerWidth),
    pad('RULE', labelWidth),
    pad('PATH', pathWidth),
    pad('LOCK', markerWidth),
  ].join(gap);
  const separator = [
    dashes(sizeWidth),
    dashes(layerWidth),
    dashes(labelWidth),
    dashes(pathWidth),
    dashes(markerWidth),
  ].join(gap);

  const lines: string[] = [header, separator];

  // III. Body.
  if (visible.length === 0) {
    lines.push('(nothing to clean matches the current selection and filters)');
  } else {
    for (const row of visible) {
      lines.push(
        [
          pad(row.size, sizeWidth, 'right'),
          pad(row.layer, layerWidth),
          pad(row.label, labelWidth),
          pad(ellipsizePath(row.path, pathWidth), pathWidth),
          pad(row.marker, markerWidth),
        ].join(gap),
      );
    }
    if (rows.length > visible.length) {
      lines.push(`… ${formatCount(rows.length - visible.length)} more rows not shown`);
    }
  }

  // IV. Totals, then the selection diagnostics.
  lines.push(separator, summarizePlan(plan));

  const unknownIds = unknownIdsOf(plan);
  if (unknownIds.length > 0) {
    const shown = unknownIds.slice(0, PREVIEW_UNKNOWN_ID_LIMIT).join(', ');
    const remaining = unknownIds.length - PREVIEW_UNKNOWN_ID_LIMIT;
    lines.push(
      `note: ${countLabel(unknownIds.length, 'selected id')} not found in the report: ` +
        `${shown}${remaining > 0 ? `, +${remaining} more` : ''}`,
    );
  }

  return lines.join('\n');
}

/**
 * Summarise a plan in one line.
 *
 * @param plan - The plan to summarise.
 * @returns A string such as `12 targets · 4.2 GB · 3 locked`.
 */
export function summarizePlan(plan: CleanPlan): string {
  return `${countLabel(plan.targets.length, 'target')} · ${formatBytes(plan.totalBytes)} · ${plan.skipped.length} locked`;
}
