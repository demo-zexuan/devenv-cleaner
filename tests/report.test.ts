/**
 * Report Serialization, Diffing and Rendering
 *
 * Pins the report contract: that the same scan produces the same bytes, that a
 * diff classifies movement rather than guessing, and that a Markdown table
 * cannot be broken by the data it contains.
 *
 * I. Why byte determinism is a product requirement and not a test detail
 *
 * 1. A report is committed as a CI baseline and reviewed as a diff, so any
 *    incidental reordering turns a one-target change into a whole-file diff and
 *    destroys the review value of the artifact.
 * 2. The same applies to version handling: a report from a *newer* build is
 *    refused, because a diff computed from fields this build misreads is worse
 *    than no diff at all, while an *older* one is defaulted and accepted.
 *
 * @module tests/report
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CleanExecution, type CleanTarget, SCHEMA_VERSION } from '../src/core/types.js';
import { diffReports, formatDiffSummary, topGrowth } from '../src/report/diff.js';
import { parseReportJson, readReportJson, reportToJson, writeReportJson } from '../src/report/json.js';
import {
  diffToMarkdown,
  executionToMarkdown,
  reportToMarkdown,
  writeReportMarkdown,
} from '../src/report/markdown.js';
import {
  createFixtureRoot,
  makeReport,
  makeTarget,
  removeFixtureRoot,
  SAMPLE_ROOT,
  writeTextFile,
} from './helpers.js';

const OLDER = '2026-01-01T00:00:00.000Z';
const NEWER = '2026-02-01T00:00:00.000Z';

/** A target below the sample root with a distinct path and size. */
function targetAt(name: string, bytes: number, overrides: Partial<CleanTarget> = {}): CleanTarget {
  return makeTarget({
    id: `node-modules#${name}`,
    path: join(SAMPLE_ROOT, 'proj', name),
    bytes,
    ...overrides,
  });
}

describe('diffReports', () => {
  const grew = targetAt('grew', 100);
  const shrank = targetAt('shrank', 500);
  const removed = targetAt('removed', 200);
  const unchanged = targetAt('unchanged', 300);
  const added = targetAt('added', 400);

  const from = makeReport([grew, shrank, removed, unchanged], { scannedAt: OLDER });
  const to = makeReport([{ ...grew, bytes: 150 }, { ...shrank, bytes: 100 }, unchanged, added], {
    scannedAt: NEWER,
  });

  it('classifies added, removed, grew and shrank paths', () => {
    const diff = diffReports(from, to);
    const byPath = new Map(diff.entries.map((entry) => [entry.path, entry]));
    expect(byPath.get(grew.path)?.change).toBe('grew');
    expect(byPath.get(shrank.path)?.change).toBe('shrank');
    expect(byPath.get(added.path)?.change).toBe('added');
    expect(byPath.get(removed.path)?.change).toBe('removed');
    expect(byPath.get(grew.path)?.deltaBytes).toBe(50);
    expect(byPath.get(shrank.path)?.deltaBytes).toBe(-400);
    expect(byPath.get(added.path)?.fromBytes).toBe(0);
    expect(byPath.get(removed.path)?.toBytes).toBe(0);
  });

  it('drops a path that did not change instead of padding the table', () => {
    const diff = diffReports(from, to);
    expect(diff.entries.map((entry) => entry.path)).not.toContain(unchanged.path);
  });

  it('reports the net delta as the change in the two totals', () => {
    const diff = diffReports(from, to);
    expect(diff.deltaBytes).toBe(to.summary.totalBytes - from.summary.totalBytes);
    expect(diff.from).toBe(from);
    expect(diff.to).toBe(to);
  });

  it('orders entries by absolute movement, then by path', () => {
    const diff = diffReports(from, to);
    const magnitudes = diff.entries.map((entry) => Math.abs(entry.deltaBytes));
    expect(magnitudes).toEqual([...magnitudes].sort((left, right) => right - left));
  });

  it('throws when the newer report is passed first', () => {
    // Reversing the arguments inverts every sign while looking plausible, so it
    // is rejected rather than silently producing a wrong growth report.
    expect(() => diffReports(to, from)).toThrow(/older report first/);
  });

  it('accepts two reports with the same timestamp', () => {
    expect(() =>
      diffReports(makeReport([], { scannedAt: OLDER }), makeReport([], { scannedAt: OLDER })),
    ).not.toThrow();
  });

  it('throws when the two reports cover different roots', () => {
    const other = makeReport([], { scannedAt: NEWER, root: '/somewhere/else' });
    expect(() => diffReports(from, other)).toThrow(/different scan roots/);
  });

  it('summarizes the net change and the route breakdown', () => {
    const summary = formatDiffSummary(diffReports(from, to));
    expect(summary).toContain('net');
    expect(summary).toContain('1 added');
    expect(summary).toContain('1 removed');
    expect(summary).toContain('1 grew');
    expect(summary).toContain('1 shrank');
  });

  it('selects only growth, biggest first, capped by the requested limit', () => {
    const diff = diffReports(from, to);
    // 'added' grew by 400 and 'grew' by 50, so the largest growth is 'added'.
    expect(topGrowth(diff, 1).map((entry) => entry.path)).toEqual([added.path]);
    expect(topGrowth(diff, 10).map((entry) => entry.path)).toEqual([added.path, grew.path]);
    expect(topGrowth(diff, 0)).toEqual([]);
    expect(topGrowth(diff, Number.NaN)).toEqual([]);
  });
});

