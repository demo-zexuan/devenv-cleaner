/**
 * JSON Report Serialization
 *
 * Turns a {@link ScanReport} into the byte-stable JSON document that
 * `dvc scan --json` prints and `dvc report diff` re-reads, and parses that
 * document back into the contract without ever throwing.
 *
 * I. Why the serialization is hand-written rather than `JSON.stringify(report)`
 *
 * 1. **Determinism is a contract, not a nicety.** A report is committed as a CI
 *    baseline and reviewed as a diff, so the same scan must produce the same
 *    bytes. `JSON.stringify` preserves insertion order for string keys, which
 *    means any upstream `{ ...rest }` spread, a `Map`, or a re-ordered literal
 *    silently reshuffles the file and turns a one-target change into a
 *    whole-file diff. Every object here is therefore rebuilt field by field in
 *    the declaration order of `src/core/types.ts`.
 * 2. **Sorting is part of the contract.** `targets` and `projects` are asserted
 *    to be sorted by `bytes` descending; the report re-sorts them instead of
 *    trusting the producer, so a hand-assembled report (a test fixture, a
 *    future scanner) still serializes canonically.
 *
 * II. Why parsing is total
 *
 * 1. Reports are read from files the user may have edited, truncated or
 *    produced with an older build. A thrown `SyntaxError` at the top of
 *    `dvc report diff` is a stack trace where a sentence belongs, so every
 *    failure mode is returned as `{ ok: false, error }`.
 * 2. A *newer* `schemaVersion` is refused because the fields this module does
 *    not know about may change the meaning of the ones it does. An *older* one
 *    is accepted and defaulted, because the alternative is telling a user their
 *    archive of last month's reports is unreadable.
 *
 * @module report/json
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  CleanTarget,
  DetectedProject,
  EcosystemSummary,
  LayerSummary,
  LockReason,
  ResolvedConfigSnapshot,
  RiskLevel,
  RuleSummary,
  ScanReport,
  ScanSummary,
  TargetKind,
  TargetLayer,
  TargetScope,
} from '../core/types.js';
import { SCHEMA_VERSION } from '../core/types.js';

/** Outcome of parsing or reading a report: never throws, always explains. */
export type ReportParseResult =
  | { readonly ok: true; readonly report: ScanReport }
  | { readonly ok: false; readonly error: string };

/** The JSON object shape of `ResolvedLimits`, in its declared field order. */
interface LimitsJson {
  readonly highRiskBytes: number;
  readonly lightNodeModulesEntries: number;
  readonly concurrency: number;
  readonly maxDirectories: number;
}

/** The JSON object shape of `ResolvedConfigSnapshot`, in declared field order. */
interface ConfigJson {
  readonly sourcePath: string | null;
  readonly minSizeBytes: number;
  readonly maxDepth: number;
  readonly disabledRules: readonly string[];
  readonly whitelist: readonly string[];
  readonly lockedRules: readonly string[];
  readonly ecosystems: readonly string[];
  readonly limits: LimitsJson;
}

/** The JSON object shape of `CleanTarget`, in its declared field order. */
interface TargetJson {
  readonly id: string;
  readonly ruleId: string;
  readonly label: string;
  readonly path: string;
  readonly projectPath: string | null;
  readonly projectName: string | null;
  readonly layer: TargetLayer;
  readonly kind: TargetKind;
  readonly scope: TargetScope;
  readonly risk: RiskLevel;
  readonly bytes: number;
  readonly files: number;
  readonly mtimeMs: number;
  readonly ageDays: number;
  readonly locked: boolean;
  readonly lockedReason: LockReason | null;
  readonly note: string | null;
}

/** The JSON object shape of `DetectedProject`, in its declared field order. */
interface ProjectJson {
  readonly path: string;
  readonly name: string;
  readonly ecosystems: readonly string[];
  readonly markers: readonly string[];
  readonly targetLabels: readonly string[];
  readonly bytes: number;
}

/** The JSON object shape of `LayerSummary`, in its declared field order. */
interface LayerJson {
  readonly layer: TargetLayer;
  readonly targetCount: number;
  readonly bytes: number;
  readonly reclaimableBytes: number;
}

/** The JSON object shape of `RuleSummary`, in its declared field order. */
interface RuleJson {
  readonly ruleId: string;
  readonly label: string;
  readonly layer: TargetLayer;
  readonly targetCount: number;
  readonly bytes: number;
  readonly reclaimableBytes: number;
}

