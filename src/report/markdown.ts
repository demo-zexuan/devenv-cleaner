/**
 * Markdown Report Rendering
 *
 * Renders a {@link ScanReport}, a {@link ReportDiff} or a
 * {@link CleanExecution} as a GitHub-flavoured Markdown document that can be
 * pasted into a PR, attached to a CI job or committed next to a lockfile.
 *
 * I. Why Markdown and not a terminal table
 *
 * 1. The TUI already answers "what should I delete right now" for one machine
 *    at one moment. Markdown answers the other question: "what changed, and can
 *    I prove it?" A report is a durable artefact that gets diffed in review and
 *    archived next to a build.
 * 2. Every number is rendered through `src/core/format.ts`, the same module the
 *    CLI and the TUI use. The Markdown total and the JSON total are therefore
 *    byte-for-byte the same claim, which is what FR-59 asserts and what makes
 *    the two report formats cross-checkable.
 *
 * II. Rendering rules that exist because Markdown is fragile
 *
 * 1. **Nothing may break a table.** A path containing `|` — legal on no
 *    filesystem, but not on a hand-written fixture — would split a cell and
 *    shift every later column. Pipes are escaped and every path is wrapped in
 *    backticks, so the reader sees a path and the parser sees one cell.
 * 2. **No trailing whitespace, always a trailing newline.** The output is a
 *    file that will be committed; trailing spaces show up as spurious diffs in
 *    every editor and Git hook, and a missing final newline breaks POSIX text
 *    tooling and Markdown renderers that need the last block terminated.
 * 3. **A full target list is one `<details>` block, not four thousand rows.**
 *    The interesting part of the document is the first screen; the exhaustive
 *    list is kept, collapsed, because "it is not in the report" and "it is in
 *    the report but folded away" must not be confusable.
 *
 * @module report/markdown
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ellipsizePath,
  formatBytes,
  formatCount,
  formatDuration,
  formatPercent,
  formatSignedBytes,
  formatTimestamp,
} from '../core/format.js';
import { normalizeForCompare } from '../core/platform.js';
import type {
  CleanExecution,
  CleanTarget,
  ReportDiff,
  ReportDiffEntry,
  ScanReport,
  TargetLayer,
} from '../core/types.js';
import { LAYER_ORDER } from '../rules/engine.js';

/** How many targets the "largest" table shows before deferring to `<details>`. */
const TOP_TARGET_LIMIT = 20;

/**
 * Zero-width space, inserted after `/` inside a code span.
 *
 * A path is one unbreakable token to a Markdown renderer, and a 120-character
 * token in a table cell forces the whole document to scroll horizontally. The
 * character is invisible, contributes no width, and gives the renderer a legal
 * break opportunity that does not alter the path a reader copies out.
 */
const ZERO_WIDTH_SPACE = '\u200B';

/** Table header of the largest-targets table, in the required column order. */
const TARGET_HEADER = ['占用', '路径', '规则', '层级', '风险', '最后修改'] as const;

/** Table header of the diff entry table. */
const DIFF_HEADER = ['路径', '变更', '变更前', '变更后', '变化量', '规则'] as const;

/** Table header of the per-target cleanup results table. */
const RESULT_HEADER = ['路径', '结果', '释放', '耗时', '错误 / 跳过原因'] as const;

/**
 * Escape the two characters that can break a table cell.
 *
 * @param value - Raw cell text.
 * @returns Text that cannot terminate a cell or open a code span early.
 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/`/g, '\\`');
}

/** Render a path as a code span, escaped and given wrap opportunities. */
function codeSpan(value: string): string {
  return `\`${escapeCell(value).replace(/\//g, `/${ZERO_WIDTH_SPACE}`)}\``;
}

/** Render a short code-span token that is safe to leave unbroken. */
function inlineCode(value: string): string {
  return `\`${escapeCell(value)}\``;
}

/**
 * Render a pipe table with aligned columns.
 *
 * I. Why columns are padded
 *
 * 1. The output is committed and reviewed as a diff. Aligned pipes keep the
 *    source readable and keep a content edit from reflowing every line.
 * 2. Width is measured on the escaped text, so an escaped pipe counts as the
 *    two characters the source actually contains.
 * 3. Cells are never padded to a width beyond the source text they contain:
 *    Markdown renders all cells in a column at the same width, but a human
 *    reading the raw file wants the widest cell to wrap naturally rather than
 *    every line to be padded to some arbitrary cap.
 *
 * @param header - Column labels.
 * @param rows - Body rows, each with exactly `header.length` cells.
 * @returns The table as lines, without a trailing blank line.
 */
