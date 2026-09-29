/**
 * DevEnvClean Core Data Contract
 *
 * Single source of truth for every structure that crosses a module boundary.
 *
 * I. Design intent
 *
 * 1. The scan engine only ever produces these shapes; the rule planner, the
 *    reporters and the TUI only ever consume them.
 * 2. Every shape is JSON-serializable, because `dvc scan --json` promises a
 *    stable machine-readable contract that CI pipelines and report diffs rely on.
 * 3. Byte counts are always raw integers (never pre-formatted strings) so that
 *    sorting, summing and diffing stay exact; formatting happens at the edge.
 *
 * II. Stability
 *
 * 1. `SCHEMA_VERSION` tracks the report contract, not the package version.
 *    Consumers must check it before diffing two reports.
 * 2. New optional fields may be added within a schema version; renames and
 *    removals require bumping `SCHEMA_VERSION`.
 *
 * @module core/types
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

/** Report contract version, independent from the package version. */
export const SCHEMA_VERSION = 1;

/**
 * What a removable target physically is.
 *
 * The kind drives both the default risk level and the human explanation shown
 * in the TUI, so it is deliberately coarse: one entry per distinguishable
 * "thing a developer would recognise".
 */
export type TargetKind =
  | 'node_modules'
  | 'vendor'
  | 'venv'
  | 'build'
  | 'cache'
  | 'logs'
  | 'temp'
  | 'coverage'
  | 'artifacts';

/**
 * Which layer of the development lifecycle a target belongs to.
 *
 * This is the axis users actually reason about when deciding what is cheap to
 * lose: dependencies can be re-installed, build outputs can be rebuilt, caches
 * only cost time, and artifacts are the only layer that may be irreplaceable.
 */
export type TargetLayer = 'dependencies' | 'build' | 'cache' | 'artifacts';

/** Risk of the deletion, used for the default selection and the confirm gate. */
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high';

/** How a target was discovered: inside a project, or global to the machine. */
export type TargetScope = 'project' | 'global';

/** A project detected by a marker file, with the ecosystems it implies. */
export interface DetectedProject {
  /** Absolute path of the project root (the directory holding the marker). */
  readonly path: string;
  /** Directory name, used as the display label. */
  readonly name: string;
  /** Ecosystem ids whose marker files were found here, in detection order. */
  readonly ecosystems: readonly string[];
  /** Marker files that caused the detection, relative to `path`. */
  readonly markers: readonly string[];
  /** Labels of every cleanup target found under this project. */
  readonly targetLabels: readonly string[];
  /** Sum of all project-scoped target sizes in bytes. */
  readonly bytes: number;
}

/** One removable directory, the atomic unit of the whole application. */
export interface CleanTarget {
  /** Stable deterministic id, derived from rule id plus absolute path. */
  readonly id: string;
  /** Rule that produced this target. */
  readonly ruleId: string;
  /** Human-readable rule name, e.g. "Node Dependencies". */
  readonly label: string;
  /** Absolute path of the removable directory. */
  readonly path: string;
  /** Project this target belongs to; null for machine-global targets. */
  readonly projectPath: string | null;
  /** Project name for display; null for machine-global targets. */
  readonly projectName: string | null;
  /** Lifecycle layer, the primary grouping in the TUI. */
  readonly layer: TargetLayer;
  /** Physical kind of the directory. */
  readonly kind: TargetKind;
  /** Scope of the target. */
  readonly scope: TargetScope;
  /** Default risk of deleting it. */
  readonly risk: RiskLevel;
  /** Recursive size in bytes. */
  readonly bytes: number;
  /** Recursive file count. */
  readonly files: number;
  /** Last modification time of the directory in epoch milliseconds. */
  readonly mtimeMs: number;
  /**
   * Days since the *newest* file anywhere in the target, which is the value the
   * `olderThanDays` rule filters on.
   *
   * Anchoring on the newest file rather than the directory's own mtime is
   * deliberate: a directory's mtime only changes when entries are added or
   * removed, so a checkout that was installed once and then used daily can look
   * years old. The newest file instead answers "has anything in here been
   * touched recently", which is the safety question the guard is really asking.
   */
  readonly ageDays: number;
  /**
   * True when the rule's deep conditions were satisfied *and* the target is
   * eligible for deletion under the active config. A locked target is still
   * reported (visibility matters) but is not selectable in the TUI and is
   * skipped by `dvc clean` unless `--include-locked` is passed.
   */
  readonly locked: boolean;
  /** Machine-readable reason for `locked`, or null when unlocked. */
  readonly lockedReason: LockReason | null;
  /** Rule-declared caveat shown next to the size, e.g. "re-installable". */
  readonly note: string | null;
}

