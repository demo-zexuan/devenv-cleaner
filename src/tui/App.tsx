/**
 * TUI Application Container
 *
 * The root of the interactive interface: one stage machine, one key map, and
 * one layout budget, wiring the presentational components to the engine.
 *
 * I. Stage machine
 *
 * 1. The stages are `scanning → results → preview → confirm → executing →
 *    summary`, plus `error` for a thrown scan or build. Every stage is a
 *    *distinct state object* in a discriminated union, so a screen can only
 *    render from data that stage actually has: a confirmation cannot exist
 *    without a plan, and a plan cannot exist without a report.
 * 2. The reducer is exhaustive over that union (see {@link appReducer}); a new
 *    stage is a compile error until it is handled, and no screen is guarded by
 *    a boolean that could disagree with the stage.
 *
 * II. Key map
 *
 * 1. Global: `ctrl+c` interrupts — it aborts a running scan or execution, and
 *    leaves from any other screen with exit code 130.
 * 2. Results: `↑`/`↓` (also `k`/`j`) move; `space` toggles the focused target;
 *    `a` selects every visible unlocked target; `n` inverts the visible
 *    unlocked selection; `/` enters search (Esc cancels, Enter commits);
 *    `f` cycles the layer filter; `s` cycles the sort (`size → age → path`);
 *    `g` cycles the grouping (`project → layer → rule`); `d` (also `p`) builds
 *    the plan from the current selection and opens the preview; `q` quits,
 *    asking once when a selection would be lost; `?` toggles the key hints.
 * 3. Search mode: printable characters and backspace edit the query and are
 *    *not* interpreted as commands, so typing `q` in a search field cannot quit.
 * 4. Preview: `y` (or Enter) opens the confirmation, but only when the plan has
 *    at least one target; Esc returns to the results.
 * 5. Confirm: an explicit `y` starts the execution; every other key, Enter
 *    included, returns to the preview. Nothing here can delete on its own.
 * 6. Summary: `d` compares the pre-cleanup report with a fresh scan; `q`/Enter/
 *    Esc leave with the run's exit code.
 *
 * III. Safety
 *
 * 1. The preview's plan is rebuilt from the live selection on every `d`, never
 *    cached, so the reviewed bytes are the selected bytes.
 * 2. The confirmation gate is a separate stage from the preview, and the
 *    execution is started by exactly one action — `start-execution` — which
 *    only the confirm screen dispatches.
 * 3. This file never touches the filesystem for deletion. It hands the reviewed
 *    plan to `executePlan`, which owns every re-check.
 *
 * @module tui/App
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { Box, type Key, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  buildPlan,
  type CleanExecution,
  type CleanOutcome,
  type CleanResult,
  type CleanTarget,
  scan as coreScan,
  executePlan,
  formatBytes,
  formatCount,
  formatDuration,
  formatPlanPreview,
  getToolVersion,
  type LockReason,
  type PlanResult,
  type ReportDiff,
  type ResolvedConfig,
  type RiskLevel,
  type ScanProgress,
  type ScanReport,
  type TargetLayer,
} from '../core/index.js';
import { createTranslator, type Translator } from '../i18n/index.js';
import type { Language } from '../i18n/types.js';
import { diffReports } from '../report/diff.js';
import { type ScanFn, useScan } from './hooks/useScan.js';
import { useSelection } from './hooks/useSelection.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import {
  ConfirmDialog,
  DiffView,
  ExecutionView,
  FilterBar,
  Footer,
  Header,
  type KeyHint,
  ProgressView,
  SummaryPanel,
  TargetList,
} from './index.js';
import { makeTheme, textStyle } from './theme.js';

// ===========================================================================
// I. State machine
// ===========================================================================

/** Every screen the interface can be on. */
export type AppStage = 'scanning' | 'results' | 'preview' | 'confirm' | 'executing' | 'summary' | 'error';

/** Flags every stage carries, so they cannot be lost on a transition. */
interface StageFlags {
  /** True when the operation that led here was interrupted by the user. */
  readonly aborted: boolean;
  /** True while the key-hint footer is shown. */
  readonly hints: boolean;
}

/** The scan screen: no data yet, only progress. */
export interface ScanningState extends StageFlags {
  readonly stage: 'scanning';
  /** Newest throttled progress sample, or null before the first one. */
  readonly progress: ScanProgress | null;
}

/** The results screen: a report and a selection over it. */
export interface ResultsState extends StageFlags {
  readonly stage: 'results';
  /** Report the scan produced. */
  readonly report: ScanReport;
  /** True while the "quit and lose the selection?" prompt is on screen. */
  readonly quitPrompt: boolean;
  /** Transient footer message, e.g. why a locked row refused to toggle. */
  readonly notice: string | null;
}

/** The preview screen: the exact plan the confirmation would execute. */
export interface PreviewState extends StageFlags {
  readonly stage: 'preview';
  readonly report: ScanReport;
  /** Plan rebuilt from the selection when this stage was entered. */
  readonly plan: PlanResult;
}

/** The confirmation screen: the last gate before anything is unlinked. */
export interface ConfirmState extends StageFlags {
  readonly stage: 'confirm';
  readonly report: ScanReport;
  /** The reviewed plan; the executor receives this same object. */
  readonly plan: PlanResult;
}

/** The execution screen: results streaming in, one target at a time. */
export interface ExecutingState extends StageFlags {
  readonly stage: 'executing';
  readonly report: ScanReport;
  readonly plan: PlanResult;
  /** True when nothing is being deleted (never set by the interactive flow). */
  readonly dryRun: boolean;
  /** Outcomes reported so far. */
  readonly results: readonly CleanResult[];
}

