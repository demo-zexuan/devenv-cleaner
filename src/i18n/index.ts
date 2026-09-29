/**
 * Internationalisation Runtime
 *
 * Holds the English and Chinese message tables and the lookup helpers that turn
 * a key plus interpolation parameters into display text.
 *
 * I. Design intent
 *
 * 1. Messages are pure data. No colour, no terminal escape sequences, no
 *    layout: `core/format.ts` renders numbers and paths, the TUI renders colour,
 *    and this module only picks words.
 * 2. English is the default and Chinese is opt-in (`--lang zh`,
 *    `DEV_ENV_CLEANER_LANG=zh`). See `./types.ts` for the detection rules.
 * 3. One screen is rendered in exactly one language. That is why a missing
 *    translation is treated as a bug to be caught loudly rather than papered
 *    over with a per-key English fallback.
 *
 * II. Consistency guards
 *
 * 1. `MESSAGES` is typed `Record<Language, Messages>`, so a key that exists in
 *    one table and not the other cannot compile.
 * 2. `assertMessageTables()` additionally runs at module init and throws on a
 *    key-set mismatch, an empty string, or a rule-label key that has drifted
 *    away from `BUILTIN_RULES`. The compile-time check cannot see an extra key
 *    that both tables share by accident, nor an empty value, nor a rule id that
 *    was renamed in the catalog; this does.
 * 3. The check is cheap (a few hundred string comparisons, once per process) and
 *    therefore unconditional rather than dev-only: a published bundle shipping a
 *    half-filled table is a far worse failure than a startup error.
 *
 * III. Missing parameters
 *
 * 1. `{name}` slots with no matching entry in `params` are left verbatim in the
 *    output. Throwing or substituting an empty string would hide a caller bug;
 *    a visible `{bytes}` in the TUI is trivial to report and trivial to trace.
 *
 * @module i18n
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import type {
  CleanOutcome,
  DoctorStatus,
  LockReason,
  RiskLevel,
  TargetKind,
  TargetLayer,
} from '../core/types.js';
import { BUILTIN_RULES } from '../rules/builtin.js';
import {
  detectLanguage,
  LANGUAGES,
  type Language,
  type MessageKey,
  type MessageParams,
  type Messages,
} from './types.js';

/**
 * English message table: the default language and the reference key set.
 *
 * Wording rules kept consistent across every entry: sentence case, no trailing
 * full stop on a label or key hint, and a full stop only on a complete sentence.
 */
