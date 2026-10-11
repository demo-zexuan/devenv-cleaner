/**
 * Interactive Interface Integration Test
 *
 * Drives the real container through the full stage machine against a real
 * directory tree and key input, rather than asserting on components in
 * isolation.
 *
 * I. What this file is actually protecting
 *
 * 1. The single most important promise of this product is that **reviewing a
 *    plan never deletes anything**. That property spans the container, the
 *    reducer, the planner and the executor at once, so no unit test can state
 *    it: it is only observable by pressing the keys and looking at the disk.
 * 2. The second promise is that the destructive key is live on exactly one
 *    screen. The test therefore asserts that `y` on the dry-run preview moves to
 *    the confirmation dialog *and that the tree is untouched at that moment*,
 *    then that a second `y` is what actually removes bytes.
 * 3. Fixtures live under `tests/.fixtures` rather than `os.tmpdir()` on purpose:
 *    on macOS `$TMPDIR` canonicalises through `/private/var/folders`, and the
 *    safety checks rightly treat a different set of paths as protected there.
 *
 * @module tests/tui
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalizeRoots } from '../src/core/platform.js';
import { getDefaultConfig, resolveConfig } from '../src/rules/config.js';
import { App } from '../src/tui/App.js';
import { createFixtureRoot, removeFixtureRoot } from './helpers.js';

/** The ANSI escape introducer, built from its code point to avoid a literal. */
const ESCAPE = String.fromCharCode(27);

/** Matches a colour escape sequence. */
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\\\[[0-9;]*m`, 'g');

/** Remove colour so frames compare as plain text. */
function strip(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

/** Yield to the event loop for a moment. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('interactive interface', () => {
  let root = '';
  let projectRoot = '';

  beforeEach(async () => {
    root = await createFixtureRoot('tui');
    projectRoot = join(root, 'shop-web');
    await mkdir(join(projectRoot, 'node_modules', 'lodash'), { recursive: true });
    await mkdir(join(projectRoot, 'node_modules', 'react'), { recursive: true });
    await mkdir(join(projectRoot, 'dist'), { recursive: true });
    await writeFile(join(projectRoot, 'package.json'), '{"name":"shop-web"}');
    // npm always writes this, and its presence is what clears the rule's
    // entry-count guard on a real install.
    await writeFile(join(projectRoot, 'node_modules', '.package-lock.json'), '{}');
    await writeFile(join(projectRoot, 'node_modules', 'lodash', 'index.js'), Buffer.alloc(6_000_000));
    await writeFile(join(projectRoot, 'node_modules', 'react', 'index.js'), Buffer.alloc(2_000_000));
    await writeFile(join(projectRoot, 'dist', 'bundle.js'), Buffer.alloc(3_000_000));
  });

  afterEach(async () => {
    if (root.length > 0) await removeFixtureRoot(root);
  });

  it('walks scan → results → preview → confirm → execute without deleting early', async () => {
    const roots = await canonicalizeRoots([root]);
    const config = resolveConfig({ ...getDefaultConfig(), roots, maxDepth: 6, minSizeBytes: 0 }, null);

    let exitCode: number | null = null;
    // `createElement` rather than JSX so this stays a `.ts` file and the test
    // include pattern does not have to special-case `.tsx`.
    const { lastFrame, stdin, unmount } = render(
      createElement(App, {
        config,
        language: 'en',
        includeGlobal: false,
        noColor: true,
        onExit: (code: number) => {
          exitCode = code;
        },
      }),
    );

    /**
     * Poll the rendered frame until it carries a marker.
     *
     * Polling rather than sleeping a fixed amount is what keeps this test honest
     * across a fast laptop and a slow CI runner: the assertion is about the
     * screen's content, not about how long a scan happened to take.
     */
    const waitFor = async (pattern: RegExp, label: string, timeoutMs = 20_000): Promise<string> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const frame = strip(lastFrame() ?? '');
        if (pattern.test(frame)) return frame;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}:\n${frame}`);
        await settle(120);
      }
    };

    try {
      // I. The scan completes and lists the fixture's real targets.
      const results = await waitFor(/shop-web/, 'the results screen');
      expect(results).toContain('node_modules');

      // II. Select everything, then open the dry-run preview.
      stdin.write('a');
      await settle(500);
      stdin.write('d');
      await waitFor(/Cleanup preview/i, 'the dry-run preview');

      // III. The preview's own key must NOT delete: it advances to the
      //      confirmation dialog and the tree is still intact at that point.
      stdin.write('y');
      await waitFor(/Confirm deletion/i, 'the confirmation dialog');
      const beforeConfirm = await readdir(projectRoot);
      expect(beforeConfirm).toContain('dist');
      expect(beforeConfirm).toContain('node_modules');

      // IV. Only the confirmation's key deletes.
      stdin.write('y');
      await waitFor(/Freed|freed|Deleted/i, 'the execution summary');

      const after = await readdir(projectRoot);
      expect(after).not.toContain('dist');
      expect(after).not.toContain('node_modules');
      // V. Source files are never in scope for any rule.
      expect(after).toContain('package.json');

      stdin.write('q');
      await settle(400);
      expect(exitCode).toBe(0);
    } finally {
      unmount();
    }
  }, 60_000);
});
