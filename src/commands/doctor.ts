/**
 * Doctor Command
 *
 * Prints environment diagnostics and decides the exit code.
 *
 * @module commands/doctor
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import pc from 'picocolors';
import { doctorToJson, printJson } from '../cli/output.js';
import { doctorExitCode, runDoctor } from '../core/doctor.js';
import type { DoctorCheck, ResolvedConfig } from '../core/index.js';

/** Options for {@link runDoctorCommand}. */
export interface DoctorCommandOptions {
  /** Resolved configuration in effect. */
  readonly config: ResolvedConfig;
  /** Emit JSON. */
  readonly json: boolean;
  /** Suppress colour. */
  readonly noColor: boolean;
  /** Working directory reported for context. */
  readonly cwd: string;
}

/**
 * Run and print the environment checks.
 *
 * @param options - Command options.
 * @returns 1 when any check failed, otherwise 0.
 */
export async function runDoctorCommand(options: DoctorCommandOptions): Promise<number> {
  const checks = await runDoctor({
    config: options.config,
    nodeVersion: process.version,
    isTty: process.stdout.isTTY === true,
  });

  if (options.json) {
    printJson({ ok: true, data: { cwd: options.cwd, ...(doctorToJson(checks) as object) } });
    return doctorExitCode(checks);
  }

  const bold = options.noColor ? (value: string): string => value : pc.bold;
  const dim = options.noColor ? (value: string): string => value : pc.dim;
  const green = options.noColor ? (value: string): string => value : pc.green;
  const yellow = options.noColor ? (value: string): string => value : pc.yellow;
  const red = options.noColor ? (value: string): string => value : pc.red;

  const out = process.stdout;
  out.write(`\n${bold('DevEnvClean doctor')}\n\n`);

  // I. A fixed-width status column keeps the report scannable, which matters
  //    because a user reads this when something is already wrong.
  for (const entry of checks) {
    out.write(
      `  ${statusBadge(entry.status, { green, yellow, red })}  ${entry.name.padEnd(18)}${entry.detail}\n`,
    );
    if (entry.hint) out.write(`  ${' '.repeat(8)}${dim(`↳ ${entry.hint}`)}\n`);
  }

  const failed = checks.filter((entry) => entry.status === 'fail').length;
  const warned = checks.filter((entry) => entry.status === 'warn').length;
  out.write(
    `\n  ${failed > 0 ? red(`${failed} failed`) : green('0 failed')}` +
      `, ${warned > 0 ? yellow(`${warned} warning(s)`) : '0 warnings'}` +
      `, ${checks.length - failed - warned} passed\n\n`,
  );
  return doctorExitCode(checks);
}

/**
 * Render a coloured status badge.
 *
 * @param status - Check status.
 * @param colors - Colour helpers, injected so `--no-color` needs no branching
 *   at every call site.
 * @returns The badge text.
 */
function statusBadge(
  status: DoctorCheck['status'],
  colors: {
    readonly green: (value: string) => string;
    readonly yellow: (value: string) => string;
    readonly red: (value: string) => string;
  },
): string {
  if (status === 'pass') return colors.green('pass');
  if (status === 'warn') return colors.yellow('warn');
  return colors.red('FAIL');
}