/** The JSON object shape of `EcosystemSummary`, in its declared field order. */
interface EcosystemJson {
  readonly id: string;
  readonly name: string;
  readonly projectCount: number;
  readonly bytes: number;
  readonly reclaimableBytes: number;
}

/** The JSON object shape of `ScanSummary`, in its declared field order. */
interface SummaryJson {
  readonly totalBytes: number;
  readonly reclaimableBytes: number;
  readonly targetCount: number;
  readonly lockedCount: number;
  readonly fileCount: number;
  readonly byLayer: readonly LayerJson[];
  readonly byRule: readonly RuleJson[];
  readonly byEcosystem: readonly EcosystemJson[];
  readonly largestTargetBytes: number;
}

/** The JSON object shape of `ScanReport`, in its declared field order. */
interface ReportJson {
  readonly schemaVersion: number;
  readonly toolVersion: string;
  readonly scannedAt: string;
  readonly root: string;
  readonly platform: string;
  readonly durationMs: number;
  readonly directoriesVisited: number;
  readonly skippedDirectories: number;
  readonly truncated: boolean;
  readonly config: ConfigJson;
  readonly targets: readonly TargetJson[];
  readonly projects: readonly ProjectJson[];
  readonly summary: SummaryJson;
}

/**
 * Every recognized `TargetLayer`, used to reject a corrupted value.
 *
 * Kept as a local literal rather than derived from `engine.LAYER_ORDER` because
 * `report/**` must not depend on `rules/**` (the dependency arrow documented in
 * `docs/design.md` points one way), and because this is a *validation* set: it
 * must stay aligned with the contract in `types.ts`, not with display order.
 */
const LAYERS: readonly TargetLayer[] = ['dependencies', 'build', 'cache', 'artifacts'];

/** Every recognized `TargetKind`. */
const KINDS: readonly TargetKind[] = [
  'node_modules',
  'vendor',
  'venv',
  'build',
  'cache',
  'logs',
  'temp',
  'coverage',
  'artifacts',
];

/** Every recognized `RiskLevel`, ordered so a coerced value is never escalated. */
const RISKS: readonly RiskLevel[] = ['safe', 'low', 'medium', 'high'];

/** Every recognized `TargetScope`. */
const SCOPES: readonly TargetScope[] = ['project', 'global'];

/** Every recognized `LockReason`. */
const LOCK_REASONS: readonly LockReason[] = [
  'protected-path',
  'whitelisted',
  'too-small',
  'too-recent',
  'risk-exceeds-policy',
  'outside-root',
  'user-config',
];

/**
 * Coerce an unknown value to a finite number.
 *
 * A numeric string is accepted because hand-edited reports and JSON exporters
 * routinely quote integers; `NaN`/`Infinity` are not, because they would poison
 * every sum and sort downstream.
 */
function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** Coerce an unknown value to a non-negative integer, truncating fractions. */
function toCount(value: unknown, fallback = 0): number {
  return Math.max(0, Math.trunc(toNumber(value, fallback)));
}

/** Coerce an unknown value to a string, falling back for anything non-string. */
function toText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Coerce an unknown value to a nullable string, mapping `undefined` to null. */
function toNullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Coerce an unknown value to a string array, dropping non-string entries. */
function toTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Test whether a value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow an unknown value to a known union member, or return the fallback. */
function toMember<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Sort an array by bytes descending, then by a secondary key ascending.
 *
 * I. Why this exact order
 *
 * 1. Bytes descending is what every consumer displays and what the contract
 *    asserts, so the serializer owns it.
 * 2. The tie break is *load-bearing for determinism*: two 0-byte targets would
 *    otherwise keep whatever order the producer happened to emit, which makes
 *    the report non-reproducible between filesystems that enumerate a directory
 *    in a different order.
 */
function sortByBytesDesc<T extends { readonly bytes: number }>(
  entries: readonly T[],
  tieBreak: (entry: T) => string,
): T[] {
  return [...entries].sort((left, right) => {
    if (right.bytes !== left.bytes) return right.bytes - left.bytes;
    const leftKey = tieBreak(left);
    const rightKey = tieBreak(right);
    if (leftKey === rightKey) return 0;
    return leftKey < rightKey ? -1 : 1;
  });
}

