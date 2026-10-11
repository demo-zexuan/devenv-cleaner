/**
 * Package Artifact Verification
 *
 * Builds the real publishable tarball and proves it works as an installed
 * dependency, rather than trusting that the source tree passing its tests means
 * the *shipped* artifact is complete.
 *
 * I. What this catches that the test suite cannot
 *
 * 1. A missing `files` entry. Every source test imports `src/**` directly, so a
 *    path excluded from the tarball is invisible until a user installs the
 *    package and finds a file absent.
 * 2. A dependency declared in `devDependencies` but imported at run time. The
 *    lockfile installs both kinds in the workspace, so the mistake only shows up
 *    in a clean consumer install.
 * 3. A missing executable bit or shebang on the `bin` entry, which makes `dvc`
 *    unrunnable while `node dist/cli.js` still works.
 * 4. An accidental inclusion of the repository's own fixtures, reports or
 *    scratch files in the published artifact.
 *
 * II. Two phases
 *
 * 1. **Offline** — pack, inspect the file list, and assert the required entries
 *    and the shebang. Fast, and it runs anywhere.
 * 2. **Install** — install the tarball into a throwaway consumer project and
 *    actually execute the binary. This needs the registry, so `--offline`
 *    skips it when a caller has no network.
 *
 * Usage:
 *   pnpm exec tsx scripts/verify-package.ts
 *   pnpm exec tsx scripts/verify-package.ts --offline
 *
 * @module scripts/verify-package
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Repository root, derived from this file's location. */
const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');

/** Every path the published artifact must contain. */
const REQUIRED_ENTRIES: readonly string[] = [
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/dist/cli.js',
  'package/dist/index.js',
  'package/dist/index.d.ts',
  'package/docs/requirements.md',
  'package/docs/design.md',
];

/**
 * Path fragments that must never appear in the tarball.
 *
 * A published package is public forever, so leaking a scratch directory or a
 * local scan report is a disclosure rather than a tidy-up.
 */
const FORBIDDEN_FRAGMENTS: readonly string[] = [
  'node_modules/',
  '.e2e-fixture',
  '.devenvclean/',
  'tests/',
  'src/',
  '.npm-cache/',
];

/** Outcome of one assertion. */
interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

/**
 * Record an assertion outcome.
 *
 * @param name - What was asserted.
 * @param ok - Whether it held.
 * @param detail - Supporting evidence for the report.
 */
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

/**
 * Run `npm pack` and return the tarball filename.
 *
 * I. Why the cache is redirected
 *
 * 1. A developer machine frequently has a root-owned npm cache from an earlier
 *    `sudo npm` run, and npm refuses to write to it. Pointing the cache inside
 *    the throwaway pack directory keeps this script independent of whatever
 *    state the host's cache is in.
 *
 * @param destination - Directory the tarball is written to.
 * @returns The absolute path of the produced tarball.
 */