describe('reportToJson', () => {
  it('produces identical bytes for the same input', () => {
    const report = makeReport([targetAt('a', 10), targetAt('b', 20)]);
    expect(reportToJson(report)).toBe(reportToJson(report));
  });

  it('produces identical bytes whatever order the producer listed the arrays in', () => {
    // Sorting is part of the contract, not a property of the scanner, so a
    // hand-assembled report serializes canonically too.
    const first = makeReport([targetAt('a', 10), targetAt('b', 20)]);
    const second = makeReport([targetAt('b', 20), targetAt('a', 10)]);
    expect(reportToJson(first)).toBe(reportToJson(second));
  });

  it('emits indented JSON terminated by exactly one newline', () => {
    const document = reportToJson(makeReport([targetAt('a', 10)]));
    expect(document.endsWith('\n')).toBe(true);
    expect(document.endsWith('\n\n')).toBe(false);
    expect(document).toContain('\n  "schemaVersion"');
    expect(() => JSON.parse(document)).not.toThrow();
  });

  it('emits the contract field order rather than the input order', () => {
    const document = reportToJson(makeReport([targetAt('a', 10)]));
    const keys = Object.keys(JSON.parse(document) as Record<string, unknown>);
    expect(keys).toEqual([
      'schemaVersion',
      'toolVersion',
      'scannedAt',
      'root',
      'platform',
      'durationMs',
      'directoriesVisited',
      'skippedDirectories',
      'truncated',
      'config',
      'targets',
      'projects',
      'summary',
    ]);
  });

  it('sorts targets by bytes descending with a path tie-break', () => {
    const document = reportToJson(
      makeReport([targetAt('small', 10), targetAt('big', 999), targetAt('medium', 10)]),
    );
    const parsed = JSON.parse(document) as { targets: { path: string }[] };
    expect(parsed.targets.map((entry) => entry.path)).toEqual([
      join(SAMPLE_ROOT, 'proj', 'big'),
      join(SAMPLE_ROOT, 'proj', 'medium'),
      join(SAMPLE_ROOT, 'proj', 'small'),
    ]);
  });
});

