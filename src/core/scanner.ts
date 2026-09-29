/**
 * Scan Orchestrator
 *
 * Turns a set of scan roots and a resolved configuration into a complete,
 * serializable `ScanReport`.
 *
 * I. Pipeline
 *
 * 1. **Discover** — walk each root once, matching every rule and collecting
 *    project markers (`rules/engine.ts`).
 * 2. **Dedupe** — drop nested matches so no directory is counted twice.
 * 3. **Measure** — size every surviving target, with bounded concurrency.
 * 4. **Decide** — apply the size, age and entry-count guards that turn a match
 *    into an actionable or locked target.
 * 5. **Aggregate** — attribute targets to projects and compute every summary the
 *    TUI and the reporters read.
 *
 * II. Why the guards are applied after measurement
 *
 * 1. A size floor, a staleness threshold and the entry-count heuristic all need
 *    facts that only exist once the directory has been walked. Applying them
 *    before measurement would mean either walking twice or guessing.
 * 2. Locked targets stay in the report. Visibility is the product: a user seeing
 *    "1.2 GB locked because it changed 2 days ago" learns something, whereas an
 *    absent row teaches nothing.
 *
 * III. Cancellation
 *
 * 1. A single `AbortSignal` threads through discovery and measurement. An abort
 *    returns a report describing whatever was found so far rather than throwing,
 *    so pressing Ctrl-C during a long scan still produces a usable summary.
 *
 * @module core/scanner
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_RULES } from '../rules/builtin.js';
import {
  type CompiledRule,
  compileRules,
  dedupeNestedMatches,
  escalateRisk,
  isWhitelisted,
  LAYER_ORDER,
  matchTargets,
  type RawMatch,
} from '../rules/engine.js';
import { ecosystemName } from './detector.js';
import { formatBytes } from './format.js';
import { targetId } from './ids.js';
import { isDirectory, measureDirectory } from './measure.js';
import { getHome, getPlatform, normalizeForCompare } from './platform.js';
import type {
  CleanTarget,
  DetectedProject,
  EcosystemSummary,
  LayerSummary,
  LockReason,
  ResolvedConfig,
  RuleSummary,
  ScanOptions,
  ScanProgress,
  ScanReport,
  ScanSummary,
  TargetLayer,
} from './types.js';
import { SCHEMA_VERSION } from './types.js';

/** Layer ids in the order every consumer renders them. */
const LAYERS: readonly TargetLayer[] = ['dependencies', 'build', 'cache', 'artifacts'];

/**
 * Read the package version once and cache it.
 *
 * The version is stamped into every report so a diff can refuse to compare
 * reports produced by incompatible tool builds.
 */
let cachedVersion: string | null = null;

/**
 * Resolve the running tool's version.
 *
 * I. Resolution order
 *
 * 1. The version baked into the bundle at build time, when present.
 * 2. The nearest `package.json` above this module, which covers running from
 *    source during development.
 * 3. `0.0.0-dev` as a last resort, so a missing manifest degrades the report's
 *    provenance rather than crashing the scan.
 *
 * @returns The semantic version string.
 */
export async function getToolVersion(): Promise<string> {
  if (cachedVersion !== null) return cachedVersion;

  // I. Build-time injection, set by the bundler when it is available.
  const injected = process.env.DEVCLEANER_VERSION;
  if (injected) {
    cachedVersion = injected;
    return cachedVersion;
  }

  // II. Nearest manifest above the module.
  try {
    let directory = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 4; depth += 1) {
      const candidate = join(directory, 'package.json');
      try {
        const contents = await readFile(candidate, 'utf8');
        const parsed = JSON.parse(contents) as { version?: string };
        if (typeof parsed.version === 'string' && parsed.version.length > 0) {
          cachedVersion = parsed.version;
          return cachedVersion;
        }
      } catch {
        // Not here; keep walking up.
      }
      directory = dirname(directory);
    }
  } catch {
    // Fall through to the development placeholder.
  }

  cachedVersion = '0.0.0-dev';
  return cachedVersion;
}

