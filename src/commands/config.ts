/**
 * Configuration Commands
 *
 * Scaffolds, validates and displays the `dvc.config.json` that tunes a scan.
 *
 * I. Why scaffolding is a command and not a documented file format
 *
 * 1. The config has a dozen interacting knobs. Shipping a generated starting
 *    point that is already valid — and that `dvc config validate` accepts — is
 *    the difference between a tunable tool and a tool nobody tunes.
 * 2. The generated file is deliberately minimal: an uncommented wall of defaults
 *    obscures the two or three values a user actually changes.
 *
 * @module commands/config
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { constants as fsConstants } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';

import pc from 'picocolors';

import { formatBytes, type ResolvedConfig } from '../core/index.js';
import {
  CONFIG_FILE_NAME,
  getConfigSearchPaths,
  serializeConfig,
  validateConfigFile,
} from '../rules/config.js';

/**
 * Write a starting config file.
 *
 * I. Refusal semantics
 *
 * 1. An existing file is never overwritten unless `force` is set. A config is
 *    hand-edited state, and silently replacing it would destroy exactly the
 *    customisation this command exists to encourage.
 *
 * @param options - Command options.
 * @returns 0 on success, 1 when the file exists and `force` is false.
 */
export async function runConfigInit(options: {
  /** Destination path. */
  readonly target: string;
  /** Overwrite an existing file. */
  readonly force: boolean;
  /** Configuration whose values seed the scaffold. */
  readonly config: ResolvedConfig;
  /** Suppress colour. */
  readonly noColor: boolean;
}): Promise<number> {
  const bold = options.noColor ? (value: string): string => value : pc.bold;

  try {
    await access(options.target, fsConstants.F_OK);
    if (!options.force) {
      process.stderr.write(`${options.target} already exists; re-run with --force to overwrite it\n`);
      return 1;
    }
  } catch {
    // The file does not exist, which is the expected path.
  }

  const scaffold = serializeConfig(options.config);
  const body = `${JSON.stringify(scaffold, null, 2)}\n`;
  await writeFile(options.target, body, 'utf8');
  process.stdout.write(`${bold('created')} ${options.target}\n`);
  process.stdout.write(`edit it, then verify with: dvc config validate\n`);
  return 0;
}

/**
 * Validate the config file that would be used for this working directory.
 *
 * @param options - Command options.
 * @returns 0 when valid (warnings allowed), 1 when invalid or missing.
 */
export async function runConfigValidate(options: {
  /** Resolved configuration; a null `sourcePath` means no file was found. */
  readonly config: ResolvedConfig;
  /** Working directory used for search-path reporting. */
  readonly cwd: string;
  /** Suppress colour. */
  readonly noColor: boolean;
}): Promise<number> {
  const green = options.noColor ? (value: string): string => value : pc.green;
  const red = options.noColor ? (value: string): string => value : pc.red;
  const yellow = options.noColor ? (value: string): string => value : pc.yellow;
  const dim = options.noColor ? (value: string): string => value : pc.dim;

  const sourcePath = options.config.sourcePath;
  if (!sourcePath) {
    process.stdout.write(`${yellow('no configuration file found')}\n`);
    process.stdout.write(`${dim('searched:')}\n`);
    for (const candidate of getConfigSearchPaths(options.cwd)) {
      process.stdout.write(`  ${candidate}\n`);
    }
    process.stdout.write(`${dim('built-in defaults are in effect; create one with "dvc config init"')}\n`);
    return 0;
  }

  const result = await validateConfigFile(sourcePath);
  process.stdout.write(`${dim('config')} ${sourcePath}\n`);

  for (const warning of result.warnings) {
    process.stdout.write(`${yellow('warning')} ${warning}\n`);
  }
  for (const error of result.errors) {
    process.stdout.write(`${red('error')} ${error}\n`);
  }

  if (!result.ok) return 1;
  process.stdout.write(`${green('valid')} ${result.warnings.length} warning(s)\n`);
  return 0;
}

/**
 * Print the fully resolved configuration.
 *
 * I. Why the resolved form is shown rather than the file
 *
 * 1. The file is a sparse override; the *resolved* config is what the scanner
 *    actually consumes. Showing the resolved form is the only way a user can see
 *    a default they never wrote, which is where surprises live.
 *
 * @param options - Command options.
 */
export function runConfigShow(options: {
  /** Resolved configuration. */
  readonly config: ResolvedConfig;
  /** Emit JSON. */
  readonly json: boolean;
  /** Suppress colour. */
  readonly noColor: boolean;
}): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(options.config, null, 2)}\n`);
    return;
  }

  const config = options.config;
  const bold = options.noColor ? (value: string): string => value : pc.bold;
  const dim = options.noColor ? (value: string): string => value : pc.dim;
  const out = process.stdout;

  const row = (label: string, value: string): void => {
    out.write(`  ${label.padEnd(22)}${value}\n`);
  };

  out.write(`\n${bold('resolved configuration')}\n\n`);
  row('source', config.sourcePath ?? dim('built-in defaults'));
  row('roots', config.roots.join(', ') || dim('none'));
  row('max depth', String(config.maxDepth));
  row('min size', formatBytes(config.minSizeBytes));
  row('retention', `${config.retentionDays} day(s)`);
  row('whitelist', String(config.whitelist.length));
  row('report dir', config.report.dir);
  row('report format', config.report.format);

  out.write(`\n${bold('limits')}\n\n`);
  row('high risk above', formatBytes(config.limits.highRiskBytes));
  row('concurrency', String(config.limits.concurrency));
  row('max directories', config.limits.maxDirectories.toLocaleString('en-US'));
  row('light node_modules', String(config.limits.lightNodeModulesEntries));

  const overrides = Object.entries(config.rules);
  out.write(`\n${bold('rule overrides')}\n\n`);
  if (overrides.length === 0) {
    out.write(`  ${dim('none; all built-in rules are active with their declared settings')}\n`);
  } else {
    for (const [ruleId, override] of overrides) {
      const parts = Object.entries(override)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`);
      row(ruleId, parts.join(' ') || dim('empty override'));
    }
  }

  const disabled = Object.entries(config.ecosystems)
    .filter(([, value]) => !value.enabled)
    .map(([id]) => id);
  out.write(`\n${bold('ecosystems')}\n\n`);
  out.write(
    `  ${Object.keys(config.ecosystems).length - disabled.length} enabled` +
      (disabled.length > 0 ? `, disabled: ${disabled.join(', ')}` : '') +
      '\n',
  );
  out.write(`\n${dim(`config file name: ${CONFIG_FILE_NAME}`)}\n\n`);
}

/**
 * Print the search path used to locate a config file.
 *
 * @param cwd - Working directory.
 * @param noColor - Suppress colour.
 */
export function runConfigPath(cwd: string, noColor: boolean): void {
  const dim = noColor ? (value: string): string => value : pc.dim;
  process.stdout.write(`${dim('searched in order; the first readable file wins')}\n`);
  for (const candidate of getConfigSearchPaths(cwd)) process.stdout.write(`${candidate}\n`);
}
