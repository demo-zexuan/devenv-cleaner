/**
 * Results Selection Hook
 *
 * Owns everything the results screen remembers: which targets are selected,
 * where the cursor is, the search term, the layer filter, the sort key and the
 * grouping — plus the derived, filtered, ordered view the table renders.
 *
 * I. Why the view is derived and not stored
 *
 * 1. A stored `visible` array is a second copy of the report, and every filter
 *    change would have to remember to rebuild it in the right order. Deriving it
 *    from `(targets, query, layer, sort, group)` in one `useMemo` makes the
 *    screen a pure function of the state, so an impossible combination — a sort
 *    order that does not match its key, a cursor past the end of the list —
 *    cannot be represented.
 * 2. Focus is therefore tracked by target *id*, not by index. The index is
 *    recovered from the current view, so narrowing a filter can never leave the
 *    cursor pointing at a different row than the one the user was looking at.
 *
 * II. Selection rules
 *
 * 1. Locked targets are never selectable: the reducer refuses to add them, and
 *    the bulk actions only ever consider unlocked rows. That is a defence in
 *    depth, not the only one — the planner re-checks the same locks, so a bug
 *    here cannot delete a locked directory.
 * 2. `a` selects every *visible* unlocked row and `n` inverts the visible
 *    unlocked subset. Both respect the active filter, because the user's
 *    mental model of "everything" is what is on screen, and the filter bar
 *    already reports how many rows that is.
 * 3. Selections of rows that a filter currently hides are preserved: hiding a
 *    row is a view operation and must not silently drop a decision the user
 *    made.
 *
 * III. Scrolling
 *
 * 1. `offset` is state rather than a pure function of the cursor, because the
 *    difference between "the cursor moved to the bottom edge" and "the window
 *    jumped so the cursor is centred" is memory of where the window was.
 * 2. It is re-validated at render time against the current viewport, so a
 *    resize or a shorter filtered list can never scroll past the last row, and
 *    the focused row is always inside the window.
 *
 * @module tui/hooks/useSelection
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { useCallback, useMemo, useReducer } from 'react';

import { type CleanTarget, LAYER_ORDER, type TargetLayer } from '../../core/index.js';

/** Column the results table is ordered by. */
export type SortKey = 'size' | 'age' | 'path';

/** Axis the results table is grouped along. */
export type GroupBy = 'project' | 'layer' | 'rule';

/** Cycle order of the layer filter, `all` first so one press clears it. */
const FILTER_ORDER: readonly (TargetLayer | 'all')[] = ['all', ...LAYER_ORDER];

/** Cycle order of the sort key. */
const SORT_ORDER: readonly SortKey[] = ['size', 'age', 'path'];

/** Cycle order of the grouping. */
const GROUP_ORDER: readonly GroupBy[] = ['project', 'layer', 'rule'];

/** Rank of each layer, used to keep a layer grouping in display order. */
const LAYER_RANK: ReadonlyMap<TargetLayer, number> = new Map(
  LAYER_ORDER.map((layer, index) => [layer, index] as const),
);

/** Everything {@link useSelection} remembers between renders. */
interface SelectionState {
  /** Ids of the selected targets. */
  readonly selectedIds: ReadonlySet<string>;
  /** Id of the row holding the cursor, or null before the first move. */
  readonly focusedId: string | null;
  /** Search term; empty when nothing is filtered by text. */
  readonly query: string;
  /** True while typed characters belong to the search field. */
  readonly searchActive: boolean;
  /** Active layer filter. */
  readonly activeLayer: TargetLayer | 'all';
  /** Active sort key. */
  readonly sortKey: SortKey;
  /** Active grouping. */
  readonly groupBy: GroupBy;
  /** First row of the viewport, as of the last cursor move. */
  readonly offset: number;
}

/** Transitions the results screen can perform. */
type SelectionAction =
  | { readonly type: 'toggle'; readonly id: string }
  | { readonly type: 'select-all'; readonly ids: readonly string[] }
  | { readonly type: 'invert'; readonly ids: readonly string[] }
  | { readonly type: 'focus'; readonly id: string; readonly index: number; readonly viewport: number }
  | { readonly type: 'append-query'; readonly text: string }
  | { readonly type: 'backspace-query' }
  | { readonly type: 'search'; readonly active: boolean; readonly clear: boolean }
  | { readonly type: 'cycle-layer' }
  | { readonly type: 'cycle-sort' }
  | { readonly type: 'cycle-group' };

/** Initial state: nothing selected, nothing filtered, cursor on the first row. */
const INITIAL_STATE: SelectionState = {
  selectedIds: new Set<string>(),
  focusedId: null,
  query: '',
  searchActive: false,
  activeLayer: 'all',
  sortKey: 'size',
  groupBy: 'project',
  offset: 0,
};