/**
 * Rebuild a report into its canonical JSON shape.
 *
 * I. Responsibilities
 *
 * 1. **Field order.** Every object is constructed literally in the order
 *    declared by `src/core/types.ts`; a spread is never used, because object
 *    spread would carry an unpredictable key order into the output.
 * 2. **Coercion.** Missing or mistyped scalars are replaced with the contract's
 *    zero value, which is what makes an older `schemaVersion` readable instead
 *    of fatal.
 * 3. **Sorting.** `targets` and `projects` are re-sorted by bytes descending,
 *    then by path ascending.
 * 4. **Idempotence.** Normalizing an already-normalized report is a no-op, and
 *    `parseReportJson(reportToJson(r))` is equal to `normalizeReport(r)`. Both
 *    sides of the round trip funnel through this function so they cannot drift.
 *
 * @param report - A report from the scanner, from `JSON.parse`, or hand-built.
 * @returns The canonical, deterministic report.
 */
function normalizeReport(report: ScanReport): ScanReport {
  const config: ResolvedConfigSnapshot = {
    sourcePath: toNullableText(report.config?.sourcePath),
    minSizeBytes: toCount(report.config?.minSizeBytes),
    maxDepth: toCount(report.config?.maxDepth),
    disabledRules: toTextArray(report.config?.disabledRules),
    whitelist: toTextArray(report.config?.whitelist),
    lockedRules: toTextArray(report.config?.lockedRules),
    ecosystems: toTextArray(report.config?.ecosystems),
    limits: {
      highRiskBytes: toCount(report.config?.limits?.highRiskBytes),
      lightNodeModulesEntries: toCount(report.config?.limits?.lightNodeModulesEntries),
      concurrency: toCount(report.config?.limits?.concurrency),
      maxDirectories: toCount(report.config?.limits?.maxDirectories),
    },
  };

  const targets: CleanTarget[] = (report.targets ?? []).map((target) => ({
    id: toText(target.id),
    ruleId: toText(target.ruleId),
    label: toText(target.label),
    path: toText(target.path),
    projectPath: toNullableText(target.projectPath),
    projectName: toNullableText(target.projectName),
    layer: toMember(target.layer, LAYERS, 'cache'),
    kind: toMember(target.kind, KINDS, 'cache'),
    scope: toMember(target.scope, SCOPES, 'project'),
    risk: toMember(target.risk, RISKS, 'low'),
    bytes: toCount(target.bytes),
    files: toCount(target.files),
    mtimeMs: toCount(target.mtimeMs),
    ageDays: toCount(target.ageDays),
    locked: target.locked === true,
    lockedReason:
      target.lockedReason === null || target.lockedReason === undefined
        ? null
        : toMember(target.lockedReason, LOCK_REASONS, 'user-config'),
    note: toNullableText(target.note),
  }));

  const projects: DetectedProject[] = (report.projects ?? []).map((project) => ({
    path: toText(project.path),
    name: toText(project.name),
    ecosystems: toTextArray(project.ecosystems),
    markers: toTextArray(project.markers),
    targetLabels: toTextArray(project.targetLabels),
    bytes: toCount(project.bytes),
  }));

  const byLayer: LayerSummary[] = (report.summary?.byLayer ?? []).map((entry) => ({
    layer: toMember(entry.layer, LAYERS, 'cache'),
    targetCount: toCount(entry.targetCount),
    bytes: toCount(entry.bytes),
    reclaimableBytes: toCount(entry.reclaimableBytes),
  }));

  const byRule: RuleSummary[] = (report.summary?.byRule ?? []).map((entry) => ({
    ruleId: toText(entry.ruleId),
    label: toText(entry.label),
    layer: toMember(entry.layer, LAYERS, 'cache'),
    targetCount: toCount(entry.targetCount),
    bytes: toCount(entry.bytes),
    reclaimableBytes: toCount(entry.reclaimableBytes),
  }));

  const byEcosystem: EcosystemSummary[] = (report.summary?.byEcosystem ?? []).map((entry) => ({
    id: toText(entry.id),
    name: toText(entry.name),
    projectCount: toCount(entry.projectCount),
    bytes: toCount(entry.bytes),
    reclaimableBytes: toCount(entry.reclaimableBytes),
  }));

  const summary: ScanSummary = {
    totalBytes: toCount(report.summary?.totalBytes),
    reclaimableBytes: toCount(report.summary?.reclaimableBytes),
    targetCount: toCount(report.summary?.targetCount),
    lockedCount: toCount(report.summary?.lockedCount),
    fileCount: toCount(report.summary?.fileCount),
    byLayer,
    byRule: sortByBytesDesc(byRule, (entry) => entry.ruleId),
    byEcosystem: sortByBytesDesc(byEcosystem, (entry) => entry.id),
    largestTargetBytes: toCount(report.summary?.largestTargetBytes),
  };

  return {
    schemaVersion: toNumber(report.schemaVersion, SCHEMA_VERSION),
    toolVersion: toText(report.toolVersion, '0.0.0'),
    scannedAt: toText(report.scannedAt),
    root: toText(report.root),
    platform: toText(report.platform),
    durationMs: toCount(report.durationMs),
    directoriesVisited: toCount(report.directoriesVisited),
    skippedDirectories: toCount(report.skippedDirectories),
    truncated: report.truncated === true,
    config,
    targets: sortByBytesDesc(targets, (target) => target.path),
    projects: sortByBytesDesc(projects, (project) => project.path),
    summary,
  };
}