const EN_MESSAGES: Messages = {
  // I. Application
  'app.name': 'DevEnvCleaner',
  'app.tagline': 'Reclaim disk space from development caches',

  // II. Commands
  'cmd.scan': 'Scan for reclaimable directories',
  'cmd.clean': 'Delete the selected directories',
  'cmd.rules': 'List the built-in cleanup rules',
  'cmd.config': 'Show or edit the configuration',
  'cmd.report': 'Export or compare scan reports',
  'cmd.doctor': 'Check that the environment is ready',

  // III. Scan progress and outcome
  'scan.phase.discovering': 'Discovering projects',
  'scan.phase.measuring': 'Measuring directories',
  'scan.phase.finalizing': 'Finalizing results',
  'scan.progress.dirs': 'Directories: {count}',
  'scan.progress.targets': 'Targets: {count} ({bytes})',
  'scan.complete': 'Scan finished in {duration}: {count} targets, {bytes}',
  'scan.truncated': 'Directory ceiling reached; results are partial',
  'scan.skippedDirs': 'Skipped {count} unreadable directories',
  'scan.noTargets': 'Nothing to clean: no reclaimable directories found',

  // IV. Result table columns
  'col.size': 'Size',
  'col.path': 'Path',
  'col.rule': 'Rule',
  'col.layer': 'Layer',
  'col.risk': 'Risk',
  'col.age': 'Age',
  'col.files': 'Files',
  'col.percent': '%',
  'col.status': 'Status',

  // V. Lifecycle layers
  'layer.dependencies': 'Dependencies',
  'layer.build': 'Build output',
  'layer.cache': 'Cache',
  'layer.artifacts': 'Artifacts',

  // VI. Risk levels
  'risk.safe': 'Safe',
  'risk.low': 'Low',
  'risk.medium': 'Medium',
  'risk.high': 'High',

  // VII. Target kinds
  'kind.node_modules': 'Node modules',
  'kind.vendor': 'Vendored dependencies',
  'kind.venv': 'Virtual environment',
  'kind.build': 'Build output',
  'kind.cache': 'Cache',
  'kind.logs': 'Logs',
  'kind.temp': 'Temporary files',
  'kind.coverage': 'Coverage reports',
  'kind.artifacts': 'Archived artifacts',

  // VIII. Lock reasons
  'lock.protected-path': 'Protected system path',
  'lock.whitelisted': 'On the whitelist',
  'lock.too-small': 'Below the minimum size',
  'lock.too-recent': 'Modified recently',
  'lock.risk-exceeds-policy': 'Risk above the configured policy',
  'lock.outside-root': 'Outside the scan root',
  'lock.user-config': 'Locked by user config',
  'lock.explanation':
    'Locked targets are listed so you can see them, but they cannot be selected for deletion. Reasons: {reasons}.',

  // IX. TUI key hints, counters and group labels
  'tui.hint.move': '↑↓ move',
  'tui.hint.toggle': 'space select',
  'tui.hint.all': 'a all',
  'tui.hint.none': 'n none',
  'tui.hint.search': '/ search',
  'tui.hint.filter': 'f filter',
  'tui.hint.sort': 's sort',
  'tui.hint.preview': 'p preview',
  'tui.hint.confirm': 'enter confirm',
  'tui.hint.quit': 'q quit',
  'tui.selected': '{count} selected · {bytes}',
  'tui.filter.all': 'All',
  'tui.sort.size': 'Size',
  'tui.sort.age': 'Age',
  'tui.sort.path': 'Path',
  'tui.group.byProject': 'By project',
  'tui.group.byLayer': 'By layer',
  'tui.group.byRule': 'By rule',
  'tui.looseTargets': 'Other targets',

  // X. Preview, confirmation and execution
  'preview.title': 'Cleanup preview',
  'preview.subtitle': '{count} targets · {bytes}',
  'preview.nothingSelected': 'Nothing selected yet',
  'confirm.title': 'Confirm deletion',
  'confirm.prompt': 'Delete {count} targets and free {bytes}? This cannot be undone.',
  'confirm.yes': 'Delete',
  'confirm.no': 'Cancel',
  'execute.running': 'Deleting…',
  'execute.done': 'Done in {duration}: freed {bytes}',
  'outcome.deleted': 'Deleted',
  'outcome.skipped': 'Skipped',
  'outcome.failed': 'Failed',
  'execute.dryRunNotice': 'Dry run: nothing was deleted',

  // XI. Reports and report diffs
  'report.exported': 'Report written to {path}',
  'report.diff.title': 'Report comparison',
  'report.diff.net': 'Net change: {delta}',
  'report.diff.noChange': 'No change between the two reports',
  'report.diff.grew': 'Grew',
  'report.diff.shrank': 'Shrank',
  'report.diff.added': 'Added',
  'report.diff.removed': 'Removed',
  'report.diff.unchanged': 'Unchanged',

  // XII. Doctor
  'doctor.title': 'Environment check',
  'doctor.pass': 'Pass',
  'doctor.warn': 'Warning',
  'doctor.fail': 'Fail',
  'doctor.hint': 'Hint: {hint}',

  // XIII. Errors
  'error.notFound': 'Path not found: {path}',
  'error.permission': 'Permission denied: {path}',
  'error.invalidConfig': 'Invalid config at {path}: {detail}',
  'error.aborted': 'Aborted',
  'error.outsideRoot': '{path} is outside the scan root',
  'error.unknownRule': 'Unknown rule: {ruleId}',
  'error.generic': 'Something went wrong: {detail}',

  // XIV. Counting units
  'unit.files': '{count} files',
  'unit.targets': '{count} targets',
  'unit.days': '{count} days',
  'unit.bytes': '{value} bytes',

  // XV. List joining
  'list.separator': ', ',
  'list.conjunction': ' and ',

  // XVI. Rule labels, one per BUILTIN_RULES entry
  'rule.node-modules': 'Node Dependencies',
  'rule.node-next-cache': 'Next.js Build Cache',
  'rule.node-next-output': 'Next.js Build Output',
  'rule.node-nuxt': 'Nuxt Build Output',
  'rule.node-build-output': 'JS/TS Build Output',
  'rule.node-vite-cache': 'Vite / Turbopack Cache',
  'rule.node-parcel-cache': 'Parcel Cache',
  'rule.node-swc-cache': 'SWC / esbuild Cache',
  'rule.node-storybook': 'Storybook Output',
  'rule.node-tests-cache': 'Test Coverage & Caches',
  'rule.python-venv': 'Python Virtualenv',
  'rule.python-pycache': 'Python Bytecode Cache',
  'rule.python-eggs': 'Python Packaging Artifacts',
  'rule.python-tox': 'Tox / Nox Environments',
  'rule.python-pytest-cache': 'Pytest / Mypy Cache',
  'rule.python-ipynb-checkpoints': 'Jupyter Checkpoints',
  'rule.rust-target': 'Rust Build Target',
  'rule.rust-registry-cache': 'Cargo Registry Cache',
  'rule.go-build-cache': 'Go Build Cache',
  'rule.go-mod-cache': 'Go Module Cache',
  'rule.java-gradle-project-cache': 'Gradle Project Cache',
  'rule.java-gradle-build': 'Gradle Build Output',
  'rule.java-gradle-global-cache': 'Gradle Global Caches',
  'rule.java-maven-repo': 'Maven Local Repository',
  'rule.java-target': 'JVM Build Output',
  'rule.php-vendor': 'PHP Vendor Dependencies',
  'rule.ruby-bundle': 'Ruby Bundle Path',
  'rule.dotnet-build': '.NET Build Output',
  'rule.elixir-deps': 'Elixir Dependencies',
  'rule.elixir-build': 'Elixir Build Output',
  'rule.swift-build': 'SwiftPM Build Directory',
  'rule.cpp-build': 'CMake / Meson Build Tree',
  'rule.generic-cache': 'Project Cache Directory',
  'rule.generic-logs': 'Project Log Files',
  'rule.generic-tmp': 'Temporary Output',
  'rule.global-npm-cache': 'npm Cache',
  'rule.global-pnpm-store': 'pnpm Content Store',
  'rule.global-yarn-cache': 'Yarn Cache',
  'rule.global-pip-cache': 'pip Download Cache',
  'rule.global-uv-cache': 'uv Cache',
  'rule.global-xcode-derived-data': 'Xcode DerivedData',
  'rule.global-xcode-archives': 'Xcode Archives',
  'rule.global-cocoapods': 'CocoaPods Cache',
  'rule.global-homebrew-cache': 'Homebrew Download Cache',
  'rule.global-docker-report': 'Docker Data (report only)',
};