/**
 * Run a mapper over a list with bounded concurrency.
 *
 * I. Why a hand-rolled pool
 *
 * 1. The measurement phase is I/O bound and its concurrency bound already lives
 *    in the resolved config, so a dependency for twenty lines is not justified.
 * 2. Results are written by index, so the output order matches the input order
 *    regardless of completion order — which keeps report ids stable.
 *
 * @param items - Items to process.
 * @param limit - Maximum simultaneous operations; at least 1.
 * @param mapper - Async mapper invoked once per item.
 * @returns Results in input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const bound = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: bound }, () => worker()));
  return results;
}

/**
 * Resolve which detected project owns a target.
 *
 * I. Rule
 *
 * 1. The deepest project path that is an ancestor of the target wins, which is
 *    what attributes `apps/web/node_modules` to `apps/web` rather than to a
 *    monorepo root that also holds a marker file.
 * 2. A target with no ancestor project is either machine-global or sits in a
 *    directory with no marker; both are reported with a null project, and the
 *    TUI shows them under a synthetic "(loose)" group.
 *
 * @param targetPath - Absolute target path.
 * @param projectsByDepth - Detected projects sorted by path length descending.
 * @returns The owning project, or null.
 */
function owningProject(
  targetPath: string,
  projectsByDepth: readonly DetectedProject[],
): DetectedProject | null {
  const candidate = normalizeForCompare(targetPath);
  for (const project of projectsByDepth) {
    const projectPath = normalizeForCompare(project.path);
    if (candidate === projectPath) continue;
    if (candidate.startsWith(`${projectPath}/`)) return project;
  }
  return null;
}

/**
 * Decide whether a matched directory may be deleted under the active config.
 *
 * I. Guard order
 *
 * 1. Cheap, absolute guards first (outside-root, denylist, whitelist) — these
 *    were already resolved during matching.
 * 2. The entry-count guard, which exists to reject stub directories that share
 *    a name with a real dependency tree.
 * 3. The size floor, which keeps the report focused on directories worth acting
 *    on.
 * 4. The staleness guard, applied last because it is the one users most often
 *    want to override per rule.
 *
 * @param match - The raw match.
 * @param bytes - Measured size.
 * @param entries - Measured immediate entry count.
 * @param ageDays - Age in days of the freshest file in the tree.
 * @param config - Resolved config.
 * @returns A lock reason, or null when the target is actionable.
 */
function evaluateLocks(
  match: RawMatch,
  bytes: number,
  entries: number,
  ageDays: number,
  config: ResolvedConfig,
): LockReason | null {
  // I. Guards decided during matching.
  if (match.lockedReason !== null) return match.lockedReason;

  // II. The rule asked to be reported but never acted on.
  if (match.rule.reportOnly) return 'risk-exceeds-policy';

  // III. A stub directory is not a dependency tree.
  if (match.rule.minEntries !== null && entries < match.rule.minEntries) return 'too-small';

  // IV. The global size floor.
  const perRuleFloor = config.rules[match.rule.id]?.minSizeBytes ?? 0;
  if (bytes < Math.max(config.minSizeBytes, perRuleFloor)) return 'too-small';

  // V. Staleness: a directory touched yesterday is probably in active use.
  const effectiveAge = config.rules[match.rule.id]?.olderThanDays ?? match.rule.olderThanDays;
  if (effectiveAge !== null && effectiveAge !== undefined && ageDays < effectiveAge) return 'too-recent';

  return null;
}

/**
 * Scan the filesystem and build a report.
 *
 * I. Caller contract: roots must already be canonical
 *
 * 1. Every path this function records is derived from the roots it is given by
 *    plain path joining, so those strings are what later end up in
 *    `CleanTarget.path`.
 * 2. The plan and the executor re-validate containment against
 *    `realpath`-resolved roots. If this function were given a raw,
 *    symlink-aliased root while they used the canonical form, a target could be
 *    discovered and then refused at deletion time as `outside-root` — the
 *    scan-does-nothing failure mode that is hardest to explain to a user.
 *    Callers therefore canonicalize through `canonicalizeRoots` first.
 * 3. This is why the function does *not* resolve every visited directory: one
 *    `realpath` per root is cheap, one per directory in a `node_modules`
 *    containing ninety thousand entries is not.
 *
 * @param options - Scan options.
 * @returns The complete report; partial when the signal aborts mid-scan.
 *
 * @example
 * ```ts
 * const roots = await canonicalizeRoots(config.roots)
 * const report = await scan({ roots, config })
 * console.log(formatBytes(report.summary.reclaimableBytes))
 * ```
 */