function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((cell, column) => {
    let width = cell.length;
    for (const row of rows) {
      const candidate = row[column] ?? '';
      if (candidate.length > width) width = candidate.length;
    }
    return width;
  });

  const padRow = (cells: readonly string[]): string =>
    `| ${widths.map((width, column) => (cells[column] ?? '').padEnd(width, ' ')).join(' | ')} |`;

  const separator = `| ${widths.map((width) => '-'.repeat(Math.max(3, width))).join(' | ')} |`;
  return [padRow(header), separator, ...rows.map((row) => padRow(row))];
}

/**
 * Format an ISO-8601 timestamp for a heading, keeping the original on failure.
 *
 * @param iso - ISO-8601 timestamp from a report.
 * @returns `2026-09-29 22:37` in local time, or a placeholder / raw fallback.
 */
function formatIso(iso: string): string {
  const millis = Date.parse(iso);
  if (!Number.isFinite(millis)) return iso === '' ? '—' : iso;
  return formatTimestamp(millis);
}

/**
 * Render the elapsed time between two ISO-8601 timestamps.
 *
 * @param fromIso - Older timestamp.
 * @param toIso - Newer timestamp.
 * @returns A duration string, or `—` when either timestamp is unusable.
 */
function formatElapsed(fromIso: string, toIso: string): string {
  const fromMillis = Date.parse(fromIso);
  const toMillis = Date.parse(toIso);
  if (!Number.isFinite(fromMillis) || !Number.isFinite(toMillis)) return '—';
  return formatDuration(Math.max(0, toMillis - fromMillis));
}