/**
 * Chinese message table.
 *
 * Written as Chinese rather than translated word-for-word: labels are short
 * enough for a narrow terminal, and product nouns that developers already say in
 * English (`node_modules`, `Xcode`, `DerivedData`) are kept in English because
 * transliterating them would make the screen harder to scan, not easier.
 */
const ZH_MESSAGES: Messages = {
  // I. Application
  'app.name': 'DevEnvCleaner',
  'app.tagline': '回收开发缓存占用的磁盘空间',

  // II. Commands
  'cmd.scan': '扫描可回收的目录',
  'cmd.clean': '删除选中的目录',
  'cmd.rules': '查看内置清理规则',
  'cmd.config': '查看或修改配置',
  'cmd.report': '导出或对比扫描报告',
  'cmd.doctor': '检查运行环境是否就绪',

  // III. Scan progress and outcome
  'scan.phase.discovering': '正在发现项目',
  'scan.phase.measuring': '正在统计目录大小',
  'scan.phase.finalizing': '正在汇总结果',
  'scan.progress.dirs': '已扫描目录：{count}',
  'scan.progress.targets': '已发现目标 {count} 个（{bytes}）',
  'scan.complete': '扫描完成，用时 {duration}：{count} 个目标，共 {bytes}',
  'scan.truncated': '已达目录上限，结果为部分扫描',
  'scan.skippedDirs': '已跳过 {count} 个无法读取的目录',
  'scan.noTargets': '没有可清理的内容：未发现可回收目录',

  // IV. Result table columns
  'col.size': '大小',
  'col.path': '路径',
  'col.rule': '规则',
  'col.layer': '层级',
  'col.risk': '风险',
  'col.age': '最后修改',
  'col.files': '文件数',
  'col.percent': '占比',
  'col.status': '状态',

  // V. Lifecycle layers
  'layer.dependencies': '依赖',
  'layer.build': '构建产物',
  'layer.cache': '缓存',
  'layer.artifacts': '归档产物',

  // VI. Risk levels
  'risk.safe': '安全',
  'risk.low': '低',
  'risk.medium': '中',
  'risk.high': '高',

  // VII. Target kinds
  'kind.node_modules': 'Node 依赖目录',
  'kind.vendor': '第三方依赖目录',
  'kind.venv': 'Python 虚拟环境',
  'kind.build': '构建产物',
  'kind.cache': '缓存',
  'kind.logs': '日志',
  'kind.temp': '临时文件',
  'kind.coverage': '覆盖率报告',
  'kind.artifacts': '归档产物',

  // VIII. Lock reasons
  'lock.protected-path': '受保护的系统路径',
  'lock.whitelisted': '已列入白名单',
  'lock.too-small': '未达到最小体积',
  'lock.too-recent': '最近有改动',
  'lock.risk-exceeds-policy': '风险等级超出策略限制',
  'lock.outside-root': '不在扫描根目录内',
  'lock.user-config': '已被用户配置锁定',
  'lock.explanation': '锁定的目标仍会列出以便查看，但无法选中删除。原因包括：{reasons}。',

  // IX. TUI key hints, counters and group labels
  'tui.hint.move': '↑↓ 移动',
  'tui.hint.toggle': '空格 选择',
  'tui.hint.all': 'a 全选',
  'tui.hint.none': 'n 全不选',
  'tui.hint.search': '/ 搜索',
  'tui.hint.filter': 'f 过滤',
  'tui.hint.sort': 's 排序',
  'tui.hint.preview': 'p 预览',
  'tui.hint.confirm': 'enter 确认',
  'tui.hint.quit': 'q 退出',
  'tui.selected': '已选 {count} 个目标 · {bytes}',
  'tui.filter.all': '全部',
  'tui.sort.size': '大小',
  'tui.sort.age': '最后修改',
  'tui.sort.path': '路径',
  'tui.group.byProject': '按项目',
  'tui.group.byLayer': '按层级',
  'tui.group.byRule': '按规则',
  'tui.looseTargets': '其他目标',

  // X. Preview, confirmation and execution
  'preview.title': '清理预览',
  'preview.subtitle': '{count} 个目标 · {bytes}',
  'preview.nothingSelected': '尚未选择任何目标',
  'confirm.title': '确认删除',
  'confirm.prompt': '将删除 {count} 个目标并释放 {bytes}，此操作不可撤销。是否继续？',
  'confirm.yes': '删除',
  'confirm.no': '取消',
  'execute.running': '正在删除…',
  'execute.done': '完成，用时 {duration}：已释放 {bytes}',
  'outcome.deleted': '已删除',
  'outcome.skipped': '已跳过',
  'outcome.failed': '失败',
  'execute.dryRunNotice': '试运行：未删除任何内容',

  // XI. Reports and report diffs
  'report.exported': '报告已写入 {path}',
  'report.diff.title': '报告对比',
  'report.diff.net': '净变化：{delta}',
  'report.diff.noChange': '两次报告之间没有变化',
  'report.diff.grew': '增大',
  'report.diff.shrank': '减小',
  'report.diff.added': '新增',
  'report.diff.removed': '移除',
  'report.diff.unchanged': '无变化',

  // XII. Doctor
  'doctor.title': '环境检查',
  'doctor.pass': '通过',
  'doctor.warn': '警告',
  'doctor.fail': '失败',
  'doctor.hint': '提示：{hint}',

  // XIII. Errors
  'error.notFound': '路径不存在：{path}',
  'error.permission': '没有访问权限：{path}',
  'error.invalidConfig': '配置文件无效（{path}）：{detail}',
  'error.aborted': '已中断',
  'error.outsideRoot': '{path} 不在扫描根目录内',
  'error.unknownRule': '未知规则：{ruleId}',
  'error.generic': '出错了：{detail}',

  // XIV. Counting units
  'unit.files': '{count} 个文件',
  'unit.targets': '{count} 个目标',
  'unit.days': '{count} 天',
  'unit.bytes': '{value} 字节',

  // XV. List joining
  'list.separator': '、',
  'list.conjunction': ' 和 ',

  // XVI. Rule labels, one per BUILTIN_RULES entry
  'rule.node-modules': 'Node 依赖包',
  'rule.node-next-cache': 'Next.js 构建缓存',
  'rule.node-next-output': 'Next.js 构建产物',
  'rule.node-nuxt': 'Nuxt 构建产物',
  'rule.node-build-output': 'JS/TS 构建产物',
  'rule.node-vite-cache': 'Vite / Turbopack 缓存',
  'rule.node-parcel-cache': 'Parcel 缓存',
  'rule.node-swc-cache': 'SWC / esbuild 缓存',
  'rule.node-storybook': 'Storybook 构建产物',
  'rule.node-tests-cache': '测试覆盖率与缓存',
  'rule.python-venv': 'Python 虚拟环境',
  'rule.python-pycache': 'Python 字节码缓存',
  'rule.python-eggs': 'Python 打包产物',
  'rule.python-tox': 'Tox / Nox 测试环境',
  'rule.python-pytest-cache': 'Pytest / Mypy 缓存',
  'rule.python-ipynb-checkpoints': 'Jupyter 检查点',
  'rule.rust-target': 'Rust 构建目录（target）',
  'rule.rust-registry-cache': 'Cargo 注册表缓存',
  'rule.go-build-cache': 'Go 构建缓存',
  'rule.go-mod-cache': 'Go 模块缓存',
  'rule.java-gradle-project-cache': 'Gradle 项目缓存',
  'rule.java-gradle-build': 'Gradle 构建产物',
  'rule.java-gradle-global-cache': 'Gradle 全局缓存',
  'rule.java-maven-repo': 'Maven 本地仓库',
  'rule.java-target': 'JVM 构建产物',
  'rule.php-vendor': 'PHP 依赖包（vendor）',
  'rule.ruby-bundle': 'Ruby Bundle 依赖',
  'rule.dotnet-build': '.NET 构建产物',
  'rule.elixir-deps': 'Elixir 依赖包',
  'rule.elixir-build': 'Elixir 构建产物',
  'rule.swift-build': 'SwiftPM 构建目录',
  'rule.cpp-build': 'CMake / Meson 构建目录',
  'rule.generic-cache': '项目缓存目录',
  'rule.generic-logs': '项目日志文件',
  'rule.generic-tmp': '临时输出目录',
  'rule.global-npm-cache': 'npm 缓存',
  'rule.global-pnpm-store': 'pnpm 内容仓库',
  'rule.global-yarn-cache': 'Yarn 缓存',
  'rule.global-pip-cache': 'pip 下载缓存',
  'rule.global-uv-cache': 'uv 缓存',
  'rule.global-xcode-derived-data': 'Xcode DerivedData',
  'rule.global-xcode-archives': 'Xcode 归档',
  'rule.global-cocoapods': 'CocoaPods 缓存',
  'rule.global-homebrew-cache': 'Homebrew 下载缓存',
  'rule.global-docker-report': 'Docker 数据（仅报告）',
};