/** Why a discovered target is not eligible for deletion. */
export type LockReason =
  | 'protected-path'
  | 'whitelisted'
  | 'too-small'
  | 'too-recent'
  | 'risk-exceeds-policy'
  | 'outside-root'
  | 'user-config';

/** What happened to a target during execution. */
export type CleanOutcome = 'deleted' | 'skipped' | 'failed';

/** Per-target execution record. */
export interface CleanResult {
  /** Target id, matching `CleanTarget.id`. */
  readonly targetId: string;
  /** Absolute path that was acted on. */
  readonly path: string;
  /** Outcome of the action. */
  readonly outcome: CleanOutcome;
  /** Bytes actually reclaimed; 0 unless the outcome is `deleted`. */
  readonly freedBytes: number;
  /** Wall-clock duration of the action in milliseconds. */
  readonly durationMs: number;
  /** Error message when the outcome is `failed`. */
  readonly error: string | null;
  /** Why it was skipped, when the outcome is `skipped`. */
  readonly skipReason: string | null;
}

/** Aggregate view of one rule's contribution, used by `report` and the TUI. */
export interface RuleSummary {
  /** Rule id. */
  readonly ruleId: string;
  /** Rule label. */
  readonly label: string;
  /** Layer this rule feeds. */
  readonly layer: TargetLayer;
  /** Number of targets this rule produced. */
  readonly targetCount: number;
  /** Sum of the produced targets' sizes in bytes. */
  readonly bytes: number;
  /** Sum of the produced targets' sizes that are actually eligible. */
  readonly reclaimableBytes: number;
}

/** Aggregate view of one ecosystem's contribution. */
export interface EcosystemSummary {
  /** Ecosystem id, e.g. `node`. */
  readonly id: string;
  /** Display name, e.g. `Node.js`. */
  readonly name: string;
  /** Number of projects detected for this ecosystem. */
  readonly projectCount: number;
  /** Sum of this ecosystem's target sizes in bytes. */
  readonly bytes: number;
  /** Sum of this ecosystem's eligible target sizes in bytes. */
  readonly reclaimableBytes: number;
}

/** Per-layer totals, the headline numbers of a scan. */
export interface LayerSummary {
  /** Layer these totals describe. */
  readonly layer: TargetLayer;
  /** Number of targets in this layer. */
  readonly targetCount: number;
  /** Total bytes in this layer. */
  readonly bytes: number;
  /** Eligible bytes in this layer. */
  readonly reclaimableBytes: number;
}

/** Everything the TUI groups by, computed once at the end of a scan. */
export interface ScanSummary {
  /** Total bytes occupied by every discovered target. */
  readonly totalBytes: number;
  /** Bytes that the active config would allow deleting right now. */
  readonly reclaimableBytes: number;
  /** Total number of discovered targets. */
  readonly targetCount: number;
  /** Number of targets that are *not* eligible for deletion under the config. */
  readonly lockedCount: number;
  /** Total number of files across every target. */
  readonly fileCount: number;
  /** Per-layer breakdown, always containing every layer in display order. */
  readonly byLayer: readonly LayerSummary[];
  /** Per-rule breakdown, sorted by bytes descending. */
  readonly byRule: readonly RuleSummary[];
  /** Per-ecosystem breakdown, sorted by bytes descending. */
  readonly byEcosystem: readonly EcosystemSummary[];
  /** Largest single target in bytes, or 0 when nothing was found. */
  readonly largestTargetBytes: number;
}