export async function scan(options: ScanOptions): Promise<ScanReport> {
  const { roots, config, onProgress, signal } = options;
  const startedAt = Date.now();
  const scannedAt = new Date(startedAt).toISOString();
  const toolVersion = await getToolVersion();
  const platform = getPlatform();

  const compiledRules: CompiledRule[] = compileRules(BUILTIN_RULES, config.rules);
  let directoriesVisited = 0;
  let skippedDirectories = 0;
  let targetsFound = 0;
  let bytesFound = 0;

  /** Emit a progress sample; cheap enough to call directly from the walker. */
  const report = (phase: ScanProgress['phase'], currentPath: string): void => {
    onProgress?.({ phase, directoriesVisited, targetsFound, bytesFound, currentPath });
  };

  // ===========================================================================
  // I. Discovery
  // ===========================================================================

  /** Root directories that exist, de-duplicated and normalized. */
  const usableRoots: string[] = [];
  const seenRoots = new Set<string>();
  for (const root of roots) {
    const normalized = normalizeForCompare(root, platform);
    if (seenRoots.has(normalized)) continue;
    seenRoots.add(normalized);
    if (await isDirectory(root)) usableRoots.push(root);
    else skippedDirectories += 1;
  }

  const rawMatches: RawMatch[] = [];
  const discoveredProjects: DetectedProject[] = [];

  for (const root of usableRoots) {
    if (signal?.aborted) break;
    report('discovering', root);
    const result = await matchTargets({
      root,
      rules: compiledRules,
      config,
      roots: usableRoots,
      signal,
      onVisit: (count) => {
        directoriesVisited = count;
        report('discovering', root);
      },
    });
    directoriesVisited += result.visited;
    rawMatches.push(...result.matches);
    discoveredProjects.push(...result.projects);
  }

  // ===========================================================================
  // II. Machine-global targets
  //
  // Global caches are matched against their conventional locations rather than
  // by walking `~`, which would cost minutes and find nothing extra.
  //
  // This pass only runs when the user actually asked about the machine: either
  // an explicit opt-in, or a scan root that *is* the home directory. Otherwise a
  // project-scoped scan would report the whole machine's Docker and Xcode
  // footprint, which would make every project-level total meaningless.
  // ===========================================================================

  const includeGlobal =
    options.includeGlobalTargets ??
    usableRoots.some(
      (root) => normalizeForCompare(root, platform) === normalizeForCompare(getHome(), platform),
    );

  if (includeGlobal) {
    for (const compiled of compiledRules) {
      const { rule } = compiled;
      if (rule.scope !== 'global') continue;
      if (signal?.aborted) break;

      // I. Probe the conventional locations once per rule and accept a candidate
      //    when *any* of the rule's patterns matches it. Testing every matcher
      //    matters because a global rule often lists a bare location and a nested
      //    one, and the trailing segment differs between them.
      for (const candidate of globalCandidatesFor(rule.id)) {
        if (signal?.aborted) break;
        if (!(await isDirectory(candidate))) continue;
        const normalizedCandidate = normalizeForCompare(candidate, platform);
        if (!compiled.matchers.some((matcher) => matcher.regex.test(normalizedCandidate))) continue;

        let lockedReason: LockReason | null = null;
        if (isWhitelisted(candidate, config.whitelist)) lockedReason = 'whitelisted';

        rawMatches.push({
          rule,
          path: candidate,
          project: null,
          ecosystems: [],
          withinProjectRoot: false,
          lockedReason,
        });
      }
    }
  }

  // ===========================================================================
  // III. Deduplicate nested matches
  // ===========================================================================

  const deduped = dedupeNestedMatches(rawMatches);

  // ===========================================================================
  // IV. Measurement
  // ===========================================================================

  const measured = await mapWithConcurrency(deduped, config.limits.concurrency, async (match, index) => {
    if (signal?.aborted) return null;

    const measurement = await measureDirectory(match.path, {
      concurrency: config.limits.concurrency,
      maxDirectories: config.limits.maxDirectories,
      signal,
      tolerateMissing: true,
    });

    // I. The entry-count guard only applies to rules that declare it, and the
    //    root entry count is already known from the measurement, so no second
    //    directory read is needed to support the `node_modules` heuristic.
    const entries = measurement.rootEntries;

    const newest = measurement.newestMtimeMs > 0 ? measurement.newestMtimeMs : Date.now();
    const ageDays = Math.max(0, (Date.now() - newest) / 86_400_000);

    targetsFound += 1;
    bytesFound += measurement.bytes;
    if (index % 25 === 0 || targetsFound % 25 === 0) report('measuring', match.path);

    const locked = evaluateLocks(match, measurement.bytes, entries, ageDays, config);

    return { match, measurement, entries, ageDays, locked } satisfies MeasuredMatch;
  });

  const survivors = measured.filter((entry): entry is MeasuredMatch => entry !== null);
  // A truncated measurement means at least one target's size is a lower bound,
  // which is a report-level caveat rather than a per-target one.
  const truncatedWalk = survivors.some((entry) => entry.measurement.truncated);

  // ===========================================================================
  // V. Project attribution and aggregation
  // ===========================================================================

  const projectsByDepth = [...discoveredProjects].sort((left, right) => right.path.length - left.path.length);

  const targets: CleanTarget[] = survivors.map((entry) => {
    const project =
      entry.match.rule.scope === 'global' ? null : owningProject(entry.match.path, projectsByDepth);
    const risk = escalateRisk(entry.match.rule.risk, entry.measurement.bytes, config.limits.highRiskBytes);
    return {
      id: targetId(entry.match.rule.id, entry.match.path),
      ruleId: entry.match.rule.id,
      label: entry.match.rule.label,
      path: entry.match.path,
      projectPath: project?.path ?? null,
      projectName: project?.name ?? null,
      layer: entry.match.rule.layer,
      kind: entry.match.rule.kind,
      scope: entry.match.rule.scope,
      risk,
      bytes: entry.measurement.bytes,
      files: entry.measurement.files,
      mtimeMs: entry.measurement.newestMtimeMs,
      ageDays: Math.round(entry.ageDays * 10) / 10,
      locked: entry.locked !== null,
      lockedReason: entry.locked,
      note: entry.match.rule.note,
    } satisfies CleanTarget;
  });

  // I. A stable, useful order: biggest first, then path, then rule id.
  targets.sort((left, right) => {
    if (right.bytes !== left.bytes) return right.bytes - left.bytes;
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    return left.ruleId < right.ruleId ? -1 : 1;
  });

  // II. Roll target facts back up onto the projects they belong to.
  const projectsWithTotals: DetectedProject[] = projectsByDepth
    .map((project) => {
      const owned = targets.filter((target) => target.projectPath === project.path);
      return {
        ...project,
        targetLabels: [...new Set(owned.map((target) => target.label))].sort(),
        bytes: owned.reduce((sum, target) => sum + target.bytes, 0),
      } satisfies DetectedProject;
    })
    // (1) A marker with no measurable target is noise; drop it so the project
    //     list only shows projects that actually cost disk space.
    .filter((project) => project.targetLabels.length > 0)
    .sort((left, right) =>
      right.bytes !== left.bytes ? right.bytes - left.bytes : left.path < right.path ? -1 : 1,
    );

  report('finalizing', usableRoots[0] ?? '');

  const summary = buildSummary(targets, projectsWithTotals);

  return {
    schemaVersion: SCHEMA_VERSION,
    toolVersion,
    scannedAt,
    root: usableRoots[0] ?? roots[0] ?? getHome(),
    platform,
    durationMs: Date.now() - startedAt,
    directoriesVisited,
    skippedDirectories,
    truncated: truncatedWalk,
    config: toSnapshot(config, compiledRules),
    targets,
    projects: projectsWithTotals,
    summary,
  };
}