/**
 * The complete message tables, keyed by language.
 *
 * I. Why the annotation is explicit
 *
 * 1. `Record<Language, Messages>` is the compile-time half of the parity
 *    guarantee: if a key is added to `Messages` and to only one table, this
 *    declaration stops the build.
 */
export const MESSAGES: Readonly<Record<Language, Messages>> = {
  en: EN_MESSAGES,
  zh: ZH_MESSAGES,
};

/** Rule ids declared by the catalog, used to validate `rule.*` message keys. */
const CATALOG_RULE_IDS: ReadonlySet<string> = new Set(BUILTIN_RULES.map((entry) => entry.id));

/** Prefix that marks a message key as a rule label. */
const RULE_KEY_PREFIX = 'rule.';

/**
 * Read one message as a plain string.
 *
 * The key is intentionally a free-form `string`: rule ids are data, not literal
 * types, so `rule.<id>` can never be a static `MessageKey`. Membership is
 * checked with `Object.hasOwn` before the indexed read, which is what makes the
 * narrowing cast sound.
 *
 * @param table - One language's message table.
 * @param key - Candidate key, possibly absent.
 * @returns The message, or undefined when the key is not in this table.
 */
function lookupMessage(table: Messages, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key as MessageKey] : undefined;
}

/**
 * Collect key-parity defects against the first declared language.
 *
 * I. Both directions matter
 *
 * 1. A key present only in the reference is a hole in another table and would
 *    render as `undefined`.
 * 2. A key present only in the other table is dead weight that no call site can
 *    reach, and it hides the fact that the reference table forgot an entry.
 *
 * @returns One line per defect; empty when every table carries the same keys.
 */