/** The closing screen: what actually happened, plus an optional diff. */
export interface SummaryState extends StageFlags {
  readonly stage: 'summary';
  /** Report as it was before the execution, kept for the diff baseline. */
  readonly report: ScanReport;
  /** Complete or partial execution report. */
  readonly execution: CleanExecution;
  /** Number of targets the plan covered. */
  readonly total: number;
  /** True when nothing was actually deleted. */
  readonly dryRun: boolean;
  /** Fresh-scan comparison, once the user has asked for it. */
  readonly diff: ReportDiff | null;
  /** Where the comparison currently is. */
  readonly diffPhase: 'idle' | 'loading' | 'error';
  /** Failure detail when `diffPhase` is `error`. */
  readonly diffMessage: string | null;
  /** True while the comparison is the visible body. */
  readonly showDiff: boolean;
}

/** The failure screen: a scan or a plan threw. */
export interface ErrorState extends StageFlags {
  readonly stage: 'error';
  /** Human-readable failure message. */
  readonly message: string;
}

/** Everything the container can be rendering. */
export type AppState =
  | ScanningState
  | ResultsState
  | PreviewState
  | ConfirmState
  | ExecutingState
  | SummaryState
  | ErrorState;

/** Transitions the container accepts. */
export type AppAction =
  | { readonly type: 'toggle-hints' }
  | { readonly type: 'mark-aborted' }
  | { readonly type: 'scan-progress'; readonly progress: ScanProgress }
  | { readonly type: 'scan-complete'; readonly report: ScanReport }
  | { readonly type: 'scan-failed'; readonly message: string }
  | { readonly type: 'notify'; readonly message: string | null }
  | { readonly type: 'toggle-quit-prompt'; readonly open: boolean }
  | { readonly type: 'open-preview'; readonly plan: PlanResult }
  | { readonly type: 'back-to-results' }
  | { readonly type: 'open-confirm' }
  | { readonly type: 'back-to-preview' }
  | { readonly type: 'start-execution'; readonly dryRun: boolean }
  | { readonly type: 'execution-progress'; readonly result: CleanResult }
  | { readonly type: 'execution-complete'; readonly execution: CleanExecution }
  | { readonly type: 'execution-failed'; readonly message: string }
  | { readonly type: 'diff-loading' }
  | { readonly type: 'diff-ready'; readonly diff: ReportDiff }
  | { readonly type: 'diff-failed'; readonly message: string }
  | { readonly type: 'diff-show'; readonly show: boolean };

/**
 * Fail on an unhandled union member.
 *
 * I. Why this throws instead of returning
 *
 * 1. It is the exhaustiveness proof for the stage switch: if a stage is added
 *    and not handled, TypeScript reports the argument as `never` and this call
 *    stops compiling. The throw only exists to satisfy the return type.
 *
 * @param value - The value TypeScript proved impossible.
 * @returns Never; always throws.
 */
function assertNever(value: never): never {
  throw new Error(`unhandled application state: ${JSON.stringify(value)}`);
}

/** The state the interface starts in. */
function initialState(): ScanningState {
  return { stage: 'scanning', aborted: false, hints: true, progress: null };
}

/**
 * Reduce the running scan's transitions.
 *
 * @param state - Scanning state.
 * @param action - Transition to apply.
 * @returns The next state, or `state` when the action does not apply here.
 */
function reduceScanning(state: ScanningState, action: AppAction): AppState {
  switch (action.type) {
    case 'scan-progress':
      return { ...state, progress: action.progress };
    case 'scan-complete':
      // An aborted scan still lands here with a partial report; `aborted` is
      // carried across so the results screen can say the totals are partial.
      return {
        stage: 'results',
        aborted: state.aborted,
        hints: state.hints,
        report: action.report,
        quitPrompt: false,
        notice: null,
      };
    case 'scan-failed':
      return { stage: 'error', aborted: state.aborted, hints: state.hints, message: action.message };
    default:
      return state;
  }
}

/**
 * Reduce the results screen's transitions.
 *
 * @param state - Results state.
 * @param action - Transition to apply.
 * @returns The next state, or `state` when the action does not apply here.
 */
function reduceResults(state: ResultsState, action: AppAction): AppState {
  switch (action.type) {
    case 'notify':
      return { ...state, notice: action.message };
    case 'toggle-quit-prompt':
      return { ...state, quitPrompt: action.open };
    case 'open-preview':
      return {
        stage: 'preview',
        aborted: false,
        hints: state.hints,
        report: state.report,
        plan: action.plan,
      };
    default:
      return state;
  }
}

/**
 * Reduce the preview screen's transitions.
 *
 * @param state - Preview state.
 * @param action - Transition to apply.
 * @returns The next state, or `state` when the action does not apply here.
 */
function reducePreview(state: PreviewState, action: AppAction): AppState {
  switch (action.type) {
    case 'back-to-results':
      return {
        stage: 'results',
        aborted: false,
        hints: state.hints,
        report: state.report,
        quitPrompt: false,
        notice: null,
      };
    case 'open-confirm':
      return { stage: 'confirm', aborted: false, hints: state.hints, report: state.report, plan: state.plan };
    default:
      return state;
  }
}

/**
 * Reduce the confirmation screen's transitions.
 *
 * @param state - Confirm state.
 * @param action - Transition to apply.
 * @returns The next state, or `state` when the action does not apply here.
 */
function reduceConfirm(state: ConfirmState, action: AppAction): AppState {
  switch (action.type) {
    case 'back-to-preview':
      return { stage: 'preview', aborted: false, hints: state.hints, report: state.report, plan: state.plan };
    case 'start-execution':
      return {
        stage: 'executing',
        aborted: false,
        hints: state.hints,
        report: state.report,
        plan: state.plan,
        dryRun: action.dryRun,
        results: [],
      };
    default:
      return state;
  }
}

