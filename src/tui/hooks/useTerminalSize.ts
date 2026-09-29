/**
 * Terminal Size Hook
 *
 * Reports the live `{ columns, rows }` of the output stream and keeps it in
 * step with resize events, so the container can lay the interface out to the
 * terminal it actually has instead of to a hard-coded 80×24.
 *
 * I. Why this is a hook and not a constant
 *
 * 1. Every screen in the interface is a fixed-height column of panels whose
 *    rows are budgeted by hand. A resize that is not observed therefore does
 *    not merely look stale — it makes the budget wrong, and the frame either
 *    overflows the viewport or leaves a block of dead space above the footer.
 * 2. The container owns the arithmetic; this hook owns only the measurement,
 *    so there is exactly one place that knows how to read a stream size and
 *    one place that decides what to do with it.
 *
 * II. Degradation
 *
 * 1. A stream that reports nothing (`undefined` columns or rows, which is the
 *    normal case in a headless test double and in a piped output) falls back
 *    to a conventional 80×24 rather than to zero. A zero-width frame would
 *    collapse every panel and render an empty screen, which is the least
 *    debuggable possible failure.
 * 2. Both dimensions are floored at a usable minimum. Below roughly twenty
 *    columns no table survives, and a frame shorter than a header and a footer
 *    has nothing left to render, so clamping here keeps every downstream
 *    subtraction non-negative.
 *
 * III. Lifecycle
 *
 * 1. `resize` is a normal stream event, so the listener is attached to the
 *    stdout Ink hands the app (`useStdout`), never to `process.stdout`. That
 *    is what makes the hook correct under Ink's test renderer, which supplies
 *    its own stream.
 * 2. The listener is removed on unmount, and the state is re-read whenever the
 *    stream identity changes, so a remount cannot keep a stale size.
 *
 * @module tui/hooks/useTerminalSize
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

/** The viewport an interface is laid out against. */
export interface TerminalSize {
  /** Usable width in columns. */
  readonly columns: number;
  /** Usable height in rows. */
  readonly rows: number;
}

/** Width assumed when the stream does not report one. */
const DEFAULT_COLUMNS = 80;

/** Height assumed when the stream does not report one. */
const DEFAULT_ROWS = 24;

/** Narrowest layout the interface still attempts to draw. */
const MIN_COLUMNS = 20;

/** Shortest layout that can hold a header, a body and a footer. */
const MIN_ROWS = 8;

/** The subset of a stream this hook reads; kept structural for test doubles. */
interface SizeSource {
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
}

/**
 * Read a stream's current size, clamped to the usable minimum.
 *
 * @param source - Stream, or a test double that mimics one.
 * @returns The size to lay the interface out against.
 */
function readSize(source: SizeSource | undefined): TerminalSize {
  const columns = Math.floor(source?.columns ?? DEFAULT_COLUMNS);
  const rows = Math.floor(source?.rows ?? DEFAULT_ROWS);
  return {
    columns: Math.max(MIN_COLUMNS, Number.isFinite(columns) && columns > 0 ? columns : DEFAULT_COLUMNS),
    rows: Math.max(MIN_ROWS, Number.isFinite(rows) && rows > 0 ? rows : DEFAULT_ROWS),
  };
}

/**
 * Observe the output stream's size.
 *
 * @returns The current terminal size, updated on every `resize` event.
 *
 * @example
 * ```tsx
 * const { columns, rows } = useTerminalSize()
 * const listRows = rows - HEADER_ROWS - SUMMARY_ROWS - FOOTER_ROWS
 * ```
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => readSize(stdout));

  useEffect(() => {
    // I. Re-read on mount and whenever Ink swaps the stream underneath us: the
    //    initial state was computed from the stream that existed at first
    //    render, which is not necessarily this one.
    setSize(readSize(stdout));

    // II. A resize is a stream event, so the handler is a plain callback; the
    //     `resize` emitter lives on Ink's stdout, not on `process.stdout`.
    const handleResize = (): void => {
      setSize(readSize(stdout));
    };
    stdout?.on('resize', handleResize);
    return () => {
      stdout?.off('resize', handleResize);
    };
  }, [stdout]);

  return size;
}