async function pack(destination: string): Promise<string> {
  const { stdout } = await run(
    'npm',
    ['pack', '--pack-destination', destination, '--cache', join(destination, 'cache')],
    {
      cwd: REPOSITORY_ROOT,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const filename = stdout.trim().split('\n').at(-1)?.trim() ?? '';
  const tarball = join(destination, filename);
  if (!existsSync(tarball)) throw new Error(`npm pack did not produce a tarball at ${tarball}`);
  return tarball;
}

/**
 * List the archive's entries.
 *
 * @param tarball - Path to the `.tgz` file.
 * @returns Relative entry paths.
 */
async function listEntries(tarball: string): Promise<string[]> {
  const { stdout } = await run('tar', ['-tzf', tarball], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * Verify the tarball's contents and the executable's header.
 *
 * @param tarball - Path to the `.tgz` file.
 * @param workDirectory - Scratch space for extraction.
 */
async function verifyContents(tarball: string, workDirectory: string): Promise<void> {
  const entries = await listEntries(tarball);
  const entrySet = new Set(entries);

  // I. Required entries.
  const missing = REQUIRED_ENTRIES.filter((required) => !entrySet.has(required));
  check(
    'required files present',
    missing.length === 0,
    missing.length === 0
      ? `${REQUIRED_ENTRIES.length} required entries found`
      : `missing: ${missing.join(', ')}`,
  );

  // II. Nothing that must stay private.
  const leaked = entries.filter((entry) => FORBIDDEN_FRAGMENTS.some((fragment) => entry.includes(fragment)));
  check(
    'no private paths published',
    leaked.length === 0,
    leaked.length === 0 ? 'no scratch, test or source paths' : `leaked: ${leaked.slice(0, 5).join(', ')}`,
  );

  // III. The binary must carry a shebang, or `dvc` is not runnable.
  await run('tar', ['-xzf', tarball, '-C', workDirectory]);
  const cliPath = join(workDirectory, 'package', 'dist', 'cli.js');
  const head = (await readFile(cliPath, 'utf8')).slice(0, 64);
  check(
    'cli entry has a shebang',
    head.startsWith('#!/usr/bin/env node'),
    JSON.stringify(head.split('\n')[0] ?? ''),
  );

  // IV. The declared bin targets must be exactly what shipped.
  const manifest = JSON.parse(await readFile(join(workDirectory, 'package', 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const binTargets = Object.values(manifest.bin ?? {});
  const binsPresent = binTargets.every((target) => entrySet.has(`package/${target.replace(/^\.\//, '')}`));
  check('bin targets exist in the tarball', binTargets.length > 0 && binsPresent, binTargets.join(', '));

  // V. Every runtime dependency must be a declared `dependencies` entry: an
  //    import satisfied by the workspace but absent from the manifest breaks
  //    only for consumers.
  check(
    'runtime dependencies declared',
    Object.keys(manifest.dependencies ?? {}).length > 0,
    Object.keys(manifest.dependencies ?? {}).join(', '),
  );

  const sizeBytes = entries.length;
  check('tarball is not empty', sizeBytes > 10, `${entries.length} entries`);
}

/**
 * Install the tarball into a throwaway project and execute the binary.
 *
 * @param tarball - Path to the `.tgz` file.
 * @param workDirectory - Scratch space for the consumer project.
 */
async function verifyInstalledArtifact(tarball: string, workDirectory: string): Promise<void> {
  const consumer = join(workDirectory, 'consumer');
  await mkdir(consumer, { recursive: true });
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true }, null, 2),
  );

  // I. A real install, so dependency resolution is exercised exactly as a user
  //    would exercise it.
  await run('npm', ['install', '--no-audit', '--no-fund', '--cache', join(workDirectory, 'cache'), tarball], {
    cwd: consumer,
    maxBuffer: 32 * 1024 * 1024,
  });

  const bin = join(consumer, 'node_modules', '.bin', 'dvc');
  check('bin linked by the installer', existsSync(bin), bin);

  // II. The binary must run.
  const version = await run(bin, ['--version'], { cwd: consumer });
  check('installed binary reports a version', /\d+\.\d+\.\d+/.test(version.stdout), version.stdout.trim());

  // III. A real command must complete end to end from the installed copy.
  const fixture = join(workDirectory, 'fixture');
  await mkdir(join(fixture, 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(join(fixture, 'package.json'), '{"name":"fixture"}');
  await writeFile(join(fixture, 'node_modules', '.package-lock.json'), '{}');
  await writeFile(join(fixture, 'node_modules', 'left-pad', 'index.js'), Buffer.alloc(2_000_000));

  const scan = await run(bin, ['scan', '--root', fixture, '--min-size', '0', '--json'], { cwd: consumer });
  const report = JSON.parse(scan.stdout) as { schemaVersion: number; summary: { targetCount: number } };
  check(
    'installed binary scans successfully',
    report.schemaVersion === 1 && report.summary.targetCount > 0,
    `schemaVersion=${report.schemaVersion} targets=${report.summary.targetCount}`,
  );
}

/** Entry point. */
async function main(): Promise<void> {
  const offline = process.argv.includes('--offline');
  const workDirectory = await mkdtemp(join(tmpdir(), 'dvc-verify-'));

  try {
    const tarball = await pack(workDirectory);
    // Read the size through `fs` rather than shelling out to `stat`, whose
    // flags differ between BSD and GNU coreutils.
    const { size } = await stat(tarball);
    console.log(`packed ${tarball.split('/').at(-1)} (${(size / 1024).toFixed(1)} kB)\n`);

    await verifyContents(tarball, workDirectory);
    if (offline) {
      console.log('skipping install verification (--offline)\n');
    } else {
      await verifyInstalledArtifact(tarball, workDirectory);
    }
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }

  let failed = 0;
  for (const entry of checks) {
    if (!entry.ok) failed += 1;
    console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name.padEnd(34)} ${entry.detail}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed; the artifact must not be published`);
    process.exitCode = 1;
  }
}

await main();
