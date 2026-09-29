/**
 * Vitest Configuration
 *
 * Defines how the DevEnvClean test suite is discovered and executed.
 *
 * I. Why this file exists
 *
 * 1. The default `include` glob would also pick up compiled output and any
 *    scratch script a developer leaves in the repository, so the suite is
 *    pinned to `tests/**` only.
 * 2. The filesystem tests below share real directories on disk, which is the
 *    one input a parallel test runner cannot isolate. The configuration
 *    therefore trades wall-clock time for determinism.
 *
 * II. Why the run is sequential across files
 *
 * 1. `pool: 'forks'` gives every test file a real child process, so a test that
 *    aborts a signal, chmods a directory to `0o500` or leaves a half-deleted
 *    tree cannot corrupt a sibling file's module state or working directory.
 * 2. `fileParallelism: false` keeps those child processes from running at the
 *    same time. The suite builds and removes fixture trees under
 *    `tests/.fixtures/`, and two files doing that concurrently would see each
 *    other's directories appear and disappear; the failure would be a flake
 *    that looks like a product bug.
 * 3. `testTimeout` is raised well above the 5 s default because the scanner
 *    tests walk real directories and write real megabytes. A slow machine
 *    (or a cold filesystem cache) must not be reported as a product failure.
 *
 * @module vitest.config
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // I. Discovery: only the hand-written suite, never `dist/**` or a scratch file.
    include: ['tests/**/*.test.ts'],
    environment: 'node',

    // II. Isolation and determinism for the filesystem fixtures.
    pool: 'forks',
    fileParallelism: false,

    // III. Generous timeouts for the tests that walk and write real trees.
    testTimeout: 20_000,
    hookTimeout: 20_000,

    // IV. A test that installs a spy must not leak it into the next test.
    restoreMocks: true,
    clearMocks: true,
  },
});
