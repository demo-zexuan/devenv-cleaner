/**
 * DevEnvClean CLI Entry Point
 *
 * Parses arguments, resolves configuration, and dispatches to a command.
 *
 * I. Exit code contract
 *
 * 1. `0` success.
 * 2. `1` usage error, invalid configuration, or a cleanup that had failures.
 * 3. `2` a policy gate refused — currently only `report diff --fail-on-growth`.
 *    Kept distinct from `1` so CI can tell "your branch regressed" apart from
 *    "your config is wrong", which need different human responses.
 * 4. `130` interrupted by the user (SIGINT), matching shell convention.
 *
 * II. Why every command funnels through one config load
 *
 * 1. A command that resolved its own config could drift from the others on
 *    precedence. Loading once, here, is what makes `dvc config show` describe
 *    exactly the configuration `dvc scan` will use.
 *
 * @module cli/index
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from 'commander';
import pc from 'picocolors';
import { cleanExitCode, runClean } from '../commands/clean.js';
import { runConfigInit, runConfigPath, runConfigShow, runConfigValidate } from '../commands/config.js';
import { runDoctorCommand } from '../commands/doctor.js';
import { exportReport, runReport } from '../commands/report.js';
import { runRulesExplain, runRulesList } from '../commands/rules.js';
import { runScan } from '../commands/scan.js';
import {
  canonicalizeRoots,
  getHome,
  getPlatform,
  type ResolvedConfig,
  type TargetLayer,
} from '../core/index.js';
import { detectLanguage, setLanguage } from '../i18n/index.js';
import { BUILTIN_RULES } from '../rules/builtin.js';
import { DEFAULT_LIMITS, getDefaultConfig, loadConfig, resolveConfig } from '../rules/config.js';
import { printJsonError } from './output.js';

/** Exit code definitions, referenced by name so the contract is greppable. */
export const EXIT = {
  success: 0,
  usage: 1,
  gate: 2,
  interrupted: 130,
} as const;

/** Global flags shared by every subcommand. */
interface GlobalFlags {
  readonly config?: string | undefined;
  readonly color?: boolean | undefined;
  readonly lang?: string | undefined;
  readonly verbose?: boolean | undefined;
}

/**
 * Decide whether colour should be suppressed.
 *
 * I. Precedence
 *
 * 1. An explicit `--color/--no-color` flag wins, because a user who typed it
 *    means it.
 * 2. `NO_COLOR` is honoured next, per the informal no-color standard.
 * 3. Finally, a non-TTY stdout suppresses colour so a redirected log has no
 *    escape codes in it.
 *
 * @param flags - Global flags.
 * @returns True when colour must be suppressed.
 */
function shouldDisableColor(flags: GlobalFlags): boolean {
  if (flags.color === false) return true;
  if (flags.color === true) return false;
  if (process.env.NO_COLOR && process.env.NO_COLOR.length > 0) return true;
  return process.stdout.isTTY !== true;
}

/**
 * Resolve configuration for a run, applying CLI overrides on top of the file.
 *
 * I. Precedence, lowest to highest
 *
 * 1. Built-in defaults.
 * 2. The discovered or explicitly named config file.
 * 3. Explicit CLI flags — `--root`, `--max-depth`, `--min-size`.
 *
 * @param flags - Global flags.
 * @param overrides - Command-level overrides.
 * @param cwd - Working directory used for discovery.
 * @returns The resolved config plus any warnings to surface.
 */
