/**
 * Environment Doctor
 *
 * Read-only diagnostics that explain why a scan or a cleanup may behave
 * unexpectedly on this machine.
 *
 * I. Why this exists
 *
 * 1. Almost every "the tool found nothing" report is environmental: the scan
 *    root is on a volume the process cannot read, the config in scope is not the
 *    one the user edited, or an ecosystem is disabled. A single command that
 *    states those facts is worth more than a better error message buried in a
 *    scan.
 * 2. It never mutates anything, so it is safe to run first and safe to run in a
 *    bug report.
 *
 * @module core/doctor
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { constants as fsConstants } from 'node:fs';
import { access, statfs } from 'node:fs/promises';
import { BUILTIN_RULES } from '../rules/builtin.js';
import { formatBytes } from './format.js';
import { isDirectory, isWritable } from './measure.js';
import { getHome, getPlatform, isProtectedPath } from './platform.js';
import type { DoctorCheck, ResolvedConfig } from './types.js';

/** Options for {@link runDoctor}. */
export interface DoctorOptions {
  /** Resolved configuration in effect. */
  readonly config: ResolvedConfig;
  /** Node version string, supplied so the check is testable. */
  readonly nodeVersion: string;
  /** Whether stdout is a TTY, which decides if the TUI can run. */
  readonly isTty: boolean;
}

/**
 * Build a pass/warn/fail check result.
 *
 * @param name - Short check name.
 * @param status - Outcome.
 * @param detail - One-line explanation.
 * @param hint - Optional remediation.
 * @returns The check record.
 */
function check(
  name: string,
  status: DoctorCheck['status'],
  detail: string,
  hint: string | null = null,
): DoctorCheck {
  return { name, status, detail, hint };
}