describe('parseReportJson', () => {
  it('round-trips a report through its own document', () => {
    const report = makeReport([targetAt('a', 10)], { truncated: true });
    const parsed = parseReportJson(reportToJson(report));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // Comparing the re-serialized bytes proves the whole structure survived,
      // including every field a hand-written deep-equal would forget.
      expect(reportToJson(parsed.report)).toBe(reportToJson(report));
    }
  });

  it('preserves the truncated flag and the ecosystem list', () => {
    const report = makeReport([targetAt('a', 10)], {
      truncated: true,
      config: {
        sourcePath: null,
        minSizeBytes: 0,
        maxDepth: 6,
        disabledRules: [],
        whitelist: [],
        lockedRules: [],
        ecosystems: ['node', 'rust'],
        limits: {
          highRiskBytes: 1,
          lightNodeModulesEntries: 2,
          concurrency: 3,
          maxDirectories: 4,
        },
      },
    });
    const parsed = parseReportJson(reportToJson(report));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.report.truncated).toBe(true);
      expect(parsed.report.config.ecosystems).toEqual(['node', 'rust']);
      expect(parsed.report.config.limits).toEqual({
        highRiskBytes: 1,
        lightNodeModulesEntries: 2,
        concurrency: 3,
        maxDirectories: 4,
      });
    }
  });

  it('rejects a report whose schema version is newer than this build supports', () => {
    const document = JSON.parse(reportToJson(makeReport([]))) as Record<string, unknown>;
    document.schemaVersion = SCHEMA_VERSION + 1;
    const parsed = parseReportJson(JSON.stringify(document));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain('newer than the supported version');
      expect(parsed.error).toContain('upgrade');
    }
  });

  it('accepts an older schema version and defaults what it does not know', () => {
    const parsed = parseReportJson(JSON.stringify({ schemaVersion: 0 }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.report.targets).toEqual([]);
      expect(parsed.report.summary.totalBytes).toBe(0);
      expect(parsed.report.truncated).toBe(false);
    }
  });

  it('rejects a document with no usable schema version', () => {
    for (const [label, document] of [
      ['missing', '{}'],
      ['null', '{"schemaVersion": null}'],
      ['a string', '{"schemaVersion": "1"}'],
      ['fractional', '{"schemaVersion": 1.5}'],
      ['negative', '{"schemaVersion": -1}'],
    ] as const) {
      const parsed = parseReportJson(document);
      expect(parsed.ok, label).toBe(false);
    }
  });

  it('rejects malformed JSON and a non-object root without throwing', () => {
    for (const document of ['{ not json', '[1,2,3]', '"a string"', '42', 'null']) {
      expect(() => parseReportJson(document)).not.toThrow();
      expect(parseReportJson(document).ok).toBe(false);
    }
  });

  it('coerces a numeric string rather than refusing the whole document', () => {
    // Hand-edited reports and JSON exporters routinely quote integers.
    const parsed = parseReportJson(JSON.stringify({ schemaVersion: 1, durationMs: '12' }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.report.durationMs).toBe(12);
  });
});

describe('report file helpers', () => {
  let fixtureDir = '';

  beforeEach(async () => {
    fixtureDir = await createFixtureRoot('report');
  });

  afterEach(async () => {
    await removeFixtureRoot(fixtureDir);
  });

  it('writes and reads back the same canonical bytes, creating parent directories', async () => {
    const report = makeReport([targetAt('a', 10)]);
    const file = join(fixtureDir, 'nested', 'report.json');
    await writeReportJson(report, file);
    const read = await readReportJson(file);
    expect(read.ok).toBe(true);
    if (read.ok) expect(reportToJson(read.report)).toBe(reportToJson(report));
  });

  it('reports a missing report file as an error value instead of throwing', async () => {
    const read = await readReportJson(join(fixtureDir, 'missing.json'));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain('failed to read report');
  });

  it('writes rendered Markdown to a nested path, creating the directory', async () => {
    const file = join(fixtureDir, 'out', 'report.md');
    const markdown = reportToMarkdown(makeReport([]));
    await writeReportMarkdown(markdown, file);
    expect(await readFile(file, 'utf8')).toBe(markdown);
  });
});

/** Count the pipes in one line that are not escaped by a backslash. */
function countUnescapedPipes(line: string): number {
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '|') continue;
    if (index > 0 && line[index - 1] === '\\') continue;
    count += 1;
  }
  return count;
}

/** Assert every contiguous Markdown table block has a consistent column count. */
function expectTableBlocksConsistent(markdown: string): void {
  let expected: number | null = null;
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) {
      expected = null;
      continue;
    }
    const pipes = countUnescapedPipes(line);
    if (expected === null) expected = pipes;
    else expect(pipes, `inconsistent table row: ${line}`).toBe(expected);
  }
}