/** Append the standard trailing newline to an assembled document. */
function finishDocument(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** Order layers by the catalog's display order, appending any unknown layer. */
function orderLayers(layers: readonly TargetLayer[]): TargetLayer[] {
  const ordered = LAYER_ORDER.filter((layer) => layers.includes(layer));
  const extra = layers.filter((layer) => !ordered.includes(layer));
  return [...ordered, ...extra];
}

/**
 * Render a full scan report as a Markdown document.
 *
 * I. Document structure
 *
 * 1. A title carrying the scan timestamp, so two archived reports are
 *    distinguishable without opening either.
 * 2. A summary table with the headline numbers, including the root, platform
 *    and tool version that produced them.
 * 3. A per-layer breakdown in `LAYER_ORDER`, then a per-ecosystem breakdown.
 * 4. The 20 largest targets, then every remaining target inside a collapsed
 *    `<details>` block.
 * 5. The configuration that was in effect, because a byte count is not
 *    reproducible without it (FR-64).
 *
 * II. Empty input
 *
 * 1. A scan that found nothing still renders every section, with an explicit
 *    "no targets" row rather than a table with a header and no body — a Markdown
 *    table with zero rows is not guaranteed to render at all, so the reader
 *    would silently lose the section.
 *
 * @param report - The report to render.
 * @returns A GitHub-flavoured Markdown document ending in a newline.
 *
 * @example
 * ```ts
 * await writeReportMarkdown(reportToMarkdown(report), 'report.md')
 * ```
 */
export function reportToMarkdown(report: ScanReport): string {
  const summary = report.summary;
  const targets = report.targets;
  const lines: string[] = [];

  // I. Title.
  lines.push(`# DevEnvClean 扫描报告 — ${formatIso(report.scannedAt)}`, '');

  // II. Headline numbers.
  lines.push('## 概览', '');
  const lockedBytes = Math.max(0, summary.totalBytes - summary.reclaimableBytes);
  lines.push(
    ...renderTable(
      ['指标', '值'],
      [
        ['扫描时间', formatIso(report.scannedAt)],
        ['扫描根', codeSpan(report.root)],
        ['平台', inlineCode(report.platform)],
        ['工具版本', inlineCode(report.toolVersion)],
        ['报告 Schema', inlineCode(String(report.schemaVersion))],
        ['占用总量', formatBytes(summary.totalBytes)],
        [
          '可回收',
          `${formatBytes(summary.reclaimableBytes)}（${formatPercent(summary.reclaimableBytes, summary.totalBytes)}）`,
        ],
        ['已锁定', `${formatBytes(lockedBytes)}（${formatCount(summary.lockedCount)} 个目标）`],
        ['目标数', formatCount(summary.targetCount)],
        ['文件数', formatCount(summary.fileCount)],
        [
          '扫描耗时',
          `${formatDuration(report.durationMs)}（访问 ${formatCount(report.directoriesVisited)} 个目录）`,
        ],
        ['跳过目录', formatCount(report.skippedDirectories)],
        // A truncated scan stopped at the directory ceiling, so every byte
        // figure above is a floor rather than a total. Saying so in the table
        // prevents a reader from treating this report as a complete picture.
        ['扫描完整性', report.truncated ? '已截断（达到目录上限，总量为下限）' : '完整'],
        ['最大单目标', formatBytes(summary.largestTargetBytes)],
      ],
    ),
    '',
  );

  // III. Layer breakdown, always in catalog display order.
  lines.push('## 按生命周期分层', '');
  const layerRows = orderLayers(summary.byLayer.map((entry) => entry.layer)).map((layer) => {
    const entry = summary.byLayer.find((candidate) => candidate.layer === layer);
    if (!entry) return [inlineCode(layer), '0', formatBytes(0), formatBytes(0), '0%'];
    return [
      inlineCode(entry.layer),
      formatCount(entry.targetCount),
      formatBytes(entry.bytes),
      formatBytes(entry.reclaimableBytes),
      formatPercent(entry.reclaimableBytes, entry.bytes),
    ];
  });
  lines.push(
    ...renderTable(
      ['层级', '目标数', '占用', '可回收', '可回收占比'],
      layerRows.length > 0 ? layerRows : [['—', '0', formatBytes(0), formatBytes(0), '0%']],
    ),
    '',
  );

  // IV. Ecosystem breakdown.
  lines.push('## 按生态', '');
  const ecosystemRows = summary.byEcosystem.map((entry) => [
    inlineCode(entry.id),
    escapeCell(entry.name),
    formatCount(entry.projectCount),
    formatBytes(entry.bytes),
    formatBytes(entry.reclaimableBytes),
  ]);
  lines.push(
    ...renderTable(
      ['生态', '名称', '项目数', '占用', '可回收'],
      ecosystemRows.length > 0 ? ecosystemRows : [['—', '—', '0', formatBytes(0), formatBytes(0)]],
    ),
    '',
  );

  // V. Top-N largest targets. "Largest" is the ordering the contract promises
  //    on `targets`; the sort is repeated so a hand-built report still obeys it.
  lines.push(`## 最大的 ${Math.min(TOP_TARGET_LIMIT, targets.length)} 个目标`, '');
  const ranked = [...targets].sort((left, right) => {
    if (right.bytes !== left.bytes) return right.bytes - left.bytes;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
  const topRows = ranked.slice(0, TOP_TARGET_LIMIT).map(targetRow);
  lines.push(
    ...renderTable(TARGET_HEADER, topRows.length > 0 ? topRows : [['—', '—', '—', '—', '—', '—']]),
    '',
  );

  // VI. The exhaustive list, collapsed. Nothing is omitted: a report that
  //     silently truncates its own data cannot be used as an audit trail.
  lines.push(`## 全部目标（${formatCount(targets.length)}）`, '');
  lines.push('<details>', `<summary>展开全部 ${formatCount(targets.length)} 个目标</summary>`, '');
  const detailRows = ranked.map((target) => [
    formatBytes(target.bytes),
    codeSpan(target.path),
    ruleCell(target.label),
    inlineCode(target.layer),
    formatTimestamp(target.mtimeMs),
  ]);
  lines.push(
    ...renderTable(
      ['占用', '路径', '规则', '层级', '最后修改'],
      detailRows.length > 0 ? detailRows : [['—', '—', '—', '—', '—']],
    ),
    '',
  );
  lines.push('</details>', '');

  // VII. Effective configuration, the answer to "what produced these numbers".
  lines.push('## 本次生效配置', '');
  const config = report.config;
  const disabled = config.disabledRules.length > 0 ? config.disabledRules.join(', ') : '无';
  const lockedRules = config.lockedRules.length > 0 ? config.lockedRules.join(', ') : '无';
  lines.push(
    `- 配置来源：${config.sourcePath === null ? '内置默认值' : codeSpan(config.sourcePath)}`,
    `- 扫描深度：${inlineCode(String(config.maxDepth))} ｜ 最小体积：${formatBytes(config.minSizeBytes)} ｜ 并发：${inlineCode(String(config.limits.concurrency))}`,
    `- 高风险阈值：${formatBytes(config.limits.highRiskBytes)} ｜ 目录上限：${formatCount(config.limits.maxDirectories)} ｜ 轻量 node_modules 条目数：${formatCount(config.limits.lightNodeModulesEntries)}`,
    `- 已禁用规则：${disabled}`,
    `- 已锁定规则：${lockedRules}`,
    `- 白名单：${config.whitelist.length} 项`,
  );
  if (config.whitelist.length > 0) {
    // (1) Ten entries is enough to spot a mistake; the rest is a config dump.
    for (const entry of config.whitelist.slice(0, 10)) {
      lines.push(`  - ${codeSpan(entry)}`);
    }
    if (config.whitelist.length > 10) {
      lines.push(`  - …等 ${formatCount(config.whitelist.length - 10)} 项`);
    }
  }
  lines.push('');

  return finishDocument(lines);
}

/**
 * Build one row of the largest-targets table.
 *
 * @param target - Target to render.
 * @returns Cells in the order of {@link TARGET_HEADER}.
 */
function targetRow(target: CleanTarget): string[] {
  return [
    formatBytes(target.bytes),
    codeSpan(target.path),
    ruleCell(target.label),
    inlineCode(target.layer),
    inlineCode(target.risk),
    formatTimestamp(target.mtimeMs),
  ];
}

/**
 * Render a rule label as a table cell.
 *
 * I. Why this is not `inlineCode`
 *
 * 1. A rule label is authored prose (`Node Dependencies`), not an identifier,
 *    so it is shown verbatim rather than as a code span — which is what keeps
 *    the table readable. It still has to be escaped, because a user-supplied
 *    label through a config override may contain a pipe, and one unescaped pipe
 *    shifts every later column of the row.
 *
 * @param label - Rule label, possibly from a user config.
 * @returns A single, safe table cell.
 */
function ruleCell(label: string): string {
  return escapeCell(label);
}

/** Render one diff entry's change classification as a readable label. */
function changeLabel(change: ReportDiffEntry['change']): string {
  if (change === 'added') return '新增';
  if (change === 'removed') return '消失';
  if (change === 'grew') return '增长';
  if (change === 'shrank') return '缩小';
  return '不变';
}

/**
 * Format a diff entry's relative change, or a dash when it is undefined.
 *
 * @param entry - Diff entry.
 * @returns A percentage such as `+12.4%`, or `—` for added/removed paths.
 */
function changePercent(entry: ReportDiffEntry): string {
  if (entry.change === 'added' || entry.fromBytes === 0) return '—';
  const ratio = (entry.deltaBytes / Math.abs(entry.fromBytes)) * 100;
  return `${ratio > 0 ? '+' : ''}${ratio.toFixed(1)}%`;
}

/**
 * Render a report comparison as a growth report.
 *
 * I. Document structure
 *
 * 1. The title states both scan timestamps and the elapsed time between them,
 *    because "grew by 4 GB" is only meaningful next to "over three weeks".
 * 2. The headline is the net delta in signed bytes, followed by the count of
 *    comparable paths, and the absolute churn when it disagrees with the net —
 *    a net change of zero can still hide terabytes moving in both directions.
 * 3. The table lists every entry sorted by magnitude and labelled with its
 *    change type; a path that changed which rule owns it is called out, because
 *    that is a catalog change rather than a size change.
 *
 * II. What is not shown
 *
 * 1. Zero-delta paths. They are deliberately absent from {@link ReportDiff},
 *    which is documented at the source; the count of paths that were compared
 *    is stated instead so the reader knows the table is a filter, not the whole
 *    picture.
 *
 * @param diff - The diff to render.
 * @returns A GitHub-flavoured Markdown document ending in a newline.
 */
export function diffToMarkdown(diff: ReportDiff): string {
  const lines: string[] = [];

  // I. Title with both endpoints and the interval between them.
  lines.push(
    `# DevEnvClean 增长报告 — ${formatIso(diff.from.scannedAt)} → ${formatIso(diff.to.scannedAt)}`,
    '',
  );

  const entries = diff.entries;
  const compared = Math.max(diff.from.targets.length, diff.to.targets.length);
  let churn = 0;
  let added = 0;
  let removed = 0;
  let grew = 0;
  let shrank = 0;
  for (const entry of entries) {
    churn += Math.abs(entry.deltaBytes);
    if (entry.change === 'added') added += 1;
    else if (entry.change === 'removed') removed += 1;
    else if (entry.change === 'grew') grew += 1;
    else if (entry.change === 'shrank') shrank += 1;
  }

  // II. Headline.
  lines.push('## 概览', '');
  lines.push(
    `**净变化：${formatSignedBytes(diff.deltaBytes)}**`,
    '',
    `- 基准报告：${formatIso(diff.from.scannedAt)} ｜ 占用 ${formatBytes(diff.from.summary.totalBytes)}`,
    `- 对比报告：${formatIso(diff.to.scannedAt)} ｜ 占用 ${formatBytes(diff.to.summary.totalBytes)}`,
    `- 间隔：${formatElapsed(diff.from.scannedAt, diff.to.scannedAt)}`,
    `- 可比较路径：${formatCount(compared)} ｜ 有变化的路径：${formatCount(entries.length)}`,
    `- 变化分布：新增 ${formatCount(added)} ｜ 消失 ${formatCount(removed)} ｜ 增长 ${formatCount(grew)} ｜ 缩小 ${formatCount(shrank)}`,
    `- 绝对变动量：${formatSignedBytes(churn)}`,
    `- 扫描根：${codeSpan(diff.from.root)}`,
    '',
  );

  // III. Entries, largest movement first (the order `diffReports` guarantees).
  lines.push('## 变化明细', '');
  // The older report is indexed by canonical path so the table can show when a
  // path changed which rule owns it. `ReportDiffEntry` carries one `ruleId`
  // (resolved to the newer report), so the previous owner is only recoverable
  // from `diff.from` — and only that side can name a removed rule.
  const previousRule = new Map<string, string>();
  for (const target of diff.from.targets) {
    const key = normalizeForCompare(target.path);
    if (!previousRule.has(key)) previousRule.set(key, target.ruleId);
  }
  const rows = entries.map((entry) => [
    codeSpan(entry.path),
    changeLabel(entry.change),
    formatBytes(entry.fromBytes),
    formatBytes(entry.toBytes),
    `${formatSignedBytes(entry.deltaBytes)}（${changePercent(entry)}）`,
    inlineCode(ruleLabel(entry, previousRule.get(normalizeForCompare(entry.path)))),
  ]);
  lines.push(...renderTable(DIFF_HEADER, rows.length > 0 ? rows : [['—', '—', '—', '—', '—', '—']]), '');

  return finishDocument(lines);
}

/**
 * Name the rule that owns a diff entry, calling out an ownership change.
 *
 * I. Why a rule change is worth a notation
 *
 * 1. A path whose bytes barely moved can still change rule when the catalog
 *    changes — a directory reclassified from cache to artifacts. Printing only
 *    the new rule hides that the *meaning* of the entry changed, which is the
 *    one fact a single `ruleId` field cannot express.
 *
 * @param entry - Diff entry to label.
 * @param fromRuleId - Rule id in the older report for the same path, if any.
 * @returns A cell such as `node-modules`, or `dist → build` on a rule change.
 */
function ruleLabel(entry: ReportDiffEntry, fromRuleId: string | undefined): string {
  if (fromRuleId !== undefined && fromRuleId !== entry.ruleId) {
    return `${fromRuleId} → ${entry.ruleId}`;
  }
  return entry.ruleId;
}

/**
 * Render a cleanup execution as a record of what actually happened.
 *
 * I. Plan versus reality
 *
 * 1. The point of the comparison is that `CleanExecution.freedBytes` is measured
 *    during the run while the plan's total is a *claim* made before it. Printing
 *    both, with the difference, is what turns a cleanup log into evidence: a
 *    target that shrank between preview and execution is visible as a shortfall
 *    instead of silently vanishing.
 * 2. The planned total is recomputed per result by looking the target id up in
 *    the pre-clean report, falling back to the path. When the caller passes
 *    `null` — a scan-less clean, or a report from another root — the section is
 *    omitted entirely rather than filled with an invented denominator.
 *
 * II. Skip reasons
 *
 * 1. `CleanResult.skipReason` carries the executor's reason. It is aggregated
 *    here, because the user's next question after "12 skipped" is always "why",
 *    and twelve identical reasons are worth stating once.
 *
 * @param execution - The execution result.
 * @param report - The scan the plan was derived from, or null when unavailable.
 * @returns A GitHub-flavoured Markdown document ending in a newline.
 */
export function executionToMarkdown(execution: CleanExecution, report: ScanReport | null): string {
  const lines: string[] = [];

  // I. Title.
  lines.push(`# DevEnvClean 清理记录 — ${formatIso(execution.startedAt)}`, '');
  lines.push(
    `- 开始时间：${formatIso(execution.startedAt)}`,
    `- 总耗时：${formatDuration(execution.durationMs)}`,
    `- 处理目标：${formatCount(execution.results.length)} 个（删除 ${formatCount(execution.deletedCount)} ｜ 跳过 ${formatCount(execution.skippedCount)} ｜ 失败 ${formatCount(execution.failedCount)}）`,
    `- 实际释放：${formatBytes(execution.freedBytes)}`,
    '',
  );

  // II. Optional plan comparison. `report` is null meaning "no baseline was
  //     available"; that is not the same as "the plan claimed zero bytes".
  if (report !== null) {
    const byId = new Map<string, CleanTarget>();
    const byPath = new Map<string, CleanTarget>();
    for (const target of report.targets) {
      byId.set(target.id, target);
      byPath.set(target.path, target);
    }

    let plannedBytes = 0;
    let matched = 0;
    for (const result of execution.results) {
      const target = byId.get(result.targetId) ?? byPath.get(result.path);
      if (target === undefined) continue;
      matched += 1;
      plannedBytes += target.bytes;
    }

    lines.push('## 计划与实际', '');
    lines.push(
      ...renderTable(
        ['指标', '值'],
        [
          ['计划释放', formatBytes(plannedBytes)],
          ['实际释放', formatBytes(execution.freedBytes)],
          [
            '差异',
            `${formatSignedBytes(execution.freedBytes - plannedBytes)}（${formatPercent(
              execution.freedBytes,
              plannedBytes,
            )} 完成）`,
          ],
          ['基准报告', `${formatIso(report.scannedAt)} ｜ ${codeSpan(report.root)}`],
          [
            '可匹配目标',
            `${formatCount(matched)} / ${formatCount(execution.results.length)} 个结果在基准报告中找到对应目标`,
          ],
        ],
      ),
      '',
    );
  }

  // III. Per-target results. A cleanup result is a log line, not a canonical
  //     record — the full path is in the JSON execution output — so a very long
  //     path is shortened here to keep the table readable.
  lines.push('## 逐目标结果', '');
  const rows = execution.results.map((result) => [
    codeSpan(ellipsizePath(result.path, 80)),
    inlineCode(result.outcome),
    result.outcome === 'deleted' ? formatBytes(result.freedBytes) : '—',
    formatDuration(result.durationMs),
    // The reason cell is free text from the executor or the operating system
    // ("EACCES: permission denied"), and an errno message can legitimately
    // contain a pipe, so it is escaped like every other cell.
    escapeCell(result.error ?? result.skipReason ?? '—'),
  ]);
  lines.push(...renderTable(RESULT_HEADER, rows.length > 0 ? rows : [['—', '—', '—', '—', '—']]), '');

  // IV. Aggregated skip reasons, most frequent first.
  const reasons = new Map<string, number>();
  for (const result of execution.results) {
    if (result.skipReason === null) continue;
    reasons.set(result.skipReason, (reasons.get(result.skipReason) ?? 0) + 1);
  }
  if (execution.skippedCount > 0) {
    lines.push('## 跳过原因', '');
    if (reasons.size === 0) {
      // (1) Counts without reasons is a real state: the executor skipped the
      //     target before it had a reason to record.
      lines.push('- 未记录具体原因');
    } else {
      const sorted = [...reasons.entries()].sort((left, right) => {
        if (right[1] !== left[1]) return right[1] - left[1];
        return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
      });
      for (const [reason, count] of sorted) {
        // A reason is free text in a list item, so only the characters that can
        // terminate the item matter: a newline would split one reason across
        // what looks like two bullets.
        lines.push(`- ${formatCount(count)} 个目标：${reason.replace(/\r?\n/g, ' ')}`);
      }
    }
    lines.push('');
  }

  return finishDocument(lines);
}

/**
 * Write rendered Markdown to disk.
 *
 * I. Behaviour
 *
 * 1. Parent directories are created recursively, mirroring the JSON writer, so
 *    a caller can emit both formats into `.devenvclean/` without pre-creating
 *    the directory.
 * 2. Failures reject with the operation and path named, because a report that
 *    silently failed to write is worse than a failed command.
 *
 * @param content - Markdown document, typically from {@link reportToMarkdown},
 *   {@link diffToMarkdown} or {@link executionToMarkdown}.
 * @param outPath - Destination file path.
 * @returns A promise that resolves once the bytes are on disk.
 * @throws An `Error` wrapping the underlying filesystem failure.
 */
export async function writeReportMarkdown(content: string, outPath: string): Promise<void> {
  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, content, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to write Markdown report to ${outPath}: ${detail}`);
  }
}