/** A complete scan result: the report contract. */
export interface ScanReport {
  /** Report contract version; consumers must verify this first. */
  readonly schemaVersion: number;
  /** Package version that produced the report. */
  readonly toolVersion: string;
  /** ISO-8601 timestamp of when the scan started. */
  readonly scannedAt: string;
  /** Absolute path the scan started from. */
  readonly root: string;
  /** Platform id, e.g. `darwin`, `linux`, `win32`. */
  readonly platform: string;
  /** Wall-clock scan duration in milliseconds. */
  readonly durationMs: number;
  /** Number of directories visited while walking the tree. */
  readonly directoriesVisited: number;
  /** Directories that could not be read (permissions, races). */
  readonly skippedDirectories: number;
  /**
   * True when the walk hit `limits.maxDirectories` and stopped early.
   *
   * Reported rather than thrown because a truncated scan is still useful, but a
   * consumer must know that the totals are a floor and not a complete picture.
   * Kept distinct from `skippedDirectories`, which counts unreadable
   * directories — two different degradations with two different remedies.
   */
  readonly truncated: boolean;
  /** Config that was in effect, so a report is reproducible. */
  readonly config: ResolvedConfigSnapshot;
  /** Every discovered target, sorted by bytes descending. */
  readonly targets: readonly CleanTarget[];
  /** Every detected project, sorted by bytes descending. */
  readonly projects: readonly DetectedProject[];
  /** Precomputed aggregates for display. */
  readonly summary: ScanSummary;
}

/**
 * A resolved, plain-data echo of the config that produced a report.
 *
 * Deliberately a snapshot rather than the live `ResolvedConfig` type: report
 * consumers must never depend on runtime-only fields such as compiled matchers.
 */
export interface ResolvedConfigSnapshot {
  /** Config file that was loaded, or null when built-in defaults were used. */
  readonly sourcePath: string | null;
  /** Minimum target size in bytes for a target to stay unlocked. */
  readonly minSizeBytes: number;
  /** Maximum directory depth walked below each scan root. */
  readonly maxDepth: number;
  /** Rule ids that were disabled. */
  readonly disabledRules: readonly string[];
  /** Absolute path fragments that are never touched. */
  readonly whitelist: readonly string[];
  /** Rule ids the user locked manually. */
  readonly lockedRules: readonly string[];
  /**
   * Ecosystem ids that were enabled for this scan.
   *
   * Recorded so a report can reproduce *why* a Cargo cache appears in one run
   * and not another; without it, a diff between two reports could attribute a
   * configuration change to a filesystem change.
   */
  readonly ecosystems: readonly string[];
  /** Caps that were applied to the rule set. */
  readonly limits: ResolvedLimits;
}

/** Numeric guard rails, kept separate so they can be echoed in one place. */
export interface ResolvedLimits {
  /** Size in bytes above which a target is treated as high risk. */
  readonly highRiskBytes: number;
  /** Directories below which a `node_modules` is considered light. */
  readonly lightNodeModulesEntries: number;
  /** Concurrency used by the size walker. */
  readonly concurrency: number;
  /** Hard ceiling on visited directories, as a runaway guard. */
  readonly maxDirectories: number;
}

/** A single rule's declarative definition. */
export interface CleanRule {
  /** Unique id, also the config key for overrides. */
  readonly id: string;
  /** Display name. */
  readonly label: string;
  /** One-sentence explanation shown in `dvc rules explain`. */
  readonly description: string;
  /** Lifecycle layer this rule feeds. */
  readonly layer: TargetLayer;
  /** Physical kind of the matched directory. */
  readonly kind: TargetKind;
  /** Scope of the matched directory. */
  readonly scope: TargetScope;
  /** Risk assigned to a match before size-based escalation. */
  readonly risk: RiskLevel;
  /**
   * Glob patterns evaluated against each directory's *absolute* path, using
   * `fast-glob` semantics with `dot: true` so dot-directories match too.
   */
  readonly patterns: readonly string[];
  /**
   * If set, the rule only matches inside a directory that one of these
   * ecosystem detectors marked as a project root.
   */
  readonly withinEcosystem: readonly string[] | null;
  /**
   * If set, the match is only actionable when the directory holds at least this
   * many entries — the guard that separates a real `node_modules` from a stub.
   */
  readonly minEntries: number | null;
  /** If set, only matches older than this many days stay unlocked. */
  readonly olderThanDays: number | null;
  /** Never delete, only report. Used by rules that model dangerous locations. */
  readonly reportOnly: boolean;
  /** Short caveat rendered next to the size. */
  readonly note: string | null;
}

