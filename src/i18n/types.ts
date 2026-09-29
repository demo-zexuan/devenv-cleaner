/**
 * Internationalisation Message Contract
 *
 * Declares the supported languages, the language-detection rules and the exact
 * shape of every user-visible string in the product.
 *
 * I. Why the message table is typed rather than just keyed by string
 *
 * 1. `Messages` is a closed, literal-keyed record, so `MessageKey` is a finite
 *    union. A typo in a `t(...)` call is therefore a compile error instead of a
 *    silent `undefined` rendered into the TUI.
 * 2. Both dictionaries are declared as `Record<Language, Messages>` in
 *    `index.ts`. A key added to one language but not the other fails the build
 *    immediately, which is the only reliable way to keep two hand-written
 *    tables in step.
 * 3. Rule labels follow the same principle: one `rule.<ruleId>` key per entry
 *    of the built-in catalog, checked at module init and by the test suite.
 *
 * II. Language policy
 *
 * 1. English is the default. The primary audience is Chinese-speaking
 *    developers, but the tool is published openly, so Chinese is opt-in through
 *    `--lang zh` or `DEV_ENV_CLEANER_LANG=zh`.
 * 2. `LANG` / `LC_ALL` are deliberately *not* consulted: a machine-level locale
 *    would flip the language for every user without them asking, and mixing
 *    languages inside one screen is the one thing the TUI must never do.
 *
 * III. Placeholders
 *
 * 1. Slots are written `{name}` and filled from `MessageParams`.
 * 2. A slot with no matching parameter is left verbatim rather than replaced by
 *    an empty string — see `interpolate` in `index.ts` for the reasoning.
 *
 * @module i18n/types
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

/** A language the interface can be rendered in. */
export type Language = 'en' | 'zh';

/** Every supported language, in display order; the first entry is the default. */
export const LANGUAGES: readonly Language[] = ['en', 'zh'];

/** Fallback language, used when neither an explicit flag nor the env var is set. */
const DEFAULT_LANGUAGE: Language = 'en';

/** Environment variable holding the opt-in language override, e.g. `zh`. */
const ENV_LANGUAGE_VAR = 'DEV_ENV_CLEANER_LANG';

/**
 * Test whether a value is exactly one of the supported language codes.
 *
 * I. Contract
 *
 * 1. This is a strict type guard: it returns true only for the literal `en` or
 *    `zh` values of {@link Language}, so it can be used to narrow `string`.
 * 2. It is therefore *not* the place to accept regional tags such as `zh-CN`.
 *    Use {@link detectLanguage} for raw user input; it normalises first.
 *
 * @param value - Raw string to test.
 * @returns True when `value` is a supported {@link Language}.
 *
 * @example
 * ```ts
 * isLanguage('zh')     // true
 * isLanguage('zh-CN')  // false — use detectLanguage for tags like this
 * ```
 */
