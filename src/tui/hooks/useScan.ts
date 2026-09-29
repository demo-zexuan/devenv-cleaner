/**
 * Scan Driver Hook
 *
 * Owns one scan's lifecycle for the interactive interface: canonicalising the
 * roots, calling `scan()`, forwarding a throttled stream of progress samples,
 * and guaranteeing that an aborted or unmounted scan can never write state.
 *
 * I. Why the throttle exists
 *
 * 1. The scanner emits a progress sample from inside its directory walk, which
 *    on a large home directory means hundreds of samples per second. Calling
 *    `setState` for each of them starves React and the terminal writer, and the
 *    interface stops responding to keys long before the scan finishes.
 * 2. Rendering progress is a *display* concern with a human frame rate, not a
 *    data concern. Ten updates per second is indistinguishable from continuous
 *    motion for a phase bar and a pair of counters, so the newest sample is
 *    kept in a ref and flushed at most every {@link PROGRESS_INTERVAL_MS}.
 * 3. The first sample of a burst is rendered immediately, so a scan that emits
 *    one sample and then stalls still shows that sample; only the *subsequent*
 *    samples wait for the trailing edge.
 *
 * II. Why the hook reports rather than stores the result
 *
 * 1. The report is an input to the stage machine, which owns it from the moment
 *    it exists. Keeping a second copy here would create two sources of truth
 *    for "what was scanned", and the two would disagree the moment the machine
 *    moved on to a plan built from the earlier report.
 * 2. The hook therefore calls `onComplete` with the report and forgets it. Every
 *    callback is held in a ref that is refreshed after each render, so the
 *    callback the scan actually invokes is always the current one even though
 *    the async loop captured the function that existed when it started.
 *
 * III. Cancellation
 *
 * 1. `abort()` aborts the `AbortController` the scanner was given. The scanner
 *    treats an abort as "return what you have", so a cancelled scan still
 *    produces a partial report and still calls `onComplete` — the container
 *    shows whatever was found instead of discarding the work.
 * 2. The hook also aborts on unmount and clears its pending progress timer, and
 *    it checks a mounted flag before every `setState`. A sample that arrives
 *    after the interface has been torn down is dropped rather than rendered.
 *
 * @module tui/hooks/useScan
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  canonicalizeRoots,
  scan as coreScan,
  type ResolvedConfig,
  type ScanOptions,
  type ScanProgress,
  type ScanReport,
} from '../../core/index.js';

/** A scanner, structurally identical to the engine's `scan`. */
export type ScanFn = (options: ScanOptions) => Promise<ScanReport>;

/** Where a scan currently is, from this hook's point of view. */
export type ScanPhase = 'idle' | 'running' | 'done' | 'failed';

/** Interval between two progress renders, in milliseconds (~10 fps). */
const PROGRESS_INTERVAL_MS = 100;

/** Options accepted by {@link useScan}. */
export interface UseScanOptions {
  /**
   * Scanner implementation.
   *
   * Injected so the container can be driven headless in tests without touching
   * a filesystem; production code leaves it out and gets the engine's own
   * `scan`.
   */
  readonly scan?: ScanFn;
  /** Configured roots, canonicalised by the hook before the scan starts. */
  readonly roots: readonly string[];
  /** Resolved configuration in effect. */
  readonly config: ResolvedConfig;
  /** Whether machine-global caches should be probed as well. */
  readonly includeGlobalTargets: boolean;
  /** Called with the report the scan produced; partial when it was aborted. */
  readonly onComplete: (report: ScanReport) => void;
  /** Called when the scan threw, with a human-readable message. */
  readonly onError: (message: string) => void;
  /** Start as soon as the hook mounts; defaults to false. */
  readonly autoStart?: boolean;
}