/** A measured match carried between pipeline stages. */
interface MeasuredMatch {
  readonly match: RawMatch;
  readonly measurement: Awaited<ReturnType<typeof measureDirectory>>;
  readonly entries: number;
  readonly ageDays: number;
  readonly locked: LockReason | null;
}

/**
 * Compute every aggregate a consumer reads.
 *
 * @param targets - All targets, already sorted by size.
 * @param projects - All projects, already filtered and sorted.
 * @returns The summary block.
 */
function buildSummary(targets: readonly CleanTarget[], projects: readonly DetectedProject[]): ScanSummary {
  const totalBytes = targets.reduce((sum, target) => sum + target.bytes, 0);
  const reclaimableBytes = targets
    .filter((target) => !target.locked)
    .reduce((sum, target) => sum + target.bytes, 0);
  const fileCount = targets.reduce((sum, target) => sum + target.files, 0);

  // I. Layer breakdown, emitted in a fixed order so tables never reshuffle.
  const byLayer: LayerSummary[] = LAYERS.map((layer) => {
    const inLayer = targets.filter((target) => target.layer === layer);
    return {
      layer,
      targetCount: inLayer.length,
      bytes: inLayer.reduce((sum, target) => sum + target.bytes, 0),
      reclaimableBytes: inLayer
        .filter((target) => !target.locked)
        .reduce((sum, target) => sum + target.bytes, 0),
    } satisfies LayerSummary;
  });

  // II. Rule breakdown, largest first.
  const ruleBuckets = new Map<string, CleanTarget[]>();
  for (const target of targets) {
    const bucket = ruleBuckets.get(target.ruleId);
    if (bucket) bucket.push(target);
    else ruleBuckets.set(target.ruleId, [target]);
  }
  const byRule: RuleSummary[] = [...ruleBuckets.entries()]
    .map(([ruleId, bucket]) => ({
      ruleId,
      label: bucket[0]?.label ?? ruleId,
      layer: bucket[0]?.layer ?? 'cache',
      targetCount: bucket.length,
      bytes: bucket.reduce((sum, target) => sum + target.bytes, 0),
      reclaimableBytes: bucket
        .filter((target) => !target.locked)
        .reduce((sum, target) => sum + target.bytes, 0),
    }))
    .sort((left, right) => right.bytes - left.bytes);

  // III. Ecosystem breakdown, derived from the owning project's ecosystems.
  const ecosystemBuckets = new Map<string, { bytes: number; reclaimable: number; projects: Set<string> }>();
  const projectEcosystems = new Map(projects.map((project) => [project.path, project.ecosystems]));
  for (const target of targets) {
    const ecosystems = target.projectPath ? (projectEcosystems.get(target.projectPath) ?? []) : [];
    for (const ecosystem of ecosystems) {
      const bucket = ecosystemBuckets.get(ecosystem) ?? {
        bytes: 0,
        reclaimable: 0,
        projects: new Set<string>(),
      };
      bucket.bytes += target.bytes;
      if (!target.locked) bucket.reclaimable += target.bytes;
      if (target.projectPath) bucket.projects.add(target.projectPath);
      ecosystemBuckets.set(ecosystem, bucket);
    }
  }
  const byEcosystem: EcosystemSummary[] = [...ecosystemBuckets.entries()]
    .map(([id, bucket]) => ({
      id,
      name: ecosystemName(id),
      projectCount: bucket.projects.size,
      bytes: bucket.bytes,
      reclaimableBytes: bucket.reclaimable,
    }))
    .sort((left, right) => right.bytes - left.bytes);

  return {
    totalBytes,
    reclaimableBytes,
    targetCount: targets.length,
    lockedCount: targets.filter((target) => target.locked).length,
    fileCount,
    byLayer,
    byRule,
    byEcosystem,
    largestTargetBytes: targets[0]?.bytes ?? 0,
  };
}