/**
 * Project a normalized report onto its JSON object shape.
 *
 * I. Why a second projection instead of returning the report itself
 *
 * 1. The report is `readonly`, not `frozen`: nothing stops a caller from
 *    passing an object that also carries extra runtime fields. Projecting
 *    field by field is what guarantees those never leak into the file and that
 *    the emitted key order is exactly the contract order.
 * 2. It is the single place that decides what "the JSON contract" means, so a
 *    future field addition is one line here plus one line in the types.
 */
function toJsonShape(report: ScanReport): ReportJson {
  return {
    schemaVersion: report.schemaVersion,
    toolVersion: report.toolVersion,
    scannedAt: report.scannedAt,
    root: report.root,
    platform: report.platform,
    durationMs: report.durationMs,
    directoriesVisited: report.directoriesVisited,
    skippedDirectories: report.skippedDirectories,
    truncated: report.truncated,
    config: {
      sourcePath: report.config.sourcePath,
      minSizeBytes: report.config.minSizeBytes,
      maxDepth: report.config.maxDepth,
      disabledRules: [...report.config.disabledRules],
      whitelist: [...report.config.whitelist],
      lockedRules: [...report.config.lockedRules],
      ecosystems: [...report.config.ecosystems],
      limits: {
        highRiskBytes: report.config.limits.highRiskBytes,
        lightNodeModulesEntries: report.config.limits.lightNodeModulesEntries,
        concurrency: report.config.limits.concurrency,
        maxDirectories: report.config.limits.maxDirectories,
      },
    },
    targets: report.targets.map((target) => ({
      id: target.id,
      ruleId: target.ruleId,
      label: target.label,
      path: target.path,
      projectPath: target.projectPath,
      projectName: target.projectName,
      layer: target.layer,
      kind: target.kind,
      scope: target.scope,
      risk: target.risk,
      bytes: target.bytes,
      files: target.files,
      mtimeMs: target.mtimeMs,
      ageDays: target.ageDays,
      locked: target.locked,
      lockedReason: target.lockedReason,
      note: target.note,
    })),
    projects: report.projects.map((project) => ({
      path: project.path,
      name: project.name,
      ecosystems: [...project.ecosystems],
      markers: [...project.markers],
      targetLabels: [...project.targetLabels],
      bytes: project.bytes,
    })),
    summary: {
      totalBytes: report.summary.totalBytes,
      reclaimableBytes: report.summary.reclaimableBytes,
      targetCount: report.summary.targetCount,
      lockedCount: report.summary.lockedCount,
      fileCount: report.summary.fileCount,
      byLayer: report.summary.byLayer.map((entry) => ({
        layer: entry.layer,
        targetCount: entry.targetCount,
        bytes: entry.bytes,
        reclaimableBytes: entry.reclaimableBytes,
      })),
      byRule: report.summary.byRule.map((entry) => ({
        ruleId: entry.ruleId,
        label: entry.label,
        layer: entry.layer,
        targetCount: entry.targetCount,
        bytes: entry.bytes,
        reclaimableBytes: entry.reclaimableBytes,
      })),
      byEcosystem: report.summary.byEcosystem.map((entry) => ({
        id: entry.id,
        name: entry.name,
        projectCount: entry.projectCount,
        bytes: entry.bytes,
        reclaimableBytes: entry.reclaimableBytes,
      })),
      largestTargetBytes: report.summary.largestTargetBytes,
    },
  };
}

