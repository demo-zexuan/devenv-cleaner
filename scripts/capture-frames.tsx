/**
 * Capture the TUI's real rendered frames into `docs/assets/`.
 *
 * I. Why this exists
 *
 * 1. The design document must show what the interface actually renders. A
 *    hand-drawn mockup drifts the moment a component changes; captured output
 *    cannot, because it is produced by the components themselves.
 * 2. It doubles as a visual regression check: run it after touching a component
 *    and read the diff in `docs/assets/`.
 *
 * Usage: `pnpm exec tsx scripts/capture-frames.tsx`
 *
 * @module scripts/capture-frames
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { writeFile } from 'node:fs/promises';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import type React from 'react';
import type { CleanResult, CleanTarget, ReportDiff, ScanReport, ScanSummary } from '../src/core/types.js';
import { diffReports } from '../src/report/diff.js';
import { ConfirmDialog } from '../src/tui/components/ConfirmDialog.js';
import { DiffView } from '../src/tui/components/DiffView.js';
import { ExecutionView } from '../src/tui/components/ExecutionView.js';
import { FilterBar } from '../src/tui/components/FilterBar.js';
import { Footer } from '../src/tui/components/Footer.js';
import { Header } from '../src/tui/components/Header.js';
import { ProgressView } from '../src/tui/components/ProgressView.js';
import { SummaryPanel } from '../src/tui/components/SummaryPanel.js';
import { TargetList } from '../src/tui/components/TargetList.js';
import { makeTheme } from '../src/tui/theme.js';

/** Terminal width every captured frame is laid out for. */
const WIDTH = 100;

const theme = makeTheme({ plain: false });

/**
 * The ANSI escape introducer, built from its code point.
 *
 * Written this way so no literal control character appears inside a regular
 * expression, which both reads as an invisible trap in a diff and trips the
 * `noControlCharactersInRegex` rule.
 */
const ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;]*m`, 'g');

/** Strip colour so the captured file is plain text that diffs cleanly. */
const strip = (value: string): string => value.replace(ANSI_PATTERN, '');

const rows = [
  ['/Users/dev/Content/OpenResearch/target', 'Rust Build Target', 'build', 13_327_400_000, 14],
  ['/Users/dev/Content/CyberStrike/node_modules', 'Node Dependencies', 'dependencies', 1_610_400_000, 15],
  [
    '/Users/dev/Content/2-VSCode-Project/ml-learning-nt/.venv',
    'Python Virtualenv',
    'dependencies',
    913_200_000,
    136,
  ],
  [
    '/Users/dev/Content/2-VSCode-Project/swarm-ide/backend/.next',
    'Next.js Build Output',
    'build',
    542_300_000,
    160,
  ],
  ['/Users/dev/Content/my-mc-v2/node_modules', 'Node Dependencies', 'dependencies', 500_800_000, 3],
  [
    '/Users/dev/Content/learning-quantitative-trading/.venv',
    'Python Virtualenv',
    'dependencies',
    492_200_000,
    15,
  ],
  ['/Users/dev/Content/OpenResearch/ui/node_modules', 'Node Dependencies', 'dependencies', 420_000_000, 14],
  ['/Users/dev/Content/netron/node_modules', 'Node Dependencies', 'dependencies', 403_300_000, 82],
  ['/Users/dev/Content/api-server/dist', 'JS/TS Build Output', 'build', 261_000_000, 41],
  ['/Users/dev/Content/dashboard/.cache', 'Project Cache Directory', 'cache', 128_000_000, 220],
] as const;

const targets: CleanTarget[] = rows.map(([path, label, layer, bytes, age], index) => ({
  id: `t${index}`,
  ruleId: 'r',
  label,
  path,
  projectPath: path.split('/').slice(0, 5).join('/'),
  projectName: path.split('/')[4] ?? 'project',
  layer,
  kind: 'build',
  scope: 'project',
  risk: bytes > 5e9 ? 'high' : bytes > 5e8 ? 'medium' : 'low',
  bytes,
  files: 4200 + index * 130,
  mtimeMs: Date.now() - age * 86_400_000,
  ageDays: age,
  locked: false,
  lockedReason: null,
  note: null,
}));

const summary: ScanSummary = {
  totalBytes: 22_074_800_000,
  reclaimableBytes: 22_057_700_000,
  targetCount: 679,
  lockedCount: 631,
  fileCount: 184_233,
  largestTargetBytes: 13_327_400_000,
  byLayer: [
    { layer: 'dependencies', targetCount: 42, bytes: 7_635_900_000, reclaimableBytes: 7_635_900_000 },
    { layer: 'build', targetCount: 585, bytes: 14_432_800_000, reclaimableBytes: 14_420_000_000 },
    { layer: 'cache', targetCount: 51, bytes: 6_200_000, reclaimableBytes: 6_200_000 },
    { layer: 'artifacts', targetCount: 1, bytes: 0, reclaimableBytes: 0 },
  ],
  byRule: [],
  byEcosystem: [],
};

const labels = {
  search: 'search',
  filter: 'filter',
  sort: 'sort',
  group: 'group',
  all: 'all',
  matched: 'matched',
  prompt: 'Permanently delete the selected targets?',
  yes: 'y Delete',
  no: 'esc Cancel',
  targets: 'targets',
  size: 'Size',
  danger: 'Risk',
  skipped: 'Skipped',
  running: 'Deleting',
  done: 'Done',
  dryRun: 'DRY RUN — nothing is deleted',
  deleted: 'Deleted',
  failed: 'Failed',
  freed: 'Freed',
  net: 'net change',
  grew: 'grew',
  shrank: 'shrank',
  added: 'added',
  removed: 'removed',
  noChange: 'unchanged',
  from: 'from',
  to: 'to',
};

const results: CleanResult[] = targets.slice(0, 9).map((target, index) => ({
  targetId: target.id,
  path: target.path,
  outcome: index === 7 ? 'failed' : 'deleted',
  freedBytes: index === 7 ? 0 : target.bytes,
  durationMs: 40 + index * 12,
  error: index === 7 ? 'EACCES: permission denied, rmdir' : null,
  skipReason: null,
}));

const makeReport = (scannedAt: string, multiplier: number): ScanReport => ({
  schemaVersion: 1,
  toolVersion: '0.1.0',
  scannedAt,
  root: '/Users/dev/Content',
  platform: 'darwin',
  durationMs: 9700,
  directoriesVisited: 32986,
  skippedDirectories: 0,
  truncated: false,
  config: {
    sourcePath: '/Users/dev/Content/dvc.config.json',
    minSizeBytes: 1_048_576,
    maxDepth: 6,
    disabledRules: [],
    whitelist: [],
    lockedRules: [],
    ecosystems: ['node', 'python', 'rust'],
    limits: {
      highRiskBytes: 5_368_709_120,
      lightNodeModulesEntries: 500,
      concurrency: 24,
      maxDirectories: 400_000,
    },
  },
  targets: targets.map((target) => ({ ...target, bytes: Math.round(target.bytes * multiplier) })),
  projects: [],
  summary: { ...summary, totalBytes: Math.round(summary.totalBytes * multiplier) },
});

const diff: ReportDiff = diffReports(
  makeReport('2026-09-01T10:00:00.000Z', 0.82),
  makeReport('2026-09-29T10:00:00.000Z', 1),
);

const screens: ReadonlyArray<readonly [string, React.ReactElement]> = [
  [
    '01-scan',
    <Box key="scan" flexDirection="column" width={WIDTH}>
      <Header
        title="DevEnvClean"
        subtitle="scanning development caches"
        root="/Users/dev/Content"
        version="0.1.0"
        theme={theme}
        width={WIDTH}
      />
      <ProgressView
        phase="measuring"
        phaseLabel="measuring"
        directoriesVisited={32986}
        targetsFound={679}
        bytesFound={22_000_000_000}
        currentPath="/Users/dev/Content/2-VSCode-Project/swarm-ide/backend/node_modules"
        height={12}
        width={WIDTH}
        theme={theme}
        labels={{ dirs: 'directories', targets: 'targets', scanning: 'scanning' }}
      />
      <Footer
        hints={[{ key: 'ctrl-c', label: 'cancel scan' }]}
        theme={theme}
        width={WIDTH}
        message="679 of 679 targets measured"
      />
    </Box>,
  ],
  [
    '02-results',
    <Box key="results" flexDirection="column" width={WIDTH}>
      <Header
        title="DevEnvClean"
        subtitle="22.1 GB across 679 targets"
        root="/Users/dev/Content"
        version="0.1.0"
        theme={theme}
        width={WIDTH}
      />
      <FilterBar
        query=""
        activeLayer="all"
        sortKey="size"
        groupBy="layer"
        matchedCount={679}
        totalCount={679}
        theme={theme}
        width={WIDTH}
        labels={labels}
        layerLabel={(layer) => String(layer)}
      />
      <TargetList
        targets={targets}
        selectedIds={new Set(['t0', 't1', 't4'])}
        focusedIndex={1}
        height={14}
        offset={0}
        showProject={false}
        theme={theme}
        width={WIDTH}
        emptyLabel="no targets"
        riskLabel={(risk) => ` ${String(risk).toUpperCase().slice(0, 4)} `}
        lockLabel={(reason) => String(reason)}
        header={{ size: 'SIZE', path: 'PATH', rule: 'RULE', risk: 'RISK', age: 'AGE' }}
      />
      <SummaryPanel
        summary={summary}
        selectedBytes={15_448_600_000}
        selectedCount={3}
        projects={169}
        theme={theme}
        width={WIDTH}
        layerLabel={(layer) => String(layer)}
        labels={{
          total: 'total',
          reclaimable: 'reclaimable',
          selected: 'selected',
          targets: 'targets',
          projects: 'projects',
          largest: 'largest',
        }}
      />
      <Footer
        hints={[
          { key: 'space', label: 'select' },
          { key: 'a', label: 'all' },
          { key: '/', label: 'search' },
          { key: 'f', label: 'filter' },
          { key: 's', label: 'sort' },
          { key: 'd', label: 'preview' },
          { key: 'q', label: 'quit' },
        ]}
        theme={theme}
        width={WIDTH}
        message="3 targets selected"
      />
    </Box>,
  ],
  [
    '03-confirm',
    <Box key="confirm" flexDirection="column" width={WIDTH}>
      <Header
        title="DevEnvClean"
        subtitle="confirm"
        root="/Users/dev/Content"
        version="0.1.0"
        theme={theme}
        width={WIDTH}
      />
      <ConfirmDialog
        title="Confirm deletion"
        targetCount={3}
        totalBytes={15_448_600_000}
        lockedSkippedCount={631}
        dangerCount={1}
        theme={theme}
        width={WIDTH}
        height={20}
        labels={labels}
        previewText={
          '  12.4 GB  build         Rust Build Target      …/OpenResearch/target\n   1.5 GB  dependencies  Node Dependencies        …/CyberStrike/node_modules\n 477.6 MB  dependencies  Node Dependencies        …/my-mc-v2/node_modules'
        }
      />
      <Footer
        hints={[
          { key: 'y', label: 'delete' },
          { key: 'esc', label: 'cancel' },
        ]}
        theme={theme}
        width={WIDTH}
        message="this cannot be undone"
        messageTone="warning"
      />
    </Box>,
  ],
  [
    '04-execute',
    <Box key="execute" flexDirection="column" width={WIDTH}>
      <Header
        title="DevEnvClean"
        subtitle="deleting"
        root="/Users/dev/Content"
        version="0.1.0"
        theme={theme}
        width={WIDTH}
      />
      <ExecutionView
        results={results}
        currentIndex={9}
        total={9}
        freedBytes={16_900_000_000}
        failedCount={1}
        dryRun={false}
        height={14}
        width={WIDTH}
        theme={theme}
        labels={labels}
        outcomeLabel={(outcome) => String(outcome)}
      />
      <Footer
        hints={[{ key: 'ctrl-c', label: 'abort' }]}
        theme={theme}
        width={WIDTH}
        message="1 target failed — the rest completed"
        messageTone="warning"
      />
    </Box>,
  ],
  [
    '05-diff',
    <Box key="diff" flexDirection="column" width={WIDTH}>
      <Header
        title="DevEnvClean"
        subtitle="report comparison"
        root="/Users/dev/Content"
        version="0.1.0"
        theme={theme}
        width={WIDTH}
      />
      <DiffView diff={diff} limit={10} width={WIDTH} height={14} theme={theme} labels={labels} />
      <Footer
        hints={[
          { key: 'q', label: 'quit' },
          { key: 'e', label: 'export' },
        ]}
        theme={theme}
        width={WIDTH}
        message="growth since the previous scan"
      />
    </Box>,
  ],
];

for (const [name, element] of screens) {
  const { lastFrame, unmount } = render(element);
  const frame = `${strip(lastFrame() ?? '').replace(/[ \t]+$/gm, '')}\n`;
  await writeFile(`docs/assets/tui-${name}.txt`, frame, 'utf8');
  unmount();
  console.log(`wrote docs/assets/tui-${name}.txt (${frame.split('\n').length - 1} rows)`);
}