/**
 * Advance a cycle by one position.
 *
 * @param order - The cycle, in display order.
 * @param current - Current member of the cycle.
 * @returns The next member, wrapping at the end.
 */
function nextInCycle<T extends string>(order: readonly T[], current: T): T {
  const index = order.indexOf(current);
  const next = order[(index + 1) % order.length];
  return next ?? order[0] ?? current;
}

/**
 * Drop view state that a filter change invalidates.
 *
 * A new filter produces a different list, so the old cursor and scroll offset
 * describe rows that may no longer exist; resetting both is the only honest
 * transition.
 *
 * @param state - State before the filter change.
 * @param patch - Fields the caller is changing.
 * @returns The patched state with the cursor and offset reset.
 */
function afterFilterChange(state: SelectionState, patch: Partial<SelectionState>): SelectionState {
  return { ...state, ...patch, focusedId: null, offset: 0 };
}

/**
 * The results-screen reducer.
 *
 * @param state - Current state.
 * @param action - Transition to apply.
 * @returns The next state; the same object when the action changes nothing.
 */
function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'toggle': {
      // I. Copy-on-write: React compares the Set by identity.
      const selected = new Set(state.selectedIds);
      if (selected.has(action.id)) selected.delete(action.id);
      else selected.add(action.id);
      return { ...state, selectedIds: selected };
    }

    case 'select-all': {
      const selected = new Set(state.selectedIds);
      for (const id of action.ids) selected.add(id);
      return { ...state, selectedIds: selected };
    }

    case 'invert': {
      const selected = new Set(state.selectedIds);
      for (const id of action.ids) {
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
      }
      return { ...state, selectedIds: selected };
    }

    case 'focus': {
      // I. Minimal scroll: the window shifts only when the cursor would leave
      //    it, which keeps a one-row move from re-painting the whole table.
      let offset = state.offset;
      if (action.index < offset) offset = action.index;
      if (action.index >= offset + action.viewport) offset = action.index - action.viewport + 1;
      return { ...state, focusedId: action.id, offset: Math.max(0, offset) };
    }

    case 'append-query':
      return afterFilterChange(state, { query: `${state.query}${action.text}` });

    case 'backspace-query':
      return afterFilterChange(state, { query: state.query.slice(0, -1) });

    case 'search':
      // Cancelling clears the term; committing keeps it and returns focus to
      // the list, which is what makes Enter feel like "apply".
      return action.clear
        ? afterFilterChange(state, { searchActive: action.active, query: '' })
        : { ...state, searchActive: action.active };

    case 'cycle-layer':
      return afterFilterChange(state, { activeLayer: nextInCycle(FILTER_ORDER, state.activeLayer) });

    case 'cycle-sort':
      return { ...state, sortKey: nextInCycle(SORT_ORDER, state.sortKey) };

    case 'cycle-group':
      return { ...state, groupBy: nextInCycle(GROUP_ORDER, state.groupBy) };
  }
}

/**
 * Test whether a target matches the search term.
 *
 * I. Why three fields
 *
 * 1. A user searching for a directory types a path fragment; one searching for
 *    a category types a rule label or a project name. Matching all three means
 *    one field answers both without a syntax for "which field".
 *
 * @param target - Candidate row.
 * @param needle - Lower-cased, trimmed search term.
 * @returns True when the target should stay visible.
 */
function matchesQuery(target: CleanTarget, needle: string): boolean {
  if (target.path.toLowerCase().includes(needle)) return true;
  if (target.label.toLowerCase().includes(needle)) return true;
  return target.projectName?.toLowerCase().includes(needle) === true;
}

/**
 * Order two targets by the active sort key alone.
 *
 * @param left - First target.
 * @param right - Second target.
 * @param sortKey - Active sort key.
 * @returns Non-zero when the key already decides the order.
 */