async function resolveRuntimeConfig(
  flags: GlobalFlags,
  overrides: {
    readonly roots?: readonly string[] | undefined;
    readonly maxDepth?: number | undefined;
    readonly minSizeBytes?: number | undefined;
  },
  cwd: string,
): Promise<{ config: ResolvedConfig; warnings: string[] }> {
  // II. No config file may exist at all, which is the normal first-run case.
  let loaded: { config: ResolvedConfig; warnings: string[] };
  try {
    loaded = await loadConfig({ cwd, explicitPath: flags.config ?? null });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  // III. Canonicalize the roots before anything compares paths.
  //
  //      Containment is a string comparison, and the executor necessarily
  //      compares against `realpath`-resolved paths. Without this step a root
  //      reached through a symlink — `/tmp` on macOS, which is a link to
  //      `/private/tmp` — would match nothing, so every target would preview as
  //      locked `outside-root` and refuse to delete. Normalizing once here
  //      keeps the planner, the preview and the executor in agreement.
  //
  //      An explicit `--root` is canonicalized as well, so both sources agree.
  const configuredRoots = await canonicalizeRoots(loaded.config.roots);
  const requestedRoots =
    overrides.roots === undefined ? configuredRoots : await canonicalizeRoots(overrides.roots);

  const needsOverride =
    overrides.roots !== undefined || overrides.maxDepth !== undefined || overrides.minSizeBytes !== undefined;
  if (!needsOverride) {
    return {
      config: { ...loaded.config, roots: requestedRoots },
      warnings: loaded.warnings,
    };
  }

  // IV. CLI flags are applied through the same resolver as the file, so a flag
  //     is clamped and normalised exactly like a file value would be.
  const config = resolveConfig(
    {
      roots: requestedRoots,
      maxDepth: overrides.maxDepth ?? loaded.config.maxDepth,
      minSizeBytes: overrides.minSizeBytes ?? loaded.config.minSizeBytes,
      whitelist: loaded.config.whitelist,
      rules: loaded.config.rules,
      limits: loaded.config.limits,
      ecosystems: loaded.config.ecosystems,
      report: loaded.config.report,
    },
    loaded.config.sourcePath,
  );
  return { config, warnings: loaded.warnings };
}

/**
 * Build the commander program.
 *
 * @returns The configured program.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('dvc')
    .description('Scan and selectively reclaim disk space taken by development caches and dependencies')
    .version(process.env.DEV_ENV_CLEANER_VERSION ?? '0.1.0', '-v, --version', 'print the version')
    .option('-c, --config <path>', 'use this configuration file instead of discovering one')
    .option('--color', 'force coloured output')
    .option('--no-color', 'disable coloured output')
    .option('--lang <code>', 'interface language: en (default) or zh')
    .option('--verbose', 'print extra diagnostics');

  // ===========================================================================
  // I. scan
  // ===========================================================================
  program
    .command('scan', { isDefault: false })
    .description('measure development caches and dependencies, then print a report')
    .option('-r, --root <path...>', 'directories to scan; repeatable, defaults to the home directory')
    .option('-d, --max-depth <n>', 'how deep below each root to walk', (value) => Number.parseInt(value, 10))
    .option('-s, --min-size <bytes>', 'ignore targets smaller than this', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--json', 'emit a machine-readable report')
    .option('-o, --out <path>', 'write a report file (.json or .md)')
    .option('--global', 'also include machine-global package manager caches')
    .option('-q, --quiet', 'suppress the human summary')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const flags = command.parent?.opts<GlobalFlags>() ?? {};
      await guard(async () => {
        applyLanguage(flags, () => undefined);
        const noColor = shouldDisableColor(flags);
        const { config, warnings } = await resolveRuntimeConfig(
          flags,
          {
            roots: options.root as readonly string[] | undefined,
            maxDepth: options.maxDepth as number | undefined,
            minSizeBytes: options.minSize as number | undefined,
          },
          process.cwd(),
        );
        printWarnings(warnings, noColor);

        const report = await runScan({
          roots: config.roots,
          maxDepth: config.maxDepth,
          minSizeBytes: config.minSizeBytes,
          json: options.json === true,
          out: options.out as string | undefined,
          includeGlobal: options.global === true,
          noColor,
          quiet: options.quiet === true,
          config,
        });

        // A truncated scan is reported but still exits 0: the data is useful,
        // it is simply incomplete, and failing would train users to ignore it.
        if (!options.json && report.truncated && !options.quiet) {
          process.stderr.write(
            `${noColor ? '' : pc.yellow('warning')} the directory ceiling was reached; totals are a lower bound\n`,
          );
        }
      });
    });

  // ===========================================================================
  // II. clean
  // ===========================================================================
  program
    .command('clean')
    .description('preview and delete cleanup targets (preview unless --yes)')
    .option('-r, --root <path...>', 'directories to scan; repeatable')
    .option('-d, --max-depth <n>', 'how deep below each root to walk', (value) => Number.parseInt(value, 10))
    .option('-s, --min-size <bytes>', 'ignore targets smaller than this', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--target <id...>', 'act only on these target ids')
    .option('--layer <layer...>', 'act only on these layers (dependencies|build|cache|artifacts)')
    .option('--rule <id...>', 'act only on these rule ids')
    .option('--older-than <days>', 'act only on targets untouched for this many days', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--path <substring>', 'act only on targets whose path contains this text')
    .option('--include-locked', 'also consider locks that are overridable')
    .option('--yes', 'actually delete; without it this command only previews')
    .option('--dry-run', 'preview even when --yes is present')
    .option('--global', 'also include machine-global package manager caches')
    .option('--json', 'emit machine-readable output')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const flags = command.parent?.opts<GlobalFlags>() ?? {};
      await guard(async () => {
        applyLanguage(flags, () => undefined);
        const noColor = shouldDisableColor(flags);
        const globalFlag = options.global === true;
        const { config, warnings } = await resolveRuntimeConfig(
          flags,
          {
            roots: options.root as readonly string[] | undefined,
            maxDepth: options.maxDepth as number | undefined,
            minSizeBytes: options.minSize as number | undefined,
          },
          process.cwd(),
        );
        printWarnings(warnings, noColor);

        // A selection with no criteria and no --yes is almost always a mistake:
        // it would preview every target on the machine. Requiring one filter
        // keeps `dvc clean --yes` from becoming a foot-gun.
        const hasCriteria =
          options.target !== undefined ||
          options.layer !== undefined ||
          options.rule !== undefined ||
          options.olderThan !== undefined ||
          options.path !== undefined ||
          options.minSize !== undefined;

        if (options.yes === true && !hasCriteria) {
          process.stderr.write(
            'refusing to delete with no selection criteria; pass --target, --layer, --rule, ' +
              '--older-than, --path or --min-size (or use the interactive interface)\n',
          );
          process.exitCode = EXIT.usage;
          return;
        }

        const result = await runClean({
          roots: config.roots,
          config,
          selectedIds: options.target as readonly string[] | undefined,
          layers: options.layer as readonly TargetLayer[] | undefined,
          ruleIds: options.rule as readonly string[] | undefined,
          minBytes: options.minSize as number | undefined,
          olderThanDays: options.olderThan as number | undefined,
          pathContains: options.path as string | undefined,
          includeLocked: options.includeLocked === true,
          yes: options.yes === true,
          dryRun: options.dryRun === true,
          includeGlobal: globalFlag,
          json: options.json === true,
          noColor,
          width: process.stdout.columns ?? 100,
        });
        process.exitCode = cleanExitCode(result);
      });
    });

  // ===========================================================================
  // III. rules
  // ===========================================================================
  const rules = program.command('rules').description('inspect the built-in rule catalogue');
  rules
    .command('list', { isDefault: true })
    .description('list every rule and whether it is active')
    .option('--json', 'emit machine-readable output')
    .option('--layer <layer>', 'show only rules feeding this layer')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const flags = rootFlags(command);
      await guard(async () => {
        applyLanguage(flags, () => undefined);
        const noColor = shouldDisableColor(flags);
        const { config } = await resolveRuntimeConfig(flags, {}, process.cwd());
        runRulesList({
          config,
          json: options.json === true,
          noColor,
          layer: options.layer as string | undefined,
        });
      });
    });
  rules
    .command('explain <ruleId>')
    .description('explain one rule and how to override it')
    .action(async (ruleId: string, _options: Record<string, unknown>, command: Command) => {
      const flags = rootFlags(command);
      await guard(async () => {
        applyLanguage(flags, () => undefined);
        const { config } = await resolveRuntimeConfig(flags, {}, process.cwd());
        const found = runRulesExplain(ruleId, {
          config,
          json: false,
          noColor: shouldDisableColor(flags),
        });
        if (!found) process.exitCode = EXIT.usage;
      });
    });

  // ===========================================================================
  // IV. config
  // ===========================================================================
  const config = program.command('config').description('inspect and scaffold the configuration file');
  config
    .command('init')
    .description('write a starting dvc.config.json')
    .option('-o, --out <path>', 'destination path', 'dvc.config.json')
    .option('--force', 'overwrite an existing file')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const flags = rootFlags(command);
      await guard(async () => {
        applyLanguage(flags, () => undefined);
        const noColor = shouldDisableColor(flags);
        process.exitCode = await runConfigInit({
          target: options.out as string,
          force: options.force === true,
          config: getDefaultConfig(),
          noColor,
        });
      });
    });
  config
    .command('validate', { isDefault: true })
    .description('validate the configuration file that would be used here')
    .action(async (_options: Record<string, unknown>, command: Command) => {
      const flags = rootFlags(command);
      await guard(async () => {
        applyLanguage(flags, () => undefined);
        const { config, warnings } = await resolveRuntimeConfig(flags, {}, process.cwd());
        const noColor = shouldDisableColor(flags);
        printWarnings(warnings, noColor);
        process.exitCode = await runConfigValidate({ config, cwd: process.cwd(), noColor });
      });
    });
  config
    .command('show')
    .description('print the fully resolved configuration')
    .option('--json', 'emit machine-readable output')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const flags = rootFlags(command);
      await guard(async () => {
        applyLanguage(flags, () => undefined);
        const { config } = await resolveRuntimeConfig(flags, {}, process.cwd());
        runConfigShow({ config, json: options.json === true, noColor: shouldDisableColor(flags) });
      });
    });
  config
    .command('path')
    .description('print the configuration search path')
    .action(async (_options: Record<string, unknown>, command: Command) => {
      const flags = rootFlags(command);
      applyLanguage(flags, () => undefined);
      runConfigPath(process.cwd(), shouldDisableColor(flags));
    });

  // ===========================================================================
  // V. report
  // ===========================================================================
  const report = program.command('report').description('export, list and compare scan reports');
  report
    .command('export')
    .description('run a scan and persist it as a report file')
    .option('-r, --root <path...>', 'directories to scan; repeatable')
    .option('-o, --out <path>', 'explicit output path')
    .option('--format <format>', 'json or markdown', 'json')
    .option('--dir <path>', 'report directory', '.devenvclean')
    .option('--global', 'also include machine-global package manager caches')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const flags = rootFlags(command);
      await guard(async () => {
        applyLanguage(flags, () => undefined);
        const noColor = shouldDisableColor(flags);
        const { config } = await resolveRuntimeConfig(
          flags,
          { roots: options.root as readonly string[] | undefined },
          process.cwd(),
        );
        const format = options.format === 'markdown' ? 'markdown' : 'json';
        const written = await exportReport({
          roots: config.roots,
          config,
          directory: (options.dir as string | undefined) ?? config.report.dir,
          out: options.out as string | undefined,
          format,
          includeGlobal: options.global === true,
        });
        process.stdout.write(
          `${noColor ? '' : pc.green('report written')} ${written.path}\n` +
            `${config.roots.length} root(s), ${written.report.summary.targetCount} target(s), ` +
            `${written.report.summary.reclaimableBytes} bytes reclaimable\n`,
        );
      });
    });
  report
    .command('list')
    .description('list persisted reports, newest first')
    .option('--dir <path>', 'report directory', '.devenvclean')
    .option('--json', 'emit machine-readable output')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const flags = rootFlags(command);
      await guard(async () => {
        applyLanguage(flags, () => undefined);
        process.exitCode = await runReport({
          action: 'list',
          directory: (options.dir as string | undefined) ?? '.devenvclean',
          json: options.json === true,
          noColor: shouldDisableColor(flags),
          limit: 50,
        });
      });
    });
  report
    .command('diff')
    .description('compare two persisted reports and show what changed')
    .requiredOption('--from <path>', 'older report')
    .requiredOption('--to <path>', 'newer report')
    .option('--limit <n>', 'maximum rows to print', (value) => Number.parseInt(value, 10), 30)
    .option('--fail-on-growth <bytes>', 'exit 2 when the net growth exceeds this many bytes', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--json', 'emit machine-readable output')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const flags = rootFlags(command);
      await guard(async () => {
        applyLanguage(flags, () => undefined);
        process.exitCode = await runReport({
          action: 'diff',
          directory: '.devenvclean',
          from: options.from as string,
          to: options.to as string,
          json: options.json === true,
          noColor: shouldDisableColor(flags),
          limit: options.limit as number,
          failOnGrowth: options.failOnGrowth as number | undefined,
        });
      });
    });

  // ===========================================================================
  // VI. doctor
  // ===========================================================================
  program
    .command('doctor')
    .description('check the environment for anything that would break a scan or cleanup')
    .option('--json', 'emit machine-readable output')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const flags = rootFlags(command);
      await guard(async () => {
        applyLanguage(flags, () => undefined);
        const noColor = shouldDisableColor(flags);
        const { config, warnings } = await resolveRuntimeConfig(flags, {}, process.cwd());
        printWarnings(warnings, noColor);
        process.exitCode = await runDoctorCommand({
          config,
          json: options.json === true,
          noColor,
          cwd: process.cwd(),
        });
      });
    });

  // ===========================================================================
  // VII. Interactive interface, the default action
  // ===========================================================================
  program
    .command('tui', { isDefault: true })
    .description('open the interactive interface (this is the default when no command is given)')
    .option('-r, --root <path...>', 'directories to scan; repeatable')
    .option('--global', 'also include machine-global package manager caches')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const flags = rootFlags(command);
      await guard(async () => {
        const language = detectLanguage(flags.lang ?? null);
        setLanguage(language);
        const { config } = await resolveRuntimeConfig(
          flags,
          { roots: options.root as readonly string[] | undefined },
          process.cwd(),
        );
        const { runTui } = await import('../tui/run.js');
        process.exitCode = await runTui({
          config,
          language,
          includeGlobal: options.global === true,
          noColor: shouldDisableColor(flags),
        });
      });
    });

  return program;
}

/**
 * Walk up from a subcommand to the root program's global options.
 *
 * @param command - The subcommand whose parent chain to inspect.
 * @returns The root global flags.
 */
function rootFlags(command: Command): GlobalFlags {
  let current: Command | null = command;
  while (current?.parent) current = current.parent;
  return current?.opts<GlobalFlags>() ?? {};
}

/**
 * Apply the language flag, if present.
 *
 * I. Why a callback rather than a return value
 *
 * 1. Only commands that render localised text need a translator; making every
 *    action fetch one would couple the whole CLI to the i18n module.
 *
 * @param flags - Global flags.
 * @param use - Receives the resolved language.
 */
function applyLanguage(flags: GlobalFlags, use: (language: ReturnType<typeof detectLanguage>) => void): void {
  const language = detectLanguage(flags.lang ?? null);
  setLanguage(language);
  use(language);
}

/**
 * Print configuration warnings.
 *
 * @param warnings - Warnings from the config layer.
 * @param noColor - Suppress colour.
 */
function printWarnings(warnings: readonly string[], noColor: boolean): void {
  if (warnings.length === 0) return;
  const yellow = noColor ? (value: string): string => value : pc.yellow;
  for (const warning of warnings) process.stderr.write(`${yellow('config warning')} ${warning}\n`);
}

/**
 * Run a command action, converting any thrown error into a clean exit.
 *
 * I. Why not let the error escape
 *
 * 1. A raw stack trace for an expected condition — an unreadable config, a
 *    missing report — reads as a crash and buries the actual message. The user
 *    needs one sentence, not forty frames.
 * 2. `--verbose` still prints the stack, so debugging is not lost.
 *
 * @param action - The async action to run.
 */
async function guard(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const verbose = process.argv.includes('--verbose');
    if (process.argv.includes('--json')) {
      printJsonError(message, EXIT.usage);
    } else {
      process.stderr.write(`error: ${message}\n`);
      if (verbose && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = EXIT.usage;
  }
}

/**
 * Report a usage summary when no arguments are given and the TUI cannot run.
 *
 * @param program - The program to print help for.
 */
function printFallbackHelp(program: Command): void {
  program.outputHelp();
  process.stdout.write(
    `\nresolved defaults: max depth ${DEFAULT_LIMITS.maxDirectories} directories ceiling\n`,
  );
  process.stdout.write(`platform: ${getPlatform()}, home: ${getHome()}\n`);
  process.stdout.write(`${BUILTIN_RULES.length} built-in rules available\n`);
}

/**
 * Program entry point.
 *
 * @param argv - Argument vector, defaulting to `process.argv`.
 * @returns The exit code, so the caller can set `process.exitCode`.
 */
export async function main(argv: readonly string[] = process.argv): Promise<number> {
  const program = buildProgram();

  // I. Ctrl-C during a long scan must exit with the shell convention and must
  //    not print a stack trace over the progress line.
  process.on('SIGINT', () => {
    process.stderr.write('\ninterrupted\n');
    process.exit(EXIT.interrupted);
  });

  // II. `--help` and `--version` are handled by commander and must not fall back
  //     to launching the TUI, so the help-only case is detected first.
  if (argv.length <= 2) {
    const wantsInteractive = process.stdout.isTTY === true && process.stdin.isTTY === true;
    if (!wantsInteractive) {
      printFallbackHelp(program);
      return EXIT.success;
    }
  }

  await program.parseAsync([...argv]);
  return process.exitCode === undefined ? EXIT.success : Number(process.exitCode);
}

/**
 * Decide whether this module is the program being run.
 *
 * I. Why the naive comparison is not enough
 *
 * 1. Every package manager installs a `bin` as a **symlink**:
 *    `node_modules/.bin/dvc -> ../devenv-cleaner/dist/cli.js`. Node reports
 *    `process.argv[1]` as the path that was invoked — the symlink — while
 *    `import.meta.url` is the *resolved* file URL. The two strings therefore
 *    never match for an installed package, and comparing them directly makes the
 *    binary exit silently with status 0 while `node dist/cli.js` works fine.
 * 2. That failure is invisible in development, because a developer runs the
 *    real path, and invisible to the unit tests, which import `main` directly.
 *    It only appears for a user who installed the package — which is why the
 *    artifact check in `scripts/verify-package.ts` executes the linked binary
 *    rather than the file it points at.
 * 3. Both sides are therefore resolved to their real path before comparing.
 *    The fallback covers the case where `argv[1]` cannot be resolved (a deleted
 *    entry point, an exotic loader) and keeps the comparison meaningful there.
 *
 * @returns True when this module is the process entry point.
 */
function isDirectInvocation(): boolean {
  const entryPoint = process.argv[1];
  if (entryPoint === undefined) return false;

  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entryPoint);
  } catch {
    // `pathToFileURL` normalizes a path containing spaces or a Windows drive
    // letter, which naive string concatenation would get wrong.
    return import.meta.url === pathToFileURL(entryPoint).href;
  }
}

if (isDirectInvocation()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = EXIT.usage;
    });
}
