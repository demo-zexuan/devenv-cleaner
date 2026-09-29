/**
 * Interactive Interface Entry Point
 *
 * Mounts {@link App} with Ink, waits for it to decide its exit code, and always
 * tears the renderer down before returning.
 *
 * I. Why the app resolves the promise
 *
 * 1. Only the container knows when the interface is finished: quitting from the
 *    results screen, acknowledging a failure and closing the summary screen are
 *    three different moments, and the exit code differs between them.
 * 2. `runTui` therefore renders the app with an `onExit` callback and awaits
 *    that callback rather than awaiting Ink's own exit. Ink's `waitUntilExit`
 *    is kept as a second racer so that an unexpected teardown — a closed stdout,
 *    a signal — still resolves this function instead of hanging it.
 *
 * II. Why Ink does not own Ctrl-C
 *
 * 1. The container aborts a running scan or execution on `ctrl+c`, which means
 *    the signal must reach `useInput` rather than Ink's own handler. Rendering
 *    with `exitOnCtrlC: false` is what makes that possible; with the default,
 *    Ink would unmount the app from under the abort logic.
 *
 * III. Why this file is not JSX
 *
 * 1. It is the imperative boundary, deliberately free of markup: the element is
 *    built with `createElement` so the module stays a plain `.ts` file that the
 *    CLI can import lazily, exactly like every other command implementation.
 *
 * @module tui/run
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { render } from 'ink';
import { createElement } from 'react';

import type { ResolvedConfig } from '../core/index.js';
import type { Language } from '../i18n/index.js';
import { App } from './App.js';

/** Exit code used when the interface tears down without reporting one. */
const EXIT_OK = 0;

/** Options accepted by {@link runTui}; fixed by the CLI's call site. */
export interface RunTuiOptions {
  /** Resolved configuration the scan, the plan and the executor all share. */
  readonly config: ResolvedConfig;
  /** Language every string on screen is rendered in. */
  readonly language: Language;
  /** Whether the scan should also probe machine-global caches. */
  readonly includeGlobal: boolean;
  /** True when colour must be suppressed. */
  readonly noColor: boolean;
}

/**
 * Run the interactive interface to completion.
 *
 * @param options - Config, language, global-cache flag and colour verdict.
 * @returns `0` on success, `1` on a failed execution or fatal scan error, and
 *   `130` when the user interrupted the run.
 *
 * @example
 * ```ts
 * const code = await runTui({ config, language: 'en', includeGlobal: false, noColor: false })
 * process.exitCode = code
 * ```
 */
export async function runTui(options: RunTuiOptions): Promise<number> {
  let resolveExit: (code: number) => void = () => undefined;
  const completion = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const instance = render(
    createElement(App, {
      config: options.config,
      language: options.language,
      includeGlobal: options.includeGlobal,
      noColor: options.noColor,
      onExit: (code: number) => {
        resolveExit(code);
      },
    }),
    { exitOnCtrlC: false },
  );

  try {
    // I. Either the app reports its outcome, or Ink tears down first; the race
    //    makes both paths terminate.
    return await Promise.race([completion, instance.waitUntilExit().then(() => EXIT_OK)]);
  } finally {
    // II. Unmounting restores the terminal: raw mode off, cursor shown, and the
    //     alternate buffer left if one was entered.
    instance.unmount();
  }
}