function comparePrimary(left: CleanTarget, right: CleanTarget, sortKey: SortKey): number {
  if (sortKey === 'size') return right.bytes - left.bytes;
  if (sortKey === 'age') return right.ageDays - left.ageDays;
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

/**
 * Compare two targets by the active sort key, with a stable tie-break.
 *
 * @param left - First target.
 * @param right - Second target.
 * @param sortKey - Active sort key.
 * @returns Negative, zero or positive, per `Array.prototype.sort`.
 */
function compareBySort(left: CleanTarget, right: CleanTarget, sortKey: SortKey): number {
  const primary = comparePrimary(left, right, sortKey);
  if (primary !== 0) return primary;
  // The path and id tie-breaks keep two equal values in a deterministic order,
  // so the list never reshuffles between two identical renders.
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/**
 * The group a target belongs to under one grouping.
 *
 * @param target - Row being grouped.
 * @param groupBy - Active grouping.
 * @returns A sortable group key; grouping by layer uses the layer's rank so the
 *   groups stay in lifecycle order rather than alphabetical.
 */
function groupKey(target: CleanTarget, groupBy: GroupBy): string {
  switch (groupBy) {
    case 'project':
      return target.projectName ?? '';
    case 'layer':
      return String(LAYER_RANK.get(target.layer) ?? LAYER_ORDER.length).padStart(2, '0');
    case 'rule':
      return target.ruleId;
  }
}

/**
 * Filter and order the report's targets for display.
 *
 * @param targets - Every target in the report.
 * @param query - Search term.
 * @param activeLayer - Layer filter.
 * @param sortKey - Sort key inside a group.
 * @param groupBy - Grouping axis.
 * @returns A new array, filtered then grouped then sorted.
 */
function buildView(
  targets: readonly CleanTarget[],
  query: string,
  activeLayer: TargetLayer | 'all',
  sortKey: SortKey,
  groupBy: GroupBy,
): CleanTarget[] {
  const needle = query.trim().toLowerCase();
  const filtered = targets.filter((target) => {
    if (activeLayer !== 'all' && target.layer !== activeLayer) return false;
    return needle.length === 0 || matchesQuery(target, needle);
  });

  return filtered.sort((left, right) => {
    const leftGroup = groupKey(left, groupBy);
    const rightGroup = groupKey(right, groupBy);
    if (leftGroup !== rightGroup) return leftGroup < rightGroup ? -1 : 1;
    return compareBySort(left, right, sortKey);
  });
}

/**
 * Bring the focused row inside the viewport.
 *
 * I. Why this runs at render time as well as on a move
 *
 * 1. A resize changes the viewport without any cursor action, and a filter can
 *    shorten the list under a cursor that never moved. Re-validating here makes
 *    both cases correct without a synchronising effect.
 *
 * @param offset - Scroll offset recorded by the last cursor move.
 * @param focusedIndex - Index of the focused row in the view.
 * @param viewport - Rows the table can show.
 * @param total - Rows in the view.
 * @returns A scroll offset that keeps the focused row visible.
 */
function resolveOffset(offset: number, focusedIndex: number, viewport: number, total: number): number {
  if (total === 0) return 0;
  const rows = Math.max(1, viewport);
  const maxOffset = Math.max(0, total - rows);
  let next = Math.min(Math.max(0, offset), maxOffset);
  if (focusedIndex < next) next = focusedIndex;
  if (focusedIndex >= next + rows) next = focusedIndex - rows + 1;
  return Math.min(Math.max(0, next), maxOffset);
}

/** What {@link useSelection} hands to the results screen. */
export interface UseSelectionResult {
  /** Rows to render, filtered, grouped and sorted. */
  readonly visible: readonly CleanTarget[];
  /** Selected ids. */
  readonly selectedIds: ReadonlySet<string>;
  /** Number of selected targets, including rows the filter hides. */
  readonly selectedCount: number;
  /** Total selected bytes. */
  readonly selectedBytes: number;
  /** Index of the focused row inside `visible`. */
  readonly focusedIndex: number;
  /** The focused row, or null when the view is empty. */
  readonly focusedTarget: CleanTarget | null;
  /** First visible row. */
  readonly offset: number;
  /** Current search term. */
  readonly query: string;
  /** True while typed characters are routed to the search field. */
  readonly searchActive: boolean;
  /** Active layer filter. */
  readonly activeLayer: TargetLayer | 'all';
  /** Active sort key. */
  readonly sortKey: SortKey;
  /** Active grouping. */
  readonly groupBy: GroupBy;
  /** True when rows should lead with a project label. */
  readonly showProject: boolean;
  /** Move the cursor by `delta` rows, clamped to the view. */
  readonly move: (delta: number) => void;
  /** Toggle the focused target; ignored when it is locked. */
  readonly toggle: (target: CleanTarget) => void;
  /** Select every visible unlocked target. */
  readonly selectAllUnlocked: () => void;
  /** Invert the selection across the visible unlocked targets. */
  readonly invertSelection: () => void;
  /** Route typed characters to the search field. */
  readonly enterSearch: () => void;
  /** Leave search mode; committing keeps the term, cancelling clears it. */
  readonly exitSearch: (commit: boolean) => void;
  /** Append typed characters to the search term. */
  readonly appendQuery: (text: string) => void;
  /** Remove the last character of the search term. */
  readonly backspaceQuery: () => void;
  /** Advance the layer filter. */
  readonly cycleLayer: () => void;
  /** Advance the sort key. */
  readonly cycleSort: () => void;
  /** Advance the grouping. */
  readonly cycleGroup: () => void;
}

/**
 * Own the results screen's selection and view state.
 *
 * @param targets - Every target in the report.
 * @param viewportRows - Rows the table can show, used to keep the cursor visible.
 * @returns The derived view plus the state transitions the key map needs.
 *
 * @example
 * ```tsx
 * const selection = useSelection(report.targets, listRows)
 * selection.move(1)
 * selection.toggle(selection.focusedTarget)
 * ```
 */
export function useSelection(targets: readonly CleanTarget[], viewportRows: number): UseSelectionResult {
  const [state, dispatch] = useReducer(selectionReducer, INITIAL_STATE);

  // I. The view is a pure function of the report and the filter state.
  const visible = useMemo(
    () => buildView(targets, state.query, state.activeLayer, state.sortKey, state.groupBy),
    [targets, state.query, state.activeLayer, state.sortKey, state.groupBy],
  );

  // II. Focus is recovered from the id, so a filter that hides the focused row
  //     falls back to the first row rather than to a stale index.
  const focusedIndex = useMemo(() => {
    if (visible.length === 0) return 0;
    if (state.focusedId === null) return 0;
    const index = visible.findIndex((target) => target.id === state.focusedId);
    return index >= 0 ? index : 0;
  }, [visible, state.focusedId]);

  const focusedTarget = visible.length === 0 ? null : (visible[focusedIndex] ?? null);

  const offset = useMemo(
    () => resolveOffset(state.offset, focusedIndex, viewportRows, visible.length),
    [state.offset, focusedIndex, viewportRows, visible.length],
  );

  const { selectedCount, selectedBytes } = useMemo(() => {
    let count = 0;
    let bytes = 0;
    for (const target of targets) {
      if (!state.selectedIds.has(target.id)) continue;
      count += 1;
      bytes += target.bytes;
    }
    return { selectedCount: count, selectedBytes: bytes };
  }, [targets, state.selectedIds]);

  const move = useCallback(
    (delta: number): void => {
      if (visible.length === 0) return;
      const index = Math.min(visible.length - 1, Math.max(0, focusedIndex + delta));
      const target = visible[index];
      if (target === undefined) return;
      dispatch({ type: 'focus', id: target.id, index, viewport: Math.max(1, viewportRows) });
    },
    [visible, focusedIndex, viewportRows],
  );

  const toggle = useCallback((target: CleanTarget): void => {
    // Locked rows are inert; the container explains why in the footer.
    if (target.locked) return;
    dispatch({ type: 'toggle', id: target.id });
  }, []);

  const selectAllUnlocked = useCallback((): void => {
    dispatch({
      type: 'select-all',
      ids: visible.filter((target) => !target.locked).map((target) => target.id),
    });
  }, [visible]);

  const invertSelection = useCallback((): void => {
    dispatch({
      type: 'invert',
      ids: visible.filter((target) => !target.locked).map((target) => target.id),
    });
  }, [visible]);

  const enterSearch = useCallback((): void => {
    dispatch({ type: 'search', active: true, clear: false });
  }, []);

  const exitSearch = useCallback((commit: boolean): void => {
    dispatch({ type: 'search', active: false, clear: !commit });
  }, []);

  const appendQuery = useCallback((text: string): void => {
    dispatch({ type: 'append-query', text });
  }, []);

  const backspaceQuery = useCallback((): void => {
    dispatch({ type: 'backspace-query' });
  }, []);

  const cycleLayer = useCallback((): void => {
    dispatch({ type: 'cycle-layer' });
  }, []);

  const cycleSort = useCallback((): void => {
    dispatch({ type: 'cycle-sort' });
  }, []);

  const cycleGroup = useCallback((): void => {
    dispatch({ type: 'cycle-group' });
  }, []);

  return {
    visible,
    selectedIds: state.selectedIds,
    selectedCount,
    selectedBytes,
    focusedIndex,
    focusedTarget,
    offset,
    query: state.query,
    searchActive: state.searchActive,
    activeLayer: state.activeLayer,
    sortKey: state.sortKey,
    groupBy: state.groupBy,
    showProject: state.groupBy === 'project',
    move,
    toggle,
    selectAllUnlocked,
    invertSelection,
    enterSearch,
    exitSearch,
    appendQuery,
    backspaceQuery,
    cycleLayer,
    cycleSort,
    cycleGroup,
  };
}