function collectKeyParityProblems(): string[] {
  const referenceKeys = Object.keys(MESSAGES[LANGUAGES[0] ?? 'en']);
  const referenceSet = new Set(referenceKeys);
  const problems: string[] = [];

  for (const language of LANGUAGES) {
    const keys = Object.keys(MESSAGES[language]);
    const keySet = new Set(keys);
    problems.push(
      ...referenceKeys.filter((key) => !keySet.has(key)).map((key) => `${language}: missing key '${key}'`),
      ...keys.filter((key) => !referenceSet.has(key)).map((key) => `${language}: unknown key '${key}'`),
    );
  }

  return problems;
}

/**
 * Find messages whose value is empty or whitespace.
 *
 * An empty label renders as a blank column, which is indistinguishable from a
 * layout bug, so it is rejected outright.
 *
 * @returns One line per language listing its empty keys.
 */
function collectEmptyValueProblems(): string[] {
  const problems: string[] = [];

  for (const language of LANGUAGES) {
    const table = MESSAGES[language];
    const emptyKeys = Object.keys(table).filter((key) => lookupMessage(table, key)?.trim() === '');
    if (emptyKeys.length === 0) continue;
    problems.push(`${language}: empty messages ${emptyKeys.map((key) => `'${key}'`).join(', ')}`);
  }

  return problems;
}