/**
 * Reduce the execution screen's transitions.
 *
 * @param state - Executing state.
 * @param action - Transition to apply.
 * @returns The next state, or `state` when the action does not apply here.
 */
function reduceExecuting(state: ExecutingState, action: AppAction): AppState {
  switch (action.type) {
    case 'execution-progress':
      return { ...state, results: [...state.results, action.result] };
    case 'execution-complete':
      return {
        stage: 'summary',
        aborted: state.aborted,
        hints: state.hints,
        report: state.report,
        execution: action.execution,
        total: state.plan.targets.length,
        dryRun: state.dryRun,
        diff: null,
        diffPhase: 'idle',
        diffMessage: null,
        showDiff: false,
      };
    case 'execution-failed':
      return { stage: 'error', aborted: state.aborted, hints: state.hints, message: action.message };
    default:
      return state;
  }
}

/**
 * Reduce the summary screen's transitions.
 *
 * @param state - Summary state.
 * @param action - Transition to apply.
 * @returns The next state, or `state` when the action does not apply here.
 */
function reduceSummary(state: SummaryState, action: AppAction): AppState {
  switch (action.type) {
    case 'diff-loading':
      return { ...state, diff: null, diffPhase: 'loading', diffMessage: null, showDiff: false };
    case 'diff-ready':
      return { ...state, diff: action.diff, diffPhase: 'idle', diffMessage: null, showDiff: true };
    case 'diff-failed':
      return { ...state, diffPhase: 'error', diffMessage: action.message, showDiff: false };
    case 'diff-show':
      return { ...state, showDiff: action.show };
    default:
      return state;
  }
}

/**
 * The container's single reducer.
 *
 * I. Structure
 *
 * 1. `toggle-hints` and `mark-aborted` are stage-independent, so they are
 *    handled before the dispatch to a stage reducer; everything else is routed
 *    by the stage discriminant.
 * 2. Each stage reducer ignores actions that do not belong to it, which is what
 *    makes an out-of-stage transition (`open-confirm` while scanning, say) a
 *    no-op instead of a state that claims to be two stages at once.
 *
 * @param state - Current state.
 * @param action - Transition to apply.
 * @returns The next state.
 */
export function appReducer(state: AppState, action: AppAction): AppState {
  // I. Flags that belong to every stage.
  if (action.type === 'toggle-hints') return { ...state, hints: !state.hints };
  if (action.type === 'mark-aborted') return state.aborted ? state : { ...state, aborted: true };

  // II. Stage-specific routing, exhaustive over the union.
  switch (state.stage) {
    case 'scanning':
      return reduceScanning(state, action);
    case 'results':
      return reduceResults(state, action);
    case 'preview':
      return reducePreview(state, action);
    case 'confirm':
      return reduceConfirm(state, action);
    case 'executing':
      return reduceExecuting(state, action);
    case 'summary':
      return reduceSummary(state, action);
    case 'error':
      return state;
    default:
      return assertNever(state);
  }
}

// ===========================================================================
// II. Exit codes and layout budgets
// ===========================================================================

/** Exit code for a run the user interrupted. */
const EXIT_ABORTED = 130;

/** Exit code for a failed execution or a fatal scan error. */
const EXIT_FAILED = 1;

/** Exit code for a clean run. */
const EXIT_OK = 0;

/** Header rows that are always present: masthead, subtitle and rule. */
const HEADER_ROWS = 3;

/** Rows the summary panel occupies: two border rows plus seven content rows. */
const SUMMARY_ROWS = 9;

/** Rows the filter bar occupies. */
const FILTER_ROWS = 1;

/** Shortest table that is still worth drawing. */
const MIN_LIST_ROWS = 3;

/** Shortest body the layout will hand to a screen. */
const MIN_BODY_ROWS = 3;

/** Most rows the key-hint block may reserve. */
const MAX_HINT_ROWS = 3;

/** Narrowest terminal at which the header shows the scan root. */
const HEADER_ROOT_MIN_WIDTH = 60;

/**
 * Decide the process exit code for a state.
 *
 * I. Precedence
 *
 * 1. An interrupted operation outranks a failure: the conventional 130 tells a
 *    caller "the user stopped this", which is a different outcome from "it did
 *    not work" even when both left work undone.
 * 2. A completed execution with failures is a failure, because the caller asked
 *    for space to be reclaimed and some of it was not.
 *
 * @param state - State the interface is leaving from.
 * @returns `130`, `1` or `0`.
 */