/** What {@link useScan} hands back to the container. */
export interface UseScanResult {
  /** Newest progress sample, throttled to roughly ten renders per second. */
  readonly progress: ScanProgress | null;
  /** Current phase of the scan. */
  readonly phase: ScanPhase;
  /** Start a scan; a second call while one is running is ignored. */
  readonly start: () => void;
  /** Ask the running scan to stop; it still reports what it found. */
  readonly abort: () => void;
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
 * Drive one scan and expose its progress.
 *
 * I. Sequencing
 *
 * 1. Roots are canonicalised first. The planner and the executor both re-check
 *    containment against resolved roots, so scanning a raw, symlink-aliased
 *    root would discover targets the executor later refuses as `outside-root`
 *    — the "scan finds everything, cleanup does nothing" failure.
 * 2. Only then is `scan()` called, with the abort signal and the throttled
 *    progress handler attached.
 *
 * II. Failure policy
 *
 * 1. A throw is reported through `onError` as a message rather than a value:
 *    the container puts it on the error screen, and an `unknown` must not leak
 *    into React state.
 * 2. An abort is *not* a failure. The scanner returns a partial report for an
 *    aborted signal, so the abort path goes through `onComplete` exactly like a
 *    normal finish.
 * 3. A scan that neither completes nor fails because the signal aborted before
 *    the walk began still calls `onComplete` with the empty partial report the
 *    scanner produced, so the interface can never be stranded on the progress
 *    screen.
 *
 * @param options - Scanner, roots, config and the two report callbacks.
 * @returns The throttled progress plus `start` and `abort` controls.
 *
 * @example
 * ```tsx
 * const { progress, start, abort } = useScan({
 *   roots: config.roots,
 *   config,
 *   includeGlobalTargets: false,
 *   onComplete: (report) => dispatch({ type: 'scan-complete', report }),
 *   onError: (message) => dispatch({ type: 'scan-failed', message }),
 *   autoStart: true,
 * })
 * ```
 */
export function useScan(options: UseScanOptions): UseScanResult {
  const { roots, config, includeGlobalTargets, autoStart = false } = options;
  const scanner = options.scan ?? coreScan;

  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [phase, setPhase] = useState<ScanPhase>('idle');

  // I. Latest-value refs. The callbacks are re-read on every render so the async
  //    loop always reaches the current container handler, not the one that
  //    happened to be in scope when `start` was called.
  const completeRef = useRef(options.onComplete);
  const errorRef = useRef(options.onError);
  useEffect(() => {
    completeRef.current = options.onComplete;
    errorRef.current = options.onError;
  });

  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  // II. Throttle bookkeeping: the newest unrendered sample, the pending trailing
  //     flush, and the timestamp of the last render.
  const latestRef = useRef<ScanProgress | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushRef = useRef(0);

  const clearPendingFlush = useCallback((): void => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const handleProgress = useCallback((sample: ScanProgress): void => {
    latestRef.current = sample;

    // (1) A trailing flush is already scheduled: it will pick up this sample.
    if (timerRef.current !== null) return;

    // (2) Leading edge of a burst: render now.
    const now = Date.now();
    if (now - lastFlushRef.current >= PROGRESS_INTERVAL_MS) {
      lastFlushRef.current = now;
      setProgress(sample);
      return;
    }

    // (3) Trailing edge: one render, with whatever is newest by then.
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = latestRef.current;
      if (pending === null || !mountedRef.current) return;
      lastFlushRef.current = Date.now();
      setProgress(pending);
    }, PROGRESS_INTERVAL_MS);
  }, []);

  const abort = useCallback((): void => {
    controllerRef.current?.abort();
  }, []);

  const start = useCallback((): void => {
    if (runningRef.current) return;
    runningRef.current = true;

    const controller = new AbortController();
    controllerRef.current = controller;
    setPhase('running');
    lastFlushRef.current = 0;

    void (async () => {
      try {
        // I. Resolve the roots first: the engine's consecutive safety checks
        //    compare against resolved paths.
        const resolvedRoots = await canonicalizeRoots(roots);

        // II. The scanner owns abort handling: an aborted signal yields the
        //     partial report it has collected rather than throwing.
        const report = await scanner({
          roots: resolvedRoots,
          config,
          includeGlobalTargets,
          signal: controller.signal,
          onProgress: handleProgress,
        });

        if (!mountedRef.current) return;
        setPhase('done');
        completeRef.current(report);
      } catch (error) {
        // III. A throw is a failure only while the interface still exists; a
        //      teardown or an abort must not paint an error screen.
        if (!mountedRef.current || controller.signal.aborted) return;
        setPhase('failed');
        errorRef.current(describeError(error));
      } finally {
        runningRef.current = false;
      }
    })();
  }, [roots, config, includeGlobalTargets, scanner, handleProgress]);

  // III. Teardown: nothing may fire after the interface is gone.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPendingFlush();
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [clearPendingFlush]);

  // IV. Optional auto-start, expressed as an effect so it runs after mount
  //     rather than during the first render.
  useEffect(() => {
    if (!autoStart) return;
    start();
  }, [autoStart, start]);

  return { progress, phase, start, abort };
}