/**
 * Find rule-label drift in both directions.
 *
 * Every `BUILTIN_RULES` id needs a `rule.<id>` entry, and every `rule.*` entry
 * must point at a live id, so a renamed or removed rule cannot leave a dead
 * translation behind (and a new rule cannot ship untranslated).
 *
 * @returns One line per defect; empty when the tables match the catalog.
 */
function collectRuleLabelProblems(): string[] {
  const problems: string[] = [];

  for (const language of LANGUAGES) {
    const table = MESSAGES[language];
    const messageIds = Object.keys(table)
      .filter((key) => key.startsWith(RULE_KEY_PREFIX))
      .map((key) => key.slice(RULE_KEY_PREFIX.length));

    problems.push(
      ...[...CATALOG_RULE_IDS]
        .filter((ruleId) => lookupMessage(table, `${RULE_KEY_PREFIX}${ruleId}`) === undefined)
        .map((ruleId) => `${language}: missing rule label '${RULE_KEY_PREFIX}${ruleId}'`),
      ...messageIds
        .filter((ruleId) => !CATALOG_RULE_IDS.has(ruleId))
        .map((ruleId) => `${language}: no such rule '${ruleId}'`),
    );
  }

  return problems;
}

/**
 * Collect every problem that would make the tables unsafe to render with.
 *
 * I. What is checked
 *
 * 1. Key parity between the two dictionaries.
 * 2. Non-empty values.
 * 3. Rule-label coverage of the built-in catalog.
 *
 * @returns One human-readable line per defect; empty when the tables are sound.
 */