/** User-supplied rule overrides, exactly as written in the config file. */
export interface RuleOverride {
  /** Set false to disable the rule entirely. */
  readonly enabled?: boolean;
  /** Replacement risk level. */
  readonly risk?: RiskLevel;
  /** Replacement minimum size in bytes. */
  readonly minSizeBytes?: number;
  /** Replacement staleness threshold in days. */
  readonly olderThanDays?: number;
  /** Replacement minimum entry count. */
  readonly minEntries?: number;
  /** Extra glob patterns appended to `CleanRule.patterns`. */
  readonly extraPatterns?: readonly string[];
  /** Force `reportOnly` on or off. */
  readonly reportOnly?: boolean;
}

/** Root config file shape, i.e. `dvc.config.json`. */
export interface UserConfig {
  /** Report schema the file was written against; a mismatch is a warning. */
  readonly schemaVersion?: number;
  /** Absolute or `~`-prefixed directories to include in a scan. */
  readonly roots?: readonly string[];
  /** Directory depth walked below each root. */
  readonly maxDepth?: number;
  /** Minimum size in bytes for a target to stay unlocked. */
  readonly minSizeBytes?: number;
  /** Absolute path fragments that must never be deleted. */
  readonly whitelist?: readonly string[];
  /** How long deleted payloads are kept; reserved for the recycle feature. */
  readonly retentionDays?: number;
  /** Per-rule overrides keyed by rule id. */
  readonly rules?: Readonly<Record<string, RuleOverride>>;
  /** Numeric guard rails. */
  readonly limits?: Partial<ResolvedLimits>;
  /** Ecosystem detector overrides keyed by ecosystem id. */
  readonly ecosystems?: Readonly<Record<string, { readonly enabled?: boolean }>>;
  /** Report emission settings. */
  readonly report?: {
    /** Directory reports are written to, defaulting to `.devenvclean/`. */
    readonly dir?: string;
    /** Default report format when `dvc report export` is not told explicitly. */
    readonly format?: 'json' | 'markdown';
  };
}

/**
 * Resolved config with defaults applied; what the engine actually consumes.
 *
 * I. Why `schemaVersion` is omitted
 *
 * 1. It documents the *file's* format, not the runtime configuration, and a
 *    resolved config has no file format to version. Carrying it here would force
 *    every programmatic caller to invent a value that means nothing.
 */
export interface ResolvedConfig
  extends Required<Omit<UserConfig, 'rules' | 'ecosystems' | 'report' | 'retentionDays' | 'schemaVersion'>> {
  /** Config file the values came from, or null for pure defaults. */
  readonly sourcePath: string | null;
  /** Original overrides, retained for `dvc config show` and report echoes. */
  readonly rules: Readonly<Record<string, RuleOverride>>;
  /** Fully resolved numeric guard rails. */
  readonly limits: ResolvedLimits;
  /** Resolved report emission settings. */
  readonly report: { readonly dir: string; readonly format: 'json' | 'markdown' };
  /** Resolved retention window in days. */
  readonly retentionDays: number;
  /** Ecosystem enablement flags, defaulting to all-on. */
  readonly ecosystems: Readonly<Record<string, { readonly enabled: boolean }>>;
}

/** Progress emitted by the scanner so the TUI can render a live view. */
export interface ScanProgress {
  /** Current phase of the scan. */
  readonly phase: 'discovering' | 'measuring' | 'finalizing';
  /** Directories visited so far. */
  readonly directoriesVisited: number;
  /** Targets discovered so far. */
  readonly targetsFound: number;
  /** Bytes measured so far. */
  readonly bytesFound: number;
  /** Path currently being walked, for the live label. */
  readonly currentPath: string;
}

/** Callback the scanner invokes as it works. */
export type ScanProgressHandler = (progress: ScanProgress) => void;