/**
 * Build the report's config echo.
 *
 * @param config - The resolved config.
 * @param compiled - Rules that survived the override pass.
 * @returns A plain-data snapshot safe to serialize.
 */
function toSnapshot(config: ResolvedConfig, compiled: readonly CompiledRule[]): ScanReport['config'] {
  const activeIds = new Set(compiled.map((entry) => entry.rule.id));
  return {
    sourcePath: config.sourcePath,
    minSizeBytes: config.minSizeBytes,
    maxDepth: config.maxDepth,
    disabledRules: BUILTIN_RULES.filter((rule) => !activeIds.has(rule.id)).map((rule) => rule.id),
    whitelist: config.whitelist,
    lockedRules: [],
    ecosystems: Object.entries(config.ecosystems)
      .filter(([, value]) => value.enabled)
      .map(([id]) => id)
      .sort(),
    limits: config.limits,
  };
}

/**
 * Resolve the conventional absolute locations a global rule may match.
 *
 * I. Why a static map instead of a glob
 *
 * 1. Walking `~` to find `**\/.npm/_cacache` costs the same as scanning the whole
 *    home directory and finds exactly one directory. Probing the known locations
 *    directly is orders of magnitude cheaper and is why a global-only scan feels
 *    instant.
 *
 * @param ruleId - Global rule id.
 * @returns Candidate absolute directories for that rule.
 */