function collectTableProblems(): string[] {
  return [...collectKeyParityProblems(), ...collectEmptyValueProblems(), ...collectRuleLabelProblems()];
}

/**
 * Fail fast when the message tables are inconsistent.
 *
 * I. Why this throws instead of warning
 *
 * 1. A key-set mismatch, an empty label or a drifted rule id are all authoring
 *    mistakes that no user can act on and no amount of runtime fallback can
 *    repair: the screen would silently show the wrong language.
 * 2. The check sits at module scope, so the failure is deterministic and points
 *    at the first bad build rather than at a user's screenshot.
 */
function assertMessageTables(): void {
  const problems = collectTableProblems();
  if (problems.length === 0) return;
  throw new Error(
    `i18n message tables are inconsistent (${problems.length} problem(s)):\n- ${problems.join('\n- ')}`,
  );
}

// Run once, at import time, for every entry point that can render text.
assertMessageTables();

/**
 * Fill `{name}` slots from a parameter bag.
 *
 * I. Contract
 *
 * 1. A slot whose name is absent from `params` is left exactly as written, so a
 *    caller bug surfaces as a literal `{bytes}` on screen instead of an empty
 *    gap or a thrown error mid-render.
 * 2. Numbers are stringified with the default `String()` conversion; anything
 *    needing grouping or unit scaling must be pre-formatted with
 *    `core/format.ts` and passed as a string.
 * 3. Substituted values are inserted literally: a `$&` inside a parameter is
 *    not reinterpreted, because the replacement goes through a function.
 *
 * @param template - Message text possibly containing `{name}` slots.
 * @param params - Values to substitute.
 * @returns The interpolated text.
 *
 * @example
 * ```ts
 * interpolate('free {bytes}', { bytes: '1.2 GB' })  // 'free 1.2 GB'
 * interpolate('free {bytes}', {})                   // 'free {bytes}'
 * ```
 */
function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (slot: string, name: string) => {
    const value = params[name];
    return value === undefined ? slot : String(value);
  });
}

/**
 * A language-bound message accessor.
 *
 * Every screen creates one translator from the resolved language and passes it
 * down, which is what keeps a single render tree in a single language: there is
 * no ambient lookup that could switch mid-screen.
 */
export interface Translator {
  /** Language this translator renders in. */
  readonly language: Language;
  /** Translate a key, interpolating `{name}` slots from `params`. */
  t(key: MessageKey, params?: MessageParams): string;
  /** Localised label for a lifecycle layer. */
  layer(layer: TargetLayer): string;
  /** Localised label for a risk level. */
  risk(risk: RiskLevel): string;
  /** Localised label for a target kind. */
  kind(kind: TargetKind): string;
  /** Localised explanation of a lock reason. */
  lockReason(reason: LockReason): string;
  /** Localised label for an execution outcome. */
  outcome(outcome: CleanOutcome): string;
  /** Localised label for a doctor check status. */
  doctorStatus(status: DoctorStatus): string;
  /** Rule label for a rule id, falling back to the catalog label. */
  rule(ruleId: string, fallback: string): string;
  /** Join items with the language's list punctuation. */
  list(items: readonly string[], conjunction?: string): string;
}