describe('reportToMarkdown', () => {
  it('escapes a pipe inside a path so the table cannot be broken', () => {
    // A pipe is legal on no filesystem, but reports are also hand-built and
    // hand-edited; one unescaped pipe shifts every later column of the row.
    const report = makeReport([
      makeTarget({ id: 'piped', path: '/root/a|b/node_modules', bytes: 4096 }),
      makeTarget({ id: 'piped-label', path: '/root/plain', label: 'Rule | Label', bytes: 2048 }),
    ]);
    const markdown = reportToMarkdown(report);

    expect(markdown).toContain('a\\|b');
    expect(markdown).toContain('Rule \\| Label');
    expectTableBlocksConsistent(markdown);
  });

  it('renders the headline numbers and terminates the document cleanly', () => {
    const report = makeReport([targetAt('a', 1_048_576)], { truncated: true });
    const markdown = reportToMarkdown(report);
    expect(markdown.endsWith('\n')).toBe(true);
    expect(markdown).toContain('# DevEnvClean 扫描报告');
    expect(markdown).toContain('1 MB');
    // A truncated walk must say so, because every byte figure is then a floor.
    expect(markdown).toContain('已截断');
    // No line may carry trailing whitespace: the file is committed and diffed.
    for (const line of markdown.split('\n')) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it('still renders every section for a report with no targets', () => {
    const markdown = reportToMarkdown(makeReport([]));
    expect(markdown).toContain('## 概览');
    expect(markdown).toContain('## 最大的 0 个目标');
    expect(markdown).toContain('全部目标（0）');
    expect(markdown).not.toContain('NaN');
    expectTableBlocksConsistent(markdown);
  });
});

describe('diffToMarkdown', () => {
  it('renders the net change and one row per moved path', () => {
    const from = makeReport([targetAt('a', 100), makeTarget({ id: 'piped', path: '/root/a|b', bytes: 50 })], {
      scannedAt: OLDER,
    });
    const to = makeReport([targetAt('a', 400)], { scannedAt: NEWER });
    const markdown = diffToMarkdown(diffReports(from, to));

    expect(markdown).toContain('**净变化：+250 B**');
    expect(markdown).toContain('变化明细');
    expect(markdown).toContain('a\\|b');
    expectTableBlocksConsistent(markdown);
  });

  it('renders an explicit empty row rather than a header-only table', () => {
    const report = makeReport([targetAt('a', 100)], { scannedAt: OLDER });
    const markdown = diffToMarkdown(
      diffReports(report, makeReport([targetAt('a', 100)], { scannedAt: NEWER })),
    );
    expect(markdown).toContain('| —');
  });
});

describe('executionToMarkdown', () => {
  const execution: CleanExecution = {
    results: [
      {
        targetId: 'node-modules#a',
        path: join(SAMPLE_ROOT, 'proj', 'node_modules'),
        outcome: 'deleted',
        freedBytes: 2048,
        durationMs: 12,
        error: null,
        skipReason: null,
      },
      {
        targetId: 'node-modules#b',
        path: join(SAMPLE_ROOT, 'proj', 'dist'),
        outcome: 'skipped',
        freedBytes: 0,
        durationMs: 1,
        error: null,
        skipReason: 'dry-run',
      },
    ],
    freedBytes: 2048,
    deletedCount: 1,
    skippedCount: 1,
    failedCount: 0,
    durationMs: 13,
    startedAt: OLDER,
  };

  it('compares the plan against what was actually freed', () => {
    const report = makeReport([targetAt('node_modules', 2048), targetAt('dist', 1024)]);
    const markdown = executionToMarkdown(execution, report);
    expect(markdown).toContain('## 计划与实际');
    expect(markdown).toContain('计划释放');
    expect(markdown).toContain('2 KB');
    expectTableBlocksConsistent(markdown);
  });

  it('aggregates skip reasons and omits the plan section without a baseline report', () => {
    const markdown = executionToMarkdown(execution, null);
    expect(markdown).not.toContain('计划与实际');
    expect(markdown).toContain('## 跳过原因');
    expect(markdown).toContain('1 个目标：dry-run');
  });

  it('escapes a pipe inside an errno message', () => {
    const failed: CleanExecution = {
      ...execution,
      failedCount: 1,
      skippedCount: 0,
      results: [
        {
          targetId: 'x',
          path: '/root/plain',
          outcome: 'failed',
          freedBytes: 0,
          durationMs: 1,
          error: 'EACCES: a | b',
          skipReason: null,
        },
      ],
    };
    const markdown = executionToMarkdown(failed, null);
    expect(markdown).toContain('a \\| b');
    expectTableBlocksConsistent(markdown);
  });
});

describe('reading a report file that contains a pipe in a path', () => {
  it('accepts the document end to end, newline included', async () => {
    // Guards the interaction between the writer's trailing newline and a path
    // that needs escaping in another renderer: content decides acceptance.
    const fixtureDir = await createFixtureRoot('report-raw');
    try {
      const file = join(fixtureDir, 'report.json');
      await writeTextFile(file, reportToJson(makeReport([makeTarget({ path: '/root/a|b', bytes: 1 })])));
      const read = await readReportJson(file);
      expect(read.ok).toBe(true);
    } finally {
      await removeFixtureRoot(fixtureDir);
    }
  });
});