/** Options accepted by the scanner. */
export interface ScanOptions {
  /** Absolute directories to scan. */
  readonly roots: readonly string[];
  /** Resolved configuration. */
  readonly config: ResolvedConfig;
  /** Progress callback; omitted for a silent non-interactive scan. */
  readonly onProgress?: ScanProgressHandler;
  /** Cancellation signal, wired to Ctrl-C. */
  readonly signal?: AbortSignal;
  /**
   * Whether to also probe the machine's global package-manager caches.
   *
   * Defaults to `true` only when a scan root is the home directory. A scoped
   * scan of one project must not report a 400 GB Docker VM it was never asked
   * about, because that makes every project-level total meaningless; the
   * opt-in flag exists for the case where the user really does want the whole
   * machine's cache picture.
   */
  readonly includeGlobalTargets?: boolean;
}

/** A computed plan: the dry run the user reviews before confirming. */
export interface CleanPlan {
  /** Targets the plan will act on, in execution order. */
  readonly targets: readonly CleanTarget[];
  /** Total bytes claimed to be freed. */
  readonly totalBytes: number;
  /** Targets that matched but were locked, kept for transparency. */
  readonly skipped: readonly CleanTarget[];
  /** Reasons aggregated across `skipped`, for the explanation line. */
  readonly skipReasons: readonly string[];
}

/** Options accepted by the executor. */
export interface CleanOptions {
  /** The plan to execute. */
  readonly plan: CleanPlan;
  /** Resolved configuration; re-checked at execution time. */
  readonly config: ResolvedConfig;
  /**
   * When true, walk the plan and report what *would* happen, touching nothing.
   *
   * The dry run is the second step of the confirmation model: the user sees the
   * exact per-target outcome list before any unlink is attempted, so a mistaken
   * selection costs nothing.
   */
  readonly dryRun: boolean;
  /**
   * Skip the pre-flight size re-measurement.
   *
   * Re-measuring each target immediately before deleting it is what makes the
   * reported bytes honest rather than a stale number from scan time, but it
   * doubles the walk on a large cleanup. Callers that have just scanned and
   * accept the scan's numbers may turn it off.
   */
  readonly skipRemeasure?: boolean;
  /** Progress callback fired once per target. */
  readonly onProgress?: (result: CleanResult) => void;
  /** Cancellation signal. */
  readonly signal?: AbortSignal;
}

/** Result of a full execution. */
export interface CleanExecution {
  /** Per-target outcomes in execution order. */
  readonly results: readonly CleanResult[];
  /** Bytes actually reclaimed. */
  readonly freedBytes: number;
  /** Targets deleted successfully. */
  readonly deletedCount: number;
  /** Targets skipped by a re-check. */
  readonly skippedCount: number;
  /** Targets that failed. */
  readonly failedCount: number;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** ISO-8601 timestamp of when the execution started. */
  readonly startedAt: string;
}

/** Two scans compared, i.e. the growth report. */
export interface ReportDiff {
  /** The older report. */
  readonly from: ScanReport;
  /** The newer report. */
  readonly to: ScanReport;
  /** Net byte change; positive means growth. */
  readonly deltaBytes: number;
  /** Per-target-path deltas, sorted by absolute delta descending. */
  readonly entries: readonly ReportDiffEntry[];
}

/** One path's change between two reports. */
export interface ReportDiffEntry {
  /** Absolute path being compared. */
  readonly path: string;
  /** Rule that owns the path in either report. */
  readonly ruleId: string;
  /** Bytes in the older report, 0 when the path is new. */
  readonly fromBytes: number;
  /** Bytes in the newer report, 0 when the path disappeared. */
  readonly toBytes: number;
  /** Signed byte change. */
  readonly deltaBytes: number;
  /** How the path changed. */
  readonly change: 'added' | 'removed' | 'grew' | 'shrank' | 'unchanged';
}

/** Severity of a `dvc doctor` check. */
export type DoctorStatus = 'pass' | 'warn' | 'fail';

/** One environment check. */
export interface DoctorCheck {
  /** Short check name. */
  readonly name: string;
  /** Outcome. */
  readonly status: DoctorStatus;
  /** One-line explanation. */
  readonly detail: string;
  /** Optional remediation hint shown when the status is not `pass`. */
  readonly hint: string | null;
}