/**
 * Create a translator bound to one language.
 *
 * I. Rule labels
 *
 * 1. `rule()` accepts the catalog's own English label as `fallback` and only
 *    consults the translation when the id is known to `BUILTIN_RULES`. An
 *    unknown id — a user-authored rule from a future config format, say — is
 *    returned untouched rather than being mistaken for a translated entry.
 * 2. The module-init assertion keeps the catalog and the tables in step, so the
 *    fallback is a safety net for foreign ids, not a routine English leak into
 *    a Chinese screen.
 *
 * @param language - Language to render in.
 * @returns A translator for that language.
 *
 * @example
 * ```ts
 * const tr = createTranslator('zh')
 * tr.rule('node-modules', 'Node Dependencies')  // 'Node 依赖包'
 * tr.list(['a', 'b', 'c'])                      // 'a、b 和 c'
 * ```
 */
export function createTranslator(language: Language): Translator {
  const table: Messages = MESSAGES[language];
  const translate = (key: MessageKey, params?: MessageParams): string =>
    interpolate(lookupMessage(table, key) ?? key, params);

  return {
    language,
    t: translate,

    layer: (value) => translate(`layer.${value}`),
    risk: (value) => translate(`risk.${value}`),
    kind: (value) => translate(`kind.${value}`),
    lockReason: (value) => translate(`lock.${value}`),
    outcome: (value) => translate(`outcome.${value}`),
    doctorStatus: (value) => translate(`doctor.${value}`),

    rule: (ruleId, fallback) =>
      CATALOG_RULE_IDS.has(ruleId)
        ? (lookupMessage(table, `${RULE_KEY_PREFIX}${ruleId}`) ?? fallback)
        : fallback,

    list: (items, conjunction) => {
      const [first, ...rest] = items;
      if (first === undefined) return '';
      const last = rest.pop();
      // A single item needs no punctuation at all.
      if (last === undefined) return first;
      const separator = lookupMessage(table, 'list.separator') ?? ', ';
      const glue = conjunction ?? lookupMessage(table, 'list.conjunction') ?? ' and ';
      return `${[first, ...rest].join(separator)}${glue}${last}`;
    },
  };
}

/**
 * Language used by the module-level {@link t} shorthand.
 *
 * Seeded from `--lang`/`DEV_ENV_CLEANER_LANG` at import time and changed only by
 * `setLanguage`, which the CLI calls once while parsing global flags.
 */
let currentLanguage: Language = detectLanguage();

/**
 * Translate with the process-wide language.
 *
 * This is the shorthand for call sites that have no translator at hand (CLI help
 * text, error formatting). Interactive screens should hold a `Translator` from
 * `createTranslator` instead, so a language change cannot happen between two
 * lines of the same screen.
 *
 * @param key - Message key.
 * @param params - Values for `{name}` slots.
 * @returns The localised text; the key itself if the key is somehow absent.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const table: Messages = MESSAGES[currentLanguage];
  return interpolate(lookupMessage(table, key) ?? key, params);
}

/**
 * Switch the language used by the module-level {@link t} shorthand.
 *
 * The value is expected to be pre-validated; `detectLanguage` performs that
 * normalisation for raw flag and environment values.
 *
 * @param language - Language to use from now on.
 */
export function setLanguage(language: Language): void {
  currentLanguage = language;
}

export type { Language, MessageKey, MessageParams, Messages } from './types.js';
export { detectLanguage, isLanguage, LANGUAGES } from './types.js';