export function exitCodeFor(state: AppState): number {
  if (state.aborted) return EXIT_ABORTED;
  if (state.stage === 'error') return EXIT_FAILED;
  if (state.stage === 'summary' && state.execution.failedCount > 0) return EXIT_FAILED;
  return EXIT_OK;
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
 * Turn a message template into a bare field label.
 *
 * I. Why this exists
 *
 * 1. Several presentational components compose `label: value` themselves, but
 *    the message table spells some labels as complete sentences with `{slots}`
 *    ("Directories: {count}", "Net change: {delta}"). Passing the template
 *    through unchanged would render the slot name beside the value.
 * 2. Removing the slots and the empty bracket pair they leave behind yields the
 *    label the component wanted, in the active language, without an English
 *    literal appearing anywhere in this file.
 *
 * @param template - Localised message containing `{slot}` placeholders.
 * @param slots - Slot names to remove, e.g. `['count']`.
 * @returns The template with its slots stripped and spacing normalised.
 */
function fieldLabel(template: string, slots: readonly string[]): string {
  let text = template;
  for (const slot of slots) text = text.replaceAll(`{${slot}}`, '');
  return text
    .replace(/\(\s*\)/g, ' ')
    .replace(/（\s*）/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([:：])/g, '$1')
    .trim();
}

/**
 * Estimate how many rows a hint block wraps to.
 *
 * I. Why the container must estimate this
 *
 * 1. The footer wraps its hints itself, and it does so during layout — after
 *    the body has already been given a height. Reserving the wrong number of
 *    rows makes the frame either overflow the viewport or leave a gap.
 * 2. Ink packs whole items with a two-column gutter, so the same greedy pass
 *    over the same strings reproduces its wrap closely enough for a budget.
 *
 * @param hints - Hints that will be rendered.
 * @param width - Total terminal width in columns.
 * @returns Rows to reserve, capped at {@link MAX_HINT_ROWS}.
 */
function hintRows(hints: readonly KeyHint[], width: number): number {
  if (hints.length === 0) return 0;
  const inner = Math.max(1, width - 2);
  let rows = 1;
  let used = 0;
  for (const hint of hints) {
    const label = hint.disabled === true ? `(${hint.key}) ${hint.label}` : `${hint.key} ${hint.label}`;
    const needed = used === 0 ? label.length : used + 2 + label.length;
    if (needed <= inner) {
      used = needed;
      continue;
    }
    rows += 1;
    used = label.length;
  }
  return Math.min(rows, MAX_HINT_ROWS);
}

// ===========================================================================
// III. Props
// ===========================================================================

/** Props accepted by {@link App}. */
export interface AppProps {
  /** Resolved configuration the scan, the plan and the executor all use. */
  readonly config: ResolvedConfig;
  /** Language every string on screen is rendered in. */
  readonly language: Language;
  /** Whether the scan should also probe machine-global caches. */
  readonly includeGlobal: boolean;
  /** True when colour must be suppressed. */
  readonly noColor: boolean;
  /** Called exactly once, with the process exit code, when the app is done. */
  readonly onExit: (code: number) => void;
  /** Scanner override; production leaves it out and uses the engine. */
  readonly scan?: ScanFn;
}

// ===========================================================================
// IV. Component
// ===========================================================================

/** A stable empty target list, so the selection memo never re-runs needlessly. */
const NO_TARGETS: readonly CleanTarget[] = [];

/**
 * Render the interactive interface.
 *
 * I. Responsibilities
 *
 * 1. Own the stage machine and the key map.
 * 2. Own the layout budget: the terminal size is measured once per resize and
 *    every child is given an explicit width and height derived from it.
 * 3. Own the two asynchronous effects a stage can need — the scan and the
 *    execution — each behind an abort controller that is released on unmount.
 *
 * @param props - Config, language, colour verdict, exit callback and scanner.
 * @returns The full-screen application.
 */
export function App({
  config,
  language,
  includeGlobal,
  noColor,
  onExit,
  scan = coreScan,
}: AppProps): ReactNode {
  // I. Language and colour are resolved once per prop change; a screen must
  //    never mix two languages or two colour verdicts.
  const tr = useMemo(() => createTranslator(language), [language]);
  const theme = useMemo(() => makeTheme({ plain: noColor, noColorEnv: process.env['NO_COLOR'] }), [noColor]);

  const { columns, rows } = useTerminalSize();
  const [state, dispatch] = useReducer(appReducer, undefined, initialState);

  // II. The package version is decorative, so it is fetched without blocking a
  //     frame and may simply never appear.
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void getToolVersion().then((value) => {
      if (alive) setVersion(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  // III. Exit is idempotent: Ink is unmounted exactly once, after the callback.
  const exitedRef = useRef(false);
  const exitWith = useCallback(
    (code: number): void => {
      if (exitedRef.current) return;
      exitedRef.current = true;
      onExit(code);
    },
    [onExit],
  );

  // IV. The latest state, for callbacks that outlive the render that created
  //     them (the rescan's completion, in particular).
  const stateRef = useRef<AppState>(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // V. Two scan drivers: the opening scan, and the on-demand rescan behind the
  //    summary's comparison. They share the hook, so throttling, cancellation
  //    and unmount safety are implemented once.
  const scanner = useScan({
    scan,
    roots: config.roots,
    config,
    includeGlobalTargets: includeGlobal,
    autoStart: true,
    onComplete: (report) => {
      dispatch({ type: 'scan-complete', report });
    },
    onError: (message) => {
      dispatch({ type: 'scan-failed', message });
    },
  });

  const diffScanner = useScan({
    scan,
    roots: config.roots,
    config,
    includeGlobalTargets: includeGlobal,
    autoStart: false,
    onComplete: (report) => {
      const current = stateRef.current;
      if (current.stage !== 'summary') return;
      // I. The diff is directional: the pre-cleanup report is the baseline.
      try {
        dispatch({ type: 'diff-ready', diff: diffReports(current.report, report) });
      } catch (error) {
        dispatch({ type: 'diff-failed', message: describeError(error) });
      }
    },
    onError: (message) => {
      dispatch({ type: 'diff-failed', message });
    },
  });
  const startDiffScan = diffScanner.start;

  // VI. The execution is owned by an effect keyed on the plan's identity. The
  //     plan object is carried unchanged through every progress update, so the
  //     effect starts exactly once per confirmed plan.
  const executingPlan = state.stage === 'executing' ? state.plan : null;
  const executingDryRun = state.stage === 'executing' ? state.dryRun : false;
  const executionAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (executingPlan === null) return;
    const controller = new AbortController();
    executionAbortRef.current = controller;
    let cancelled = false;

    void executePlan({
      plan: executingPlan,
      config,
      dryRun: executingDryRun,
      signal: controller.signal,
      onProgress: (result) => {
        if (!cancelled) dispatch({ type: 'execution-progress', result });
      },
    })
      .then((execution) => {
        if (!cancelled) dispatch({ type: 'execution-complete', execution });
      })
      .catch((error: unknown) => {
        if (!cancelled) dispatch({ type: 'execution-failed', message: describeError(error) });
      });

    return () => {
      cancelled = true;
      controller.abort();
      executionAbortRef.current = null;
    };
  }, [executingPlan, executingDryRun, config]);

  // VII. Nothing may keep running after the interface is gone.
  useEffect(
    () => () => {
      executionAbortRef.current?.abort();
    },
    [],
  );

  // VIII. Layout budget. The header grows by one row on a wide terminal (the
  //       scan root), the footer by its message and its wrapped hints; the body
  //       gets everything that is left.
  const root = config.roots[0];
  const bodyMessage = stageMessage(state, tr);
  const hints = state.hints ? stageHints(state, tr) : [];
  const headerRows = HEADER_ROWS + (columns >= HEADER_ROOT_MIN_WIDTH && root !== undefined ? 1 : 0);
  const footerRows = hintRows(hints, columns) + (bodyMessage === undefined ? 0 : 1);
  const bodyRows = Math.max(MIN_BODY_ROWS, rows - headerRows - footerRows);
  const listRows = Math.max(MIN_LIST_ROWS, bodyRows - FILTER_ROWS - SUMMARY_ROWS);

  // IX. Selection state is derived from the report's targets; the hook keeps
  //     working (on an empty list) while a scan is still running.
  const targets = hasReport(state) ? state.report.targets : NO_TARGETS;
  const selection = useSelection(targets, listRows);

  // X. Opening the preview always rebuilds the plan from the selection that
  //    exists right now — a cached plan could name a target the user has since
  //    deselected, and the confirmation would then review the wrong bytes.
  const openPreview = useCallback((): void => {
    const current = stateRef.current;
    if (current.stage !== 'results') return;
    const plan = buildPlan({
      report: current.report,
      config,
      selectedIds: [...selection.selectedIds],
    });
    dispatch({ type: 'open-preview', plan });
  }, [config, selection.selectedIds]);

  // XI. The rescan behind the summary comparison.
  const openDiff = useCallback((): void => {
    const current = stateRef.current;
    if (current.stage !== 'summary') return;
    if (current.diffPhase === 'loading') return;
    dispatch({ type: 'diff-loading' });
    startDiffScan();
  }, [startDiffScan]);

  // XII. Interrupt handling, shared by every stage.
  const handleInterrupt = useCallback((): void => {
    const current = stateRef.current;

    // (1) A running scan is aborted; it still reports what it found, so the
    //     interface moves on to the results rather than tearing down.
    if (current.stage === 'scanning') {
      if (current.aborted) {
        exitWith(EXIT_ABORTED);
        return;
      }
      dispatch({ type: 'mark-aborted' });
      scanner.abort();
      return;
    }

    // (2) An execution is aborted between two targets and reports the partial
    //     run, so the summary stays reachable.
    if (current.stage === 'executing') {
      dispatch({ type: 'mark-aborted' });
      executionAbortRef.current?.abort();
      return;
    }

    // (3) A terminal screen has already produced its outcome: leave with that
    //     outcome rather than pretending the finished work was interrupted.
    if (current.stage === 'summary' || current.stage === 'error') {
      exitWith(exitCodeFor(current));
      return;
    }

    // (4) Anywhere else the interrupt is a plain abort before anything ran.
    exitWith(EXIT_ABORTED);
  }, [exitWith, scanner]);

  // XIII. Key routing. `useInput` keeps the latest closure, so every branch
  //       below reads the state of the frame the user is looking at.
  useInput((input: string, key: Key): void => {
    // I. An interrupt outranks everything, including an active search field.
    if (key.ctrl && input === 'c') {
      handleInterrupt();
      return;
    }

    switch (state.stage) {
      case 'scanning':
      case 'executing':
        // The only live key here is the interrupt handled above.
        return;

      case 'results': {
        // II. Search mode owns the keyboard: nothing typed into the field may
        //     reach a command binding.
        if (selection.searchActive) {
          if (key.return) selection.exitSearch(true);
          else if (key.escape) selection.exitSearch(false);
          else if (key.backspace || key.delete) selection.backspaceQuery();
          else if (!key.ctrl && !key.meta && !key.tab && input.length > 0) selection.appendQuery(input);
          return;
        }

        // III. The quit prompt is modal: `q` confirms, anything else cancels.
        if (state.quitPrompt) {
          if (input === 'q') exitWith(exitCodeFor(state));
          else dispatch({ type: 'toggle-quit-prompt', open: false });
          return;
        }

        // IV. A stale notice is cleared by the next key; the space branch below
        //     may immediately replace it with a fresh one.
        if (state.notice !== null) dispatch({ type: 'notify', message: null });

        if (key.upArrow || input === 'k') {
          selection.move(-1);
          return;
        }
        if (key.downArrow || input === 'j') {
          selection.move(1);
          return;
        }
        if (input === ' ') {
          const target = selection.focusedTarget;
          if (target === null) return;
          // A locked row is inert, and the footer says why.
          if (target.locked) {
            dispatch({ type: 'notify', message: lockedNotice(tr, target) });
            return;
          }
          selection.toggle(target);
          return;
        }
        if (input === 'a') {
          selection.selectAllUnlocked();
          return;
        }
        if (input === 'n') {
          selection.invertSelection();
          return;
        }
        if (input === '/') {
          selection.enterSearch();
          return;
        }
        if (input === 'f') {
          selection.cycleLayer();
          return;
        }
        if (input === 's') {
          selection.cycleSort();
          return;
        }
        if (input === 'g') {
          selection.cycleGroup();
          return;
        }
        if (input === 'd' || input === 'p') {
          openPreview();
          return;
        }
        if (input === 'q') {
          // V. Losing a selection is worth one question; quitting a pristine
          //    screen is not.
          if (selection.selectedCount > 0) {
            dispatch({ type: 'toggle-quit-prompt', open: true });
            return;
          }
          exitWith(exitCodeFor(state));
          return;
        }
        if (input === '?') dispatch({ type: 'toggle-hints' });
        return;
      }

      case 'preview':
        // VI. The preview may only advance into a confirmation for a plan that
        //     has something to do; an empty plan offers the way back instead.
        if ((input === 'y' || key.return) && state.plan.targets.length > 0) {
          dispatch({ type: 'open-confirm' });
          return;
        }
        if (key.escape || input === 'q') {
          dispatch({ type: 'back-to-results' });
          return;
        }
        if (input === '?') dispatch({ type: 'toggle-hints' });
        return;

      case 'confirm':
        // VII. Only an explicit `y` may proceed. Every other key — Enter
        //      included — returns to the preview, so a stray keystroke cannot
        //      start a deletion.
        if (input === 'y' || input === 'Y') {
          dispatch({ type: 'start-execution', dryRun: false });
          return;
        }
        dispatch({ type: 'back-to-preview' });
        return;

      case 'summary':
        if (input === 'd' || input === 'p') {
          if (state.diff !== null) {
            dispatch({ type: 'diff-show', show: !state.showDiff });
            return;
          }
          openDiff();
          return;
        }
        if (key.escape || key.return || input === 'q') {
          exitWith(exitCodeFor(state));
          return;
        }
        if (input === '?') dispatch({ type: 'toggle-hints' });
        return;

      case 'error':
        // VIII. A failure has already happened; any key acknowledges it.
        exitWith(exitCodeFor(state));
        return;

      default:
        assertNever(state);
    }
  });

  // XIV. Body rendering, exhaustive over the stage union.
  function renderBody(): ReactNode {
    switch (state.stage) {
      case 'scanning': {
        const sample = state.progress;
        const phase = sample?.phase ?? 'discovering';
        return (
          <ProgressView
            phase={phase}
            phaseLabel={tr.t(`scan.phase.${phase}`)}
            directoriesVisited={sample?.directoriesVisited ?? 0}
            targetsFound={sample?.targetsFound ?? 0}
            bytesFound={sample?.bytesFound ?? 0}
            currentPath={sample?.currentPath ?? root ?? ''}
            height={bodyRows}
            width={columns}
            theme={theme}
            labels={{
              dirs: fieldLabel(tr.t('scan.progress.dirs'), ['count']),
              targets: fieldLabel(tr.t('unit.targets'), ['count']),
              scanning: tr.t('cmd.scan'),
            }}
          />
        );
      }

      case 'results':
        return (
          <Box flexDirection="column" width={columns} flexShrink={0}>
            <FilterBar
              query={selection.query}
              activeLayer={selection.activeLayer}
              sortKey={selection.sortKey}
              groupBy={selection.groupBy}
              matchedCount={selection.visible.length}
              totalCount={state.report.targets.length}
              theme={theme}
              width={columns}
              labels={{
                search: tr.t('tui.hint.search'),
                filter: tr.t('tui.hint.filter'),
                sort: tr.t('tui.hint.sort'),
                group: tr.t('tui.group.byProject'),
                all: tr.t('tui.filter.all'),
                matched: '',
              }}
              layerLabel={(layer: TargetLayer) => tr.layer(layer)}
            />
            <TargetList
              targets={selection.visible}
              selectedIds={selection.selectedIds}
              focusedIndex={selection.focusedIndex}
              height={listRows}
              offset={selection.offset}
              showProject={selection.showProject}
              theme={theme}
              width={columns}
              emptyLabel={tr.t('scan.noTargets')}
              riskLabel={(risk: RiskLevel) => tr.risk(risk)}
              lockLabel={(reason: LockReason) => tr.lockReason(reason)}
              header={{
                size: tr.t('col.size'),
                path: tr.t('col.path'),
                rule: tr.t('col.rule'),
                risk: tr.t('col.risk'),
                age: tr.t('col.age'),
              }}
            />
            <SummaryPanel
              summary={state.report.summary}
              selectedBytes={selection.selectedBytes}
              selectedCount={selection.selectedCount}
              projects={state.report.projects.length}
              theme={theme}
              width={columns}
              labels={{
                total: tr.t('tui.filter.all'),
                reclaimable: tr.t('confirm.yes'),
                selected: tr.t('tui.hint.toggle'),
                targets: fieldLabel(tr.t('unit.targets'), ['count']),
                projects: tr.t('tui.group.byProject'),
                largest: tr.t('col.size'),
              }}
              layerLabel={(layer: TargetLayer) => tr.layer(layer)}
            />
          </Box>
        );

      case 'preview': {
        const empty = state.plan.targets.length === 0;
        const inner = Math.max(8, columns - 4);
        // The table adds three chrome rows (header, separator, totals) on top of
        // its data rows, and the frame plus the title take three more.
        const previewLines = empty
          ? []
          : formatPlanPreview(state.plan, { width: inner, maxRows: Math.max(1, bodyRows - 6) })
              .split('\n')
              .slice(0, Math.max(1, bodyRows - 3));
        // Rendered as one multi-line text node: every line is already padded to
        // the frame, so there is no per-row identity to key a list with.
        const previewText = previewLines.join('\n');
        const skipReasons = [
          ...new Set(
            state.plan.skipped
              .map((target) => target.lockedReason)
              .filter((reason): reason is LockReason => reason !== null),
          ),
        ].map((reason) => tr.lockReason(reason));
        return (
          <Box
            flexDirection="column"
            width={columns}
            height={bodyRows}
            borderStyle="round"
            borderColor={theme.plain ? undefined : theme.colors.primary}
            paddingX={1}
            overflow="hidden"
          >
            <Text {...textStyle(theme, theme.colors.primary, { bold: true })} wrap="truncate-end">
              {empty
                ? tr.t('preview.nothingSelected')
                : tr.t('preview.subtitle', {
                    count: state.plan.targets.length,
                    bytes: formatBytes(state.plan.totalBytes),
                  })}
            </Text>
            {previewText.length > 0 ? (
              <Text {...textStyle(theme, theme.colors.muted)} wrap="truncate-end">
                {previewText}
              </Text>
            ) : null}
            {skipReasons.length > 0 ? (
              <Text {...textStyle(theme, theme.colors.dim, { dim: true })} wrap="truncate-end">
                {tr.t('lock.explanation', { reasons: tr.list(skipReasons) })}
              </Text>
            ) : null}
          </Box>
        );
      }

      case 'confirm': {
        const dangerCount = state.plan.targets.filter(
          (target) => target.risk === 'medium' || target.risk === 'high',
        ).length;
        return (
          <ConfirmDialog
            title={tr.t('confirm.title')}
            targetCount={state.plan.targets.length}
            totalBytes={state.plan.totalBytes}
            lockedSkippedCount={state.plan.skipped.length}
            dangerCount={dangerCount}
            theme={theme}
            width={columns}
            height={bodyRows}
            labels={{
              prompt: tr.t('confirm.prompt', {
                count: state.plan.targets.length,
                bytes: formatBytes(state.plan.totalBytes),
              }),
              yes: tr.t('confirm.yes'),
              no: tr.t('confirm.no'),
              targets: fieldLabel(tr.t('unit.targets'), ['count']),
              size: tr.t('col.size'),
              danger: tr.t('col.risk'),
              skipped: tr.t('outcome.skipped'),
            }}
            previewText={formatPlanPreview(state.plan, {
              width: Math.max(20, columns - 8),
              maxRows: Math.max(1, bodyRows - 14),
            })}
          />
        );
      }

      case 'executing':
        return (
          <ExecutionView
            results={state.results}
            currentIndex={state.results.length}
            total={state.plan.targets.length}
            freedBytes={sumFreedBytes(state.results)}
            failedCount={state.results.filter((result) => result.outcome === 'failed').length}
            dryRun={state.dryRun}
            height={bodyRows}
            width={columns}
            theme={theme}
            labels={executionLabels(tr)}
            outcomeLabel={(outcome: CleanOutcome) => tr.outcome(outcome)}
          />
        );

      case 'summary':
        if (state.showDiff && state.diff !== null) {
          return (
            <DiffView
              diff={state.diff}
              limit={Math.max(1, bodyRows - 6)}
              width={columns}
              height={bodyRows}
              theme={theme}
              labels={diffLabels(tr)}
            />
          );
        }
        return (
          <ExecutionView
            results={state.execution.results}
            currentIndex={state.execution.results.length}
            total={state.total}
            freedBytes={state.execution.freedBytes}
            failedCount={state.execution.failedCount}
            dryRun={state.dryRun}
            height={bodyRows}
            width={columns}
            theme={theme}
            labels={executionLabels(tr)}
            outcomeLabel={(outcome: CleanOutcome) => tr.outcome(outcome)}
          />
        );

      case 'error':
        return (
          <Box flexDirection="column" width={columns} height={bodyRows} paddingX={1} overflow="hidden">
            <Text {...textStyle(theme, theme.colors.danger, { bold: true })} wrap="truncate-end">
              {tr.t('error.generic', { detail: state.message })}
            </Text>
          </Box>
        );

      default:
        return assertNever(state);
    }
  }

  return (
    <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
      <Header
        title={tr.t('app.name')}
        subtitle={stageSubtitle(state, tr)}
        root={root}
        version={version ?? undefined}
        theme={theme}
        width={columns}
      />
      {renderBody()}
      <Footer
        hints={hints}
        theme={theme}
        width={columns}
        message={bodyMessage}
        messageTone={state.stage === 'error' ? 'danger' : state.aborted ? 'warning' : 'info'}
      />
    </Box>
  );
}

// ===========================================================================
// V. Stage-derived presentation helpers
// ===========================================================================

/**
 * Test whether a state carries a scan report.
 *
 * @param state - Current state.
 * @returns True when `state.report` exists.
 */
function hasReport(state: AppState): state is Exclude<AppState, ScanningState | ErrorState> {
  return state.stage !== 'scanning' && state.stage !== 'error';
}

/**
 * Sum the bytes freed by a partial result list.
 *
 * @param results - Outcomes reported so far.
 * @returns Total bytes actually reclaimed.
 */
function sumFreedBytes(results: readonly CleanResult[]): number {
  let total = 0;
  for (const result of results) {
    if (result.outcome === 'deleted') total += result.freedBytes;
  }
  return total;
}

/**
 * Explain why a locked target cannot be selected.
 *
 * @param tr - Active translator.
 * @param target - The locked target the user tried to toggle.
 * @returns A localised sentence naming the lock reason.
 */
function lockedNotice(tr: Translator, target: CleanTarget): string {
  const reasons = target.lockedReason === null ? [] : [tr.lockReason(target.lockedReason)];
  return tr.t('lock.explanation', { reasons: tr.list(reasons) });
}

/**
 * The header subtitle for a stage.
 *
 * @param state - Current state.
 * @param tr - Active translator.
 * @returns A one-line description of the screen.
 */
function stageSubtitle(state: AppState, tr: Translator): string {
  switch (state.stage) {
    case 'scanning':
      return tr.t('app.tagline');
    case 'results':
      return tr.t('scan.complete', {
        duration: formatDuration(state.report.durationMs),
        count: formatCount(state.report.summary.targetCount),
        bytes: formatBytes(state.report.summary.totalBytes),
      });
    case 'preview':
      return tr.t('preview.title');
    case 'confirm':
      return tr.t('confirm.title');
    case 'executing':
      return state.dryRun ? tr.t('execute.dryRunNotice') : tr.t('execute.running');
    case 'summary':
      return tr.t('execute.done', {
        duration: formatDuration(state.execution.durationMs),
        bytes: formatBytes(state.execution.freedBytes),
      });
    case 'error':
      return tr.t('doctor.fail');
    default:
      return assertNever(state);
  }
}

/**
 * The transient footer message for a stage, if any.
 *
 * @param state - Current state.
 * @param tr - Active translator.
 * @returns The message, or undefined when the footer has none.
 */
function stageMessage(state: AppState, tr: Translator): string | undefined {
  if (state.aborted) return tr.t('error.aborted');
  switch (state.stage) {
    case 'results':
      return state.notice ?? undefined;
    case 'summary':
      // I. A comparison is a full rescan, so the footer reports the phase the
      //    second scan is in rather than leaving the screen looking frozen.
      if (state.diffPhase === 'loading') return tr.t('scan.phase.discovering');
      if (state.diffPhase === 'error') {
        return tr.t('error.generic', { detail: state.diffMessage ?? '' });
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * The key hints that are live on a stage.
 *
 * I. Ordering
 *
 * 1. Hints are ordered most useful first, because the footer is clipped from
 *    the bottom on a short terminal.
 *
 * @param state - Current state.
 * @param tr - Active translator.
 * @returns Hints for the footer.
 */
function stageHints(state: AppState, tr: Translator): readonly KeyHint[] {
  switch (state.stage) {
    case 'scanning':
    case 'executing':
      return [{ key: 'ctrl+c', label: tr.t('error.aborted') }];
    case 'results':
      if (state.quitPrompt) {
        return [
          { key: 'q', label: tr.t('tui.hint.quit') },
          { key: 'esc', label: tr.t('confirm.no') },
        ];
      }
      return [
        { key: '↑↓', label: tr.t('tui.hint.move') },
        { key: 'space', label: tr.t('tui.hint.toggle') },
        { key: 'a', label: tr.t('tui.hint.all') },
        { key: 'n', label: tr.t('tui.hint.none') },
        { key: '/', label: tr.t('tui.hint.search') },
        { key: 'f', label: tr.t('tui.hint.filter') },
        { key: 's', label: tr.t('tui.hint.sort') },
        { key: 'd', label: tr.t('tui.hint.preview') },
        { key: 'q', label: tr.t('tui.hint.quit') },
      ];
    case 'preview':
      return state.plan.targets.length === 0
        ? [{ key: 'esc', label: tr.t('confirm.no') }]
        : [
            { key: 'y', label: tr.t('confirm.yes') },
            { key: 'esc', label: tr.t('confirm.no') },
          ];
    case 'confirm':
      return [
        { key: 'y', label: tr.t('confirm.yes') },
        { key: 'esc', label: tr.t('confirm.no') },
      ];
    case 'summary':
      return [
        { key: 'd', label: tr.t('report.diff.title') },
        { key: 'q', label: tr.t('tui.hint.quit') },
      ];
    case 'error':
      return [{ key: 'q', label: tr.t('tui.hint.quit') }];
    default:
      return [];
  }
}

/**
 * Localised labels for the execution feed.
 *
 * I. Why two of them are derived
 *
 * 1. The component composes `freed <bytes>` itself and the table has no bare
 *    "freed" noun, so the closest available token is used; the same applies to
 *    the completion word. Both are documented gaps rather than literals.
 *
 * @param tr - Active translator.
 * @returns The label set for {@link ExecutionView}.
 */
function executionLabels(tr: Translator): {
  readonly running: string;
  readonly done: string;
  readonly dryRun: string;
  readonly deleted: string;
  readonly skipped: string;
  readonly failed: string;
  readonly freed: string;
} {
  return {
    running: tr.t('execute.running'),
    done: tr.t('doctor.pass'),
    dryRun: tr.t('execute.dryRunNotice'),
    deleted: tr.t('outcome.deleted'),
    skipped: tr.t('outcome.skipped'),
    failed: tr.t('outcome.failed'),
    freed: tr.t('col.size'),
  };
}

/**
 * Localised labels for the report comparison.
 *
 * @param tr - Active translator.
 * @returns The label set for {@link DiffView}.
 */
function diffLabels(tr: Translator): {
  readonly net: string;
  readonly grew: string;
  readonly shrank: string;
  readonly added: string;
  readonly removed: string;
  readonly noChange: string;
  readonly from: string;
  readonly to: string;
} {
  return {
    net: fieldLabel(tr.t('report.diff.net'), ['delta']),
    grew: tr.t('report.diff.grew'),
    shrank: tr.t('report.diff.shrank'),
    added: tr.t('report.diff.added'),
    removed: tr.t('report.diff.removed'),
    noChange: tr.t('report.diff.noChange'),
    // The table has no directional nouns; the range line's arrow carries the
    // direction, and the two totals stay legible without an English literal.
    from: tr.t('col.size'),
    to: tr.t('col.size'),
  };
}