/**
 * Serialize a scan report to its canonical JSON document.
 *
 * I. Guarantees
 *
 * 1. **Byte stability.** Two calls with equal input produce identical strings:
 *    the key order is fixed by explicit construction, and the two array fields
 *    the contract sorts are sorted here rather than trusted.
 * 2. **Diffability.** Two-space indentation plus a trailing newline, so the
 *    file is a well-formed POSIX text file and `git diff` is line-oriented.
 * 3. **Total.** A non-finite number is coerced by the normalizer instead of
 *    being emitted as `null` by `JSON.stringify`.
 *
 * @param report - The report to serialize.
 * @returns A pretty-printed, deterministic JSON document ending in `\n`.
 *
 * @example
 * ```ts
 * await writeFile('baseline.json', reportToJson(report))
 * ```
 */
export function reportToJson(report: ScanReport): string {
  const shape = toJsonShape(normalizeReport(report));
  return `${JSON.stringify(shape, null, 2)}\n`;
}

/**
 * Parse a JSON report document and validate its contract version.
 *
 * I. Version policy
 *
 * 1. A missing, non-numeric or non-integer `schemaVersion` is a hard error: the
 *    document cannot be trusted to be a report at all.
 * 2. A `schemaVersion` *greater* than {@link SCHEMA_VERSION} is refused rather
 *    than guessed at — a newer producer may have redefined a field this build
 *    would silently misread, and a diff computed from misread numbers is worse
 *    than no diff.
 * 3. A *lower* `schemaVersion` is accepted and every absent field is defaulted
 *    by {@link normalizeReport}, so an archived report stays readable.
 *
 * II. Totality
 *
 * 1. `JSON.parse` failures, wrong root types and invalid versions all return
 *    `{ ok: false, error }`; this function never throws.
 *
 * @param text - Raw file contents or a JSON string from a pipe.
 * @returns The validated, canonical report, or a human-readable error.
 *
 * @example
 * ```ts
 * const parsed = parseReportJson(await readFile(path, 'utf8'))
 * if (!parsed.ok) console.error(parsed.error)
 * ```
 */
export function parseReportJson(text: string): ReportParseResult {
  // I. Syntax first: everything below assumes a parsed value.
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `report is not valid JSON: ${detail}` };
  }

  // II. Shape gate: an array or a scalar can never be a report.
  if (!isRecord(raw)) {
    return { ok: false, error: 'report must be a JSON object at the top level' };
  }

  // III. Version gate, in the order the failure is most useful to explain.
  const version = raw.schemaVersion;
  if (version === undefined || version === null) {
    return { ok: false, error: 'report is missing the required "schemaVersion" field' };
  }
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    return {
      ok: false,
      error: `report "schemaVersion" must be a number, received ${typeof version}`,
    };
  }
  if (!Number.isInteger(version) || version < 0) {
    return { ok: false, error: `report "schemaVersion" must be a non-negative integer, received ${version}` };
  }
  if (version > SCHEMA_VERSION) {
    return {
      ok: false,
      error:
        `report schemaVersion ${version} is newer than the supported version ${SCHEMA_VERSION}; ` +
        'upgrade DevEnvClean to read this report',
    };
  }

  // IV. Field-level trust: the cast is sanctioned by the normalizer, which
  //     replaces every mistyped or absent field with the contract's zero value.
  return { ok: true, report: normalizeReport(raw as unknown as ScanReport) };
}

/**
 * Write a report to disk as canonical JSON.
 *
 * I. Behaviour
 *
 * 1. Parent directories are created recursively, because the default output
 *    directory (`.devenvclean/`) does not exist on a first run.
 * 2. Filesystem failures reject with a message naming the operation and the
 *    path; the caller decides whether that is fatal.
 *
 * @param report - The report to write.
 * @param outPath - Destination file path.
 * @returns A promise that resolves once the bytes are on disk.
 * @throws An `Error` wrapping the underlying filesystem failure.
 */
export async function writeReportJson(report: ScanReport, outPath: string): Promise<void> {
  const document = reportToJson(report);
  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, document, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to write JSON report to ${outPath}: ${detail}`);
  }
}

/**
 * Read and validate a JSON report from disk.
 *
 * I. Behaviour
 *
 * 1. A missing file, a permission error and malformed content all resolve to
 *    `{ ok: false, error }`, so a caller can render a sentence instead of
 *    catching an exception.
 *
 * @param path - Report file to read.
 * @returns The validated report, or a human-readable error.
 */
export async function readReportJson(path: string): Promise<ReportParseResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `failed to read report ${path}: ${detail}` };
  }
  return parseReportJson(text);
}
