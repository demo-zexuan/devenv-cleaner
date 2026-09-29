/**
 * TUI Component Barrel
 *
 * The single import surface for the presentational layer. The container owns
 * state, keys and lifecycle; everything it renders comes from here.
 *
 * I. What this module promises
 *
 * 1. Every export is pure: props in, JSX out. No component in this barrel reads
 *    the filesystem, touches `process`, installs an input handler or a timer, or
 *    reaches for the i18n runtime — every human-readable string arrives as a prop
 *    or as a prop-provided resolver.
 * 2. The theme travels with the components, because a component without its
 *    theme cannot know whether colour is allowed.
 *
 * II. Ordering
 *
 * 1. Entries are alphabetical by module, and the specifiers inside each entry are
 *    alphabetical too. Module paths are the one stable identifier here, so
 *    ordering by screen position would have to be re-derived every time a screen
 *    moved; ordering by path makes a missing export visible by inspection.
 * 2. Extra helpers that belong to a component's own layout contract are exported
 *    alongside it — `targetColumnWidths` is shared by the row and the list header,
 *    so a container that renders its own header must be able to ask for the same
 *    grid.
 *
 * @module tui
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

export { ConfirmDialog, type ConfirmDialogProps } from './components/ConfirmDialog.js';
export { DiffView, type DiffViewProps } from './components/DiffView.js';
export { ExecutionView, type ExecutionViewProps } from './components/ExecutionView.js';
export { FilterBar, type FilterBarProps } from './components/FilterBar.js';
export { Footer, type FooterProps, type KeyHint } from './components/Footer.js';
export { Header, type HeaderProps } from './components/Header.js';
export { ProgressView, type ProgressViewProps } from './components/ProgressView.js';
export { SummaryPanel, type SummaryPanelProps } from './components/SummaryPanel.js';
export { TargetList, type TargetListProps } from './components/TargetList.js';
export {
  type TargetColumnLayout,
  TargetRow,
  type TargetRowProps,
  targetColumnWidths,
} from './components/TargetRow.js';
export {
  barBackground,
  barStyle,
  centre,
  chip,
  colored,
  DEFAULT_THEME,
  layerColor,
  makeTheme,
  onColor,
  riskBadge,
  riskColor,
  type TextStyle,
  type Theme,
  textStyle,
} from './theme.js';