/**
 * Run every environment check.
 *
 * I. Checks, in the order a user should read them
 *
 * 1. Runtime — a Node version below 22 cannot run Ink 7 at all.
 * 2. Terminal — a non-TTY means the interactive path is unavailable, which is
 *    normal in CI and worth stating rather than failing.
 * 3. Configuration — which file was loaded, and whether it was found at all.
 * 4. Roots — existence, readability and writability. A read-only root produces
 *    a perfect report and a wall of failures at cleanup time; catching it here
 *    is the single highest-value check.
 * 5. Protected-path sanity — a scan root placed *inside* a protected directory
 *    means every target will be locked, which looks like a bug otherwise.
 * 6. Free space on the root volume, so "how much can I actually reclaim" has
 *    context.
 * 7. Rule catalogue — a rule disabled in config is reported, because a missing
 *    category is otherwise indistinguishable from an empty filesystem.
 *
 * @param options - Doctor options.
 * @returns The checks, in display order.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorCheck[]> {
  const { config, nodeVersion, isTty } = options;
  const checks: DoctorCheck[] = [];

  // I. Runtime.
  const major = Number.parseInt(nodeVersion.replace(/^v/, '').split('.')[0] ?? '0', 10);
  checks.push(
    major >= 22
      ? check('runtime', 'pass', `Node ${nodeVersion} satisfies the Node 22 requirement`)
      : check(
          'runtime',
          'fail',
          `Node ${nodeVersion} is below the required Node 22`,
          'Upgrade Node, or use a non-interactive command that does not load the TUI.',
        ),
  );

  // II. Terminal capability.
  checks.push(
    isTty
      ? check('terminal', 'pass', 'stdout is a TTY; the interactive interface is available')
      : check(
          'terminal',
          'warn',
          'stdout is not a TTY; the interactive interface is unavailable',
          'Use `dvc scan --json` or `dvc clean` for non-interactive runs.',
        ),
  );

  // III. Configuration provenance.
  checks.push(
    config.sourcePath
      ? check('config', 'pass', `configuration loaded from ${config.sourcePath}`)
      : check(
          'config',
          'warn',
          'no configuration file found; built-in defaults are in effect',
          'Run `dvc config init` to create an editable dvc.config.json.',
        ),
  );

  // IV. Scan roots: existence, readability, writability.
  const unreachable: string[] = [];
  const unwritable: string[] = [];
  for (const root of config.roots) {
    if (!(await isDirectory(root))) {
      unreachable.push(root);
      continue;
    }
    try {
      await access(root, fsConstants.R_OK);
    } catch {
      unreachable.push(root);
      continue;
    }
    if (!(await isWritable(root))) unwritable.push(root);
  }

  checks.push(
    unreachable.length === 0
      ? check('scan roots', 'pass', `all ${config.roots.length} scan roots are readable`)
      : check(
          'scan roots',
          'fail',
          `${unreachable.length} scan root(s) missing or unreadable: ${unreachable.join(', ')}`,
          'Check the path in dvc.config.json, or pass an explicit root.',
        ),
  );

  checks.push(
    unwritable.length === 0
      ? check('root writability', 'pass', 'every scan root is writable')
      : check(
          'root writability',
          'warn',
          `${unwritable.length} scan root(s) are read-only: ${unwritable.join(', ')}`,
          'Scans will work; cleanup inside these roots will fail per target.',
        ),
  );

  // V. Protected-path sanity.
  const home = getHome();
  const protectedRoots = config.roots.filter((root) => isProtectedPath(root) || root === home);
  checks.push(
    protectedRoots.length === 0
      ? check('path safety', 'pass', 'no scan root is inside a protected system location')
      : check(
          'path safety',
          'warn',
          `${protectedRoots.length} scan root(s) are protected or are the home directory itself: ${protectedRoots.join(', ')}`,
          'Targets under a protected path are reported but permanently locked, which is expected.',
        ),
  );

  // VI. Free space, so the reclaimable total has a denominator.
  try {
    const stats = await statfs(config.roots[0] ?? home);
    const blockSize = Number(stats.bsize);
    const free = blockSize * Number(stats.bavail);
    const total = blockSize * Number(stats.blocks);
    checks.push(
      check(
        'free space',
        free / total < 0.05 ? 'warn' : 'pass',
        `${formatBytes(free)} free of ${formatBytes(total)} on ${config.roots[0] ?? home}`,
        free / total < 0.05 ? 'Under 5% free; cleanup is worth running now.' : null,
      ),
    );
  } catch (error) {
    checks.push(
      check(
        'free space',
        'warn',
        `could not read filesystem statistics: ${error instanceof Error ? error.message : String(error)}`,
        null,
      ),
    );
  }

  // VII. Rule catalogue.
  const disabled = Object.entries(config.rules)
    .filter(([, override]) => override.enabled === false)
    .map(([ruleId]) => ruleId);
  const known = new Set(BUILTIN_RULES.map((rule) => rule.id));
  const unknown = disabled.filter((ruleId) => !known.has(ruleId));
  checks.push(
    disabled.length === 0
      ? check('rules', 'pass', `${BUILTIN_RULES.length} built-in rules active`)
      : check(
          'rules',
          unknown.length > 0 ? 'warn' : 'pass',
          `${BUILTIN_RULES.length - disabled.length} of ${BUILTIN_RULES.length} rules active; disabled: ${disabled.join(', ')}`,
          unknown.length > 0 ? `Unknown rule ids in config: ${unknown.join(', ')}` : null,
        ),
  );

  // VIII. Ecosystem enablement, since a disabled ecosystem looks like an empty
  //      filesystem for that toolchain.
  const disabledEcosystems = Object.entries(config.ecosystems)
    .filter(([, value]) => !value.enabled)
    .map(([id]) => id);
  checks.push(
    disabledEcosystems.length === 0
      ? check('ecosystems', 'pass', `all ${Object.keys(config.ecosystems).length} ecosystems enabled`)
      : check(
          'ecosystems',
          'warn',
          `disabled ecosystems are invisible in reports: ${disabledEcosystems.join(', ')}`,
          'Re-enable them in dvc.config.json if their caches should be counted.',
        ),
  );

  // IX. Platform, stated for the record in a bug report.
  checks.push(check('platform', 'pass', `${getPlatform()} · home ${home}`));

  return checks;
}

/**
 * Decide the process exit code for a set of checks.
 *
 * @param checks - The checks.
 * @returns 1 when any check failed, otherwise 0.
 */
export function doctorExitCode(checks: readonly DoctorCheck[]): number {
  return checks.some((entry) => entry.status === 'fail') ? 1 : 0;
}