function globalCandidatesFor(ruleId: string): string[] {
  const home = getHome();
  const platform = getPlatform();
  const cacheRoot = platform === 'darwin' ? join(home, 'Library', 'Caches') : join(home, '.cache');
  const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const map: Readonly<Record<string, string[]>> = {
    'global-npm-cache': [join(home, '.npm', '_cacache')],
    'global-pnpm-store':
      platform === 'darwin'
        ? [join(cacheRoot, 'pnpm'), join(home, '.pnpm-store')]
        : platform === 'win32'
          ? [join(localAppData, 'pnpm', 'store'), join(home, '.pnpm-store')]
          : [join(home, '.local', 'share', 'pnpm', 'store'), join(home, '.pnpm-store')],
    'global-yarn-cache':
      platform === 'darwin'
        ? [join(cacheRoot, 'Yarn')]
        : platform === 'win32'
          ? [join(localAppData, 'Yarn', 'Cache')]
          : [join(home, '.cache', 'yarn')],
    'global-pip-cache':
      platform === 'darwin'
        ? [join(cacheRoot, 'pip')]
        : platform === 'win32'
          ? [join(localAppData, 'pip', 'Cache')]
          : [join(home, '.cache', 'pip')],
    'global-uv-cache':
      platform === 'darwin'
        ? [join(cacheRoot, 'uv')]
        : platform === 'win32'
          ? [join(localAppData, 'uv', 'cache')]
          : [join(home, '.cache', 'uv')],
    'global-xcode-derived-data': [join(home, 'Library', 'Developer', 'Xcode', 'DerivedData')],
    'global-xcode-archives': [join(home, 'Library', 'Developer', 'Xcode', 'Archives')],
    'global-cocoapods': [join(cacheRoot, 'CocoaPods')],
    'global-homebrew-cache':
      platform === 'darwin' ? [join(cacheRoot, 'Homebrew')] : [join(home, '.cache', 'Homebrew')],
    'global-docker-report': [
      join(home, 'Library', 'Containers', 'com.docker.docker', 'Data', 'vms'),
      '/var/lib/docker/overlay2',
    ],
    'go-build-cache': [join(home, '.cache', 'go-build')],
    'go-mod-cache': [join(home, 'go', 'pkg', 'mod')],
    'java-gradle-global-cache': [join(home, '.gradle', 'caches'), join(home, '.gradle', 'wrapper', 'dists')],
    'java-maven-repo': [join(home, '.m2', 'repository')],
    'rust-registry-cache': [
      join(home, '.cargo', 'registry', 'cache'),
      join(home, '.cargo', 'registry', 'src'),
    ],
  };
  return map[ruleId] ?? [];
}

/**
 * Summarize a scan for a one-line CLI banner.
 *
 * @param report - The report.
 * @returns A string such as `1.4 GB reclaimable across 128 targets`.
 */
export function summarizeScan(report: ScanReport): string {
  return `${formatBytes(report.summary.reclaimableBytes)} reclaimable across ${report.summary.targetCount} targets`;
}

/** Re-exported so consumers do not need to reach into the rules layer. */
export { LAYER_ORDER };