export function isLanguage(value: string): value is Language {
  // The widening cast exists only so the membership test compiles; the list
  // itself stays the single source of truth, so adding a language is one edit.
  return (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Reduce a loose BCP-47 tag to a supported language.
 *
 * I. Normalisation
 *
 * 1. Case is folded and surrounding whitespace dropped, so `ZH`, `zh-cn` and
 *    `zh_CN.UTF-8` all resolve.
 * 2. Script and region subtags are discarded. There is one Chinese table, in
 *    Simplified Chinese; for a `zh-Hant` user that table is still a closer fit
 *    than English, and pretending otherwise would show a half-translated UI.
 * 3. Anything unrecognised yields null rather than a guess, letting the caller
 *    fall back deterministically to the default language.
 *
 * @param value - Raw tag, or null/undefined when nothing was supplied.
 * @returns The matching supported language, or null.
 */
function normalizeLanguageTag(value: string | null | undefined): Language | null {
  if (!value) return null;
  const primary = value.trim().toLowerCase().split(/[-_.]/)[0] ?? '';
  return isLanguage(primary) ? primary : null;
}

/**
 * Resolve the language to use for this process.
 *
 * I. Precedence
 *
 * 1. The explicit value (a `--lang` flag) always wins.
 * 2. `DEV_ENV_CLEANER_LANG` is consulted next, so a shell profile or CI job can
 *    pin the language without repeating a flag.
 * 3. English is the default: the open-source audience reads English, and the
 *    Chinese table is an opt-in convenience for the primary users.
 *
 * @param explicit - Value of `--lang`, when the flag was passed.
 * @returns The resolved language; never throws on an unknown value.
 *
 * @example
 * ```ts
 * detectLanguage('zh')   // 'zh'
 * detectLanguage(null)   // 'en' unless DEV_ENV_CLEANER_LANG is set
 * ```
 */
export function detectLanguage(explicit?: string | null): Language {
  const fromExplicit = normalizeLanguageTag(explicit);
  if (fromExplicit) return fromExplicit;

  const fromEnvironment = normalizeLanguageTag(process.env[ENV_LANGUAGE_VAR]);
  if (fromEnvironment) return fromEnvironment;

  return DEFAULT_LANGUAGE;
}

/**
 * Every user-visible string in the product.
 *
 * I. Reading this interface
 *
 * 1. Keys are flat and dotted (`screen.element`), never nested objects: a flat
 *    record makes key parity between languages a single `Object.keys` compare,
 *    and keeps `MessageKey` a plain union.
 * 2. `{name}` marks an interpolation slot; the parameter names are the ones a
 *    caller passes in `MessageParams`.
 * 3. Values are pure text. No ANSI colour, no terminal control characters —
 *    styling is the TUI's concern, and colour-blind or `NO_COLOR` terminals
 *    must still receive complete information.
 */
export interface Messages {
  // ---------------------------------------------------------------------
  // I. Application
  // ---------------------------------------------------------------------

  /** Product name; a brand, intentionally identical in every language. */
  'app.name': string;
  /** One-line description used by `--help` and the TUI header. */
  'app.tagline': string;

  // ---------------------------------------------------------------------
  // II. Commands
  // ---------------------------------------------------------------------

  /** One-line summary of `dvc scan`, shown in `--help`. */
  'cmd.scan': string;
  /** One-line summary of `dvc clean`, shown in `--help`. */
  'cmd.clean': string;
  /** One-line summary of `dvc rules`, shown in `--help`. */
  'cmd.rules': string;
  /** One-line summary of `dvc config`, shown in `--help`. */
  'cmd.config': string;
  /** One-line summary of `dvc report`, shown in `--help`. */
  'cmd.report': string;
  /** One-line summary of `dvc doctor`, shown in `--help`. */
  'cmd.doctor': string;

  // ---------------------------------------------------------------------
  // III. Scan progress and outcome
  // ---------------------------------------------------------------------

  /** Live label while projects are being detected. */
  'scan.phase.discovering': string;
  /** Live label while directory sizes are being measured. */
  'scan.phase.measuring': string;
  /** Live label while aggregates and sorting are computed. */
  'scan.phase.finalizing': string;
  /** Directories visited so far. Slots: `{count}`. */
  'scan.progress.dirs': string;
  /** Targets found and bytes measured so far. Slots: `{count}`, `{bytes}`. */
  'scan.progress.targets': string;
  /** Closing summary of a scan. Slots: `{duration}`, `{count}`, `{bytes}`. */
  'scan.complete': string;
  /** Warning that the directory ceiling stopped the walk early. */
  'scan.truncated': string;
  /** Count of directories that could not be read. Slots: `{count}`. */
  'scan.skippedDirs': string;
  /** Shown when a scan produced no removable target at all. */
  'scan.noTargets': string;

  // ---------------------------------------------------------------------
  // IV. Result table columns
  // ---------------------------------------------------------------------

  /** Column header: human-readable size. */
  'col.size': string;
  /** Column header: directory path. */
  'col.path': string;
  /** Column header: owning rule. */
  'col.rule': string;
  /** Column header: lifecycle layer. */
  'col.layer': string;
  /** Column header: risk level. */
  'col.risk': string;
  /** Column header: age since the newest contained file. */
  'col.age': string;
  /** Column header: contained file count. */
  'col.files': string;
  /** Column header: share of the total reclaimable bytes. */
  'col.percent': string;
  /** Column header: lock state. */
  'col.status': string;

  // ---------------------------------------------------------------------
  // V. Lifecycle layers (one per TargetLayer)
  // ---------------------------------------------------------------------

  /** Re-installable dependency trees. */
  'layer.dependencies': string;
  /** Rebuildable compiler and bundler output. */
  'layer.build': string;
  /** Caches that only cost time when lost. */
  'layer.cache': string;
  /** Output that may not be reproducible at all. */
  'layer.artifacts': string;

  // ---------------------------------------------------------------------
  // VI. Risk levels (one per RiskLevel)
  // ---------------------------------------------------------------------

  /** Risk: recreatable with no side effects. */
  'risk.safe': string;
  /** Risk: cheap to recreate. */
  'risk.low': string;
  /** Risk: recreation costs noticeable time or network traffic. */
  'risk.medium': string;
  /** Risk: recreation is slow, large or may lose irreplaceable data. */
  'risk.high': string;

  // ---------------------------------------------------------------------
  // VII. Target kinds (one per TargetKind)
  // ---------------------------------------------------------------------

  /** Installed Node packages. */
  'kind.node_modules': string;
  /** Vendored third-party dependencies. */
  'kind.vendor': string;
  /** Python virtual environment. */
  'kind.venv': string;
  /** Build output. */
  'kind.build': string;
  /** Tool or package cache. */
  'kind.cache': string;
  /** Accumulated log files. */
  'kind.logs': string;
  /** Scratch or temporary files. */
  'kind.temp': string;
  /** Test coverage and test-runner reports. */
  'kind.coverage': string;
  /** Packaged or archived output. */
  'kind.artifacts': string;

  // ---------------------------------------------------------------------
  // VIII. Lock reasons (one per LockReason, plus the explanation line)
  // ---------------------------------------------------------------------

  /** Lock: path is on the protected system denylist. */
  'lock.protected-path': string;
  /** Lock: path matched the user's whitelist. */
  'lock.whitelisted': string;
  /** Lock: below `minSizeBytes`, so reclaiming it is not worth the risk. */
  'lock.too-small': string;
  /** Lock: newer than the configured `olderThanDays` threshold. */
  'lock.too-recent': string;
  /** Lock: effective risk is above what the policy allows to delete. */
  'lock.risk-exceeds-policy': string;
  /** Lock: resolved path escapes the scan root. */
  'lock.outside-root': string;
  /** Lock: disabled or pinned by the user's config. */
  'lock.user-config': string;
  /** Explains what "locked" means and lists the reasons. Slots: `{reasons}`. */
  'lock.explanation': string;

  // ---------------------------------------------------------------------
  // IX. TUI key hints, counters and group labels
  // ---------------------------------------------------------------------

  /** Key hint: move the cursor. */
  'tui.hint.move': string;
  /** Key hint: toggle selection. */
  'tui.hint.toggle': string;
  /** Key hint: select every visible target. */
  'tui.hint.all': string;
  /** Key hint: clear the selection. */
  'tui.hint.none': string;
  /** Key hint: incremental search. */
  'tui.hint.search': string;
  /** Key hint: filter by layer, kind or status. */
  'tui.hint.filter': string;
  /** Key hint: change the sort column. */
  'tui.hint.sort': string;
  /** Key hint: open the cleanup preview. */
  'tui.hint.preview': string;
  /** Key hint: confirm the current screen. */
  'tui.hint.confirm': string;
  /** Key hint: leave the TUI. */
  'tui.hint.quit': string;
  /** Selected totals in the status bar. Slots: `{count}`, `{bytes}`. */
  'tui.selected': string;
  /** Filter label: no filter applied. */
  'tui.filter.all': string;
  /** Sort label: by size. */
  'tui.sort.size': string;
  /** Sort label: by age. */
  'tui.sort.age': string;
  /** Sort label: by path. */
  'tui.sort.path': string;
  /** Group label: group targets by their project. */
  'tui.group.byProject': string;
  /** Group label: group targets by lifecycle layer. */
  'tui.group.byLayer': string;
  /** Group label: group targets by owning rule. */
  'tui.group.byRule': string;
  /** Group label for machine-global targets that belong to no project. */
  'tui.looseTargets': string;

  // ---------------------------------------------------------------------
  // X. Preview, confirmation and execution
  // ---------------------------------------------------------------------

  /** Title of the cleanup preview screen. */
  'preview.title': string;
  /** Totals line of the preview. Slots: `{count}`, `{bytes}`. */
  'preview.subtitle': string;
  /** Shown when the preview is opened with an empty selection. */
  'preview.nothingSelected': string;
  /** Title of the confirmation prompt. */
  'confirm.title': string;
  /** Confirmation question. Slots: `{count}`, `{bytes}`. */
  'confirm.prompt': string;
  /** Confirm answer: proceed with the deletion. */
  'confirm.yes': string;
  /** Confirm answer: abort and keep everything. */
  'confirm.no': string;
  /** Shown while the executor deletes targets. */
  'execute.running': string;
  /** Closing summary of an execution. Slots: `{duration}`, `{bytes}`. */
  'execute.done': string;
  /** Per-target outcome: deleted. */
  'outcome.deleted': string;
  /** Per-target outcome: skipped before touching the filesystem. */
  'outcome.skipped': string;
  /** Per-target outcome: the deletion failed. */
  'outcome.failed': string;
  /** Banner shown when the execution ran in dry-run mode. */
  'execute.dryRunNotice': string;

  // ---------------------------------------------------------------------
  // XI. Reports and report diffs
  // ---------------------------------------------------------------------

  /** Confirmation that a report file was written. Slots: `{path}`. */
  'report.exported': string;
  /** Title of a report-to-report diff. */
  'report.diff.title': string;
  /** Net byte change between two reports. Slots: `{delta}`. */
  'report.diff.net': string;
  /** Shown when the two reports are byte-identical. */
  'report.diff.noChange': string;
  /** Change verb: the path got bigger. */
  'report.diff.grew': string;
  /** Change verb: the path got smaller. */
  'report.diff.shrank': string;
  /** Change verb: the path is only in the newer report. */
  'report.diff.added': string;
  /** Change verb: the path is only in the older report. */
  'report.diff.removed': string;
  /** Change verb: the path is in both reports with the same size. */
  'report.diff.unchanged': string;

  // ---------------------------------------------------------------------
  // XII. Doctor
  // ---------------------------------------------------------------------

  /** Title of the environment check. */
  'doctor.title': string;
  /** Check status: passed. */
  'doctor.pass': string;
  /** Check status: passed with a caveat. */
  'doctor.warn': string;
  /** Check status: failed and must be fixed. */
  'doctor.fail': string;
  /** Remediation line under a non-passing check. Slots: `{hint}`. */
  'doctor.hint': string;

  // ---------------------------------------------------------------------
  // XIII. Errors
  // ---------------------------------------------------------------------

  /** Error: the path does not exist. Slots: `{path}`. */
  'error.notFound': string;
  /** Error: the filesystem refused access. Slots: `{path}`. */
  'error.permission': string;
  /** Error: the config file is malformed. Slots: `{path}`, `{detail}`. */
  'error.invalidConfig': string;
  /** Error: the user interrupted the operation. */
  'error.aborted': string;
  /** Error: a path resolved outside the scan root. Slots: `{path}`. */
  'error.outsideRoot': string;
  /** Error: an unknown rule id was referenced. Slots: `{ruleId}`. */
  'error.unknownRule': string;
  /** Error: anything else, with the underlying message. Slots: `{detail}`. */
  'error.generic': string;

  // ---------------------------------------------------------------------
  // XIV. Counting units
  // ---------------------------------------------------------------------

  /** A number of files. Slots: `{count}`. */
  'unit.files': string;
  /** A number of targets. Slots: `{count}`. */
  'unit.targets': string;
  /** A number of days. Slots: `{count}`. */
  'unit.days': string;
  /**
   * A raw byte count.
   *
   * Slots: `{value}`. Prefer `formatBytes` for sizes; this unit exists for the
   * rare place that needs the word "bytes" rather than a scaled magnitude.
   */
  'unit.bytes': string;

  // ---------------------------------------------------------------------
  // XV. List joining
  //
  // 1. Punctuation between list items is language-specific: English uses
  //    ", a and b" while Chinese uses "、a 和 b". Hard-coding either in the
  //    joining helper would leak English typography into the Chinese UI, so
  //    both pieces are messages.
  // 2. `list.conjunction` is the whole glue before the final item, including
  //    its spacing, so it can be swapped for "or" without touching the helper.
  // ---------------------------------------------------------------------

  /** Separator between non-final list items, e.g. `, ` or `、`. */
  'list.separator': string;
  /** Glue before the final list item, e.g. ` and ` or ` 和 `. */
  'list.conjunction': string;

  // ---------------------------------------------------------------------
  // XVI. Rule labels
  //
  // 1. One key per entry of `BUILTIN_RULES`, named `rule.<ruleId>`. The catalog
  //    remains the source of truth for ids; these keys carry the translations.
  // 2. The `rule(ruleId, fallback)` accessor in `index.ts` prefers the
  //    translation and falls back to the catalog's own English label, so a
  //    missing entry degrades to English instead of throwing at runtime — the
  //    module-init assertion and the test suite are what stop that from
  //    shipping.
  // ---------------------------------------------------------------------

  /** Rule `node-modules`. */
  'rule.node-modules': string;
  /** Rule `node-next-cache`. */
  'rule.node-next-cache': string;
  /** Rule `node-next-output`. */
  'rule.node-next-output': string;
  /** Rule `node-nuxt`. */
  'rule.node-nuxt': string;
  /** Rule `node-build-output`. */
  'rule.node-build-output': string;
  /** Rule `node-vite-cache`. */
  'rule.node-vite-cache': string;
  /** Rule `node-parcel-cache`. */
  'rule.node-parcel-cache': string;
  /** Rule `node-swc-cache`. */
  'rule.node-swc-cache': string;
  /** Rule `node-storybook`. */
  'rule.node-storybook': string;
  /** Rule `node-tests-cache`. */
  'rule.node-tests-cache': string;
  /** Rule `python-venv`. */
  'rule.python-venv': string;
  /** Rule `python-pycache`. */
  'rule.python-pycache': string;
  /** Rule `python-eggs`. */
  'rule.python-eggs': string;
  /** Rule `python-tox`. */
  'rule.python-tox': string;
  /** Rule `python-pytest-cache`. */
  'rule.python-pytest-cache': string;
  /** Rule `python-ipynb-checkpoints`. */
  'rule.python-ipynb-checkpoints': string;
  /** Rule `rust-target`. */
  'rule.rust-target': string;
  /** Rule `rust-registry-cache`. */
  'rule.rust-registry-cache': string;
  /** Rule `go-build-cache`. */
  'rule.go-build-cache': string;
  /** Rule `go-mod-cache`. */
  'rule.go-mod-cache': string;
  /** Rule `java-gradle-project-cache`. */
  'rule.java-gradle-project-cache': string;
  /** Rule `java-gradle-build`. */
  'rule.java-gradle-build': string;
  /** Rule `java-gradle-global-cache`. */
  'rule.java-gradle-global-cache': string;
  /** Rule `java-maven-repo`. */
  'rule.java-maven-repo': string;
  /** Rule `java-target`. */
  'rule.java-target': string;
  /** Rule `php-vendor`. */
  'rule.php-vendor': string;
  /** Rule `ruby-bundle`. */
  'rule.ruby-bundle': string;
  /** Rule `dotnet-build`. */
  'rule.dotnet-build': string;
  /** Rule `elixir-deps`. */
  'rule.elixir-deps': string;
  /** Rule `elixir-build`. */
  'rule.elixir-build': string;
  /** Rule `swift-build`. */
  'rule.swift-build': string;
  /** Rule `cpp-build`. */
  'rule.cpp-build': string;
  /** Rule `generic-cache`. */
  'rule.generic-cache': string;
  /** Rule `generic-logs`. */
  'rule.generic-logs': string;
  /** Rule `generic-tmp`. */
  'rule.generic-tmp': string;
  /** Rule `global-npm-cache`. */
  'rule.global-npm-cache': string;
  /** Rule `global-pnpm-store`. */
  'rule.global-pnpm-store': string;
  /** Rule `global-yarn-cache`. */
  'rule.global-yarn-cache': string;
  /** Rule `global-pip-cache`. */
  'rule.global-pip-cache': string;
  /** Rule `global-uv-cache`. */
  'rule.global-uv-cache': string;
  /** Rule `global-xcode-derived-data`. */
  'rule.global-xcode-derived-data': string;
  /** Rule `global-xcode-archives`. */
  'rule.global-xcode-archives': string;
  /** Rule `global-cocoapods`. */
  'rule.global-cocoapods': string;
  /** Rule `global-homebrew-cache`. */
  'rule.global-homebrew-cache': string;
  /** Rule `global-docker-report`. */
  'rule.global-docker-report': string;
}

/** Any key of the message table; a finite union, so typos fail to compile. */
export type MessageKey = keyof Messages;

/**
 * Values interpolated into a message.
 *
 * Numbers are accepted so callers can pass raw counts without formatting them
 * first; anything that needs unit scaling or grouping should already have been
 * run through `core/format.ts` and passed as a string.
 */
export type MessageParams = Record<string, string | number>;
