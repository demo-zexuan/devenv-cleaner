/**
 * Rule Engine
 *
 * Compiles the declarative rule catalog into matchers, walks a scan root once,
 * and resolves every match into a deduplicated target.
 *
 * I. The two problems this module solves
 *
 * 1. **Matching cost.** A scan may test a hundred thousand directories against
 *    fifty rule patterns. Compiling every pattern to a regular expression once
 *    per run turns that into a single in-memory test per directory per rule,
 *    instead of a glob library call per pair.
 * 2. **Double counting.** `**\/node_modules` matches a nested `node_modules`
 *    inside a `node_modules`. Reporting both would inflate the reclaimable
 *    total by the size of every nested match and, worse, tell the user to
 *    delete a directory that is about to disappear with its parent. The
 *    *longest-path-wins* rule keeps only the outermost match of any nested set.
 *
 * II. Why the walk lives here rather than in the scanner
 *
 * 1. Matching a rule and deciding whether a match is actionable are the same
 *    concern — both need the ecosystem context of the directory being visited,
 *    and splitting them would force the scanner to re-walk the tree.
 *
 * @module rules/engine
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import type { Dirent } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { detectInEntries, type EcosystemId } from '../core/detector.js';
import { findContainingRoot, isProtectedResolvedPath, normalizeForCompare } from '../core/platform.js';
import type {
  CleanRule,
  DetectedProject,
  LockReason,
  ResolvedConfig,
  RiskLevel,
  RuleOverride,
  TargetLayer,
} from '../core/types.js';

/** A rule with its overrides applied and its patterns compiled. */
export interface CompiledRule {
  /** The resolved rule definition. */
  readonly rule: CleanRule;
  /** Compiled path matchers, one per pattern. */
  readonly matchers: readonly CompiledGlob[];
}

/**
 * Compile a glob pattern into a `RegExp` matched against a normalized path.
 *
 * I. Dialect
 *
 * 1. `**` spans path separators, `*` does not.
 * 2. `?` matches a single non-separator character.
 * 3. `{a,b}` alternation and `[abc]` character classes are supported, matching
 *    the subset of the glob dialect the built-in catalog actually uses.
 * 4. Patterns are anchored to the whole path.
 *
 * II. The absolute-path problem
 *
 * 1. Every path matched here is absolute, so a pattern that begins with the
 *    double-star separator prefix must also match at the filesystem root.
 *    Translating that prefix to the naive "one or more complete segments" group
 *    fails exactly that case: after consuming a whole number of `segment/` pairs
 *    the cursor sits *after* a separator, but an absolute path begins *with*
 *    one, so the fixture path `/tmp/a/node_modules` could never be reached.
 * 2. The translation is therefore an optional leading segment (which matches
 *    the empty segment of a path that is itself at the root, correctly
 *    consuming the leading separator) followed by any number of whole segments.
 *    That is equivalent to "one optional first segment, then zero or more more".
 *
 * III. Implementation note
 *
 * 1. The compile is a small character scanner rather than a chain of regex
 *    replacements, because `**` must not be confused with two `*` and because
 *    escaping the literal segments correctly is otherwise error-prone.
 *
 * @param pattern - Glob pattern, e.g. `**\/node_modules`.
 * @returns A compiled matcher.
 */
export interface CompiledGlob {
  /** The original pattern, retained for diagnostics and report output. */
  readonly source: string;
  /** Anchored regular expression. */
  readonly regex: RegExp;
  /** Literal trailing segment, used to short-circuit `node_modules`-style rules. */
  readonly trailingLiteral: string | null;
}

/**
 * Compile one glob pattern.
 *
 * @param pattern - Glob pattern using `/` as the separator.
 * @returns The compiled matcher.
 */
export function compileGlob(pattern: string): CompiledGlob {
  // I. Normalize to forward slashes so Windows paths compare identically.
  const normalized = pattern.replace(/\\/g, '/');
  let source = '';
  let index = 0;

  while (index < normalized.length) {
    const character = normalized[index] as string;

    // II. `**` — cross-separator wildcard.
    if (character === '*' && normalized[index + 1] === '*') {
      const afterDouble = normalized[index + 2];
      if (afterDouble === '/') {
        // A leading double-star plus separator matches zero or more whole
        // segments *including* the empty first segment that an absolute path
        // presents at the filesystem root, which is what consumes the leading
        // separator of `/repo/node_modules`.
        source += '[^/]*/(?:[^/]+/)*';
        index += 3;
        continue;
      }
      if (afterDouble === undefined) {
        // A trailing `**` means "this directory and everything below it".
        source += '.*';
        index += 2;
        continue;
      }
      // `**` immediately followed by a non-separator is treated as a
      // single-segment wildcard, matching how glob implementations degrade it.
      source += '[^/]*';
      index += 2;
      continue;
    }

    // III. `*` — single-segment wildcard.
    if (character === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }

    // IV. `?` — single character, never a separator.
    if (character === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    // V. `{a,b,c}` alternation.
    if (character === '{') {
      const closing = normalized.indexOf('}', index);
      if (closing > index) {
        const alternatives = normalized
          .slice(index + 1, closing)
          .split(',')
          .map((alternative) => alternative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        source += `(?:${alternatives.join('|')})`;
        index = closing + 1;
        continue;
      }
    }

    // VI. `[abc]` character class and `[!abc]` negation.
    if (character === '[') {
      const closing = normalized.indexOf(']', index);
      if (closing > index) {
        const body = normalized.slice(index + 1, closing).replace(/^!/, '^');
        source += `[${body}]`;
        index = closing + 1;
        continue;
      }
    }

    // VII. Everything else is a literal, escaped for regex safety.
    source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    index += 1;
  }

  // VIII. Extract a trailing literal segment, but only when the pattern ends in
  //       one: it enables a cheap first-character rejection on the hot path.
  const trailingMatch = /(?:^|\/)([A-Za-z0-9._-]+)$/.exec(normalized);
  const trailingLiteral =
    trailingMatch && !/[?*[\]{}]/.test(trailingMatch[1] as string) ? (trailingMatch[1] as string) : null;

  return { source: pattern, regex: new RegExp(`^${source}$`), trailingLiteral };
}

/**
 * Test one normalized path against a compiled matcher.
 *
 * @param matcher - Compiled matcher.
 * @param normalizedPath - Path with forward slashes and no trailing separator.
 * @param basename - The path's final segment, for the literal fast path.
 * @returns True on a match.
 */
function matchesGlob(matcher: CompiledGlob, normalizedPath: string, basename: string): boolean {
  // I. Fast rejection: a pattern that must end in a literal cannot match a
  //    directory with a different name, which skips the regex for most rules.
  if (matcher.trailingLiteral !== null && matcher.trailingLiteral !== basename) return false;
  return matcher.regex.test(normalizedPath);
}

/**
 * Apply user overrides to the built-in catalog.
 *
 * I. Merge semantics
 *
 * 1. An override never *adds* a rule; it only tunes one that already exists, so
 *    a typo in a rule id cannot invent a deletion rule.
 * 2. `enabled: false` removes the rule before compilation, which is cheaper
 *    than matching and then filtering.
 * 3. `extraPatterns` are appended, never replaced, so a user can widen a rule
 *    without having to restate the built-in defaults they would otherwise lose.
 *
 * @param rules - Built-in rules to tune.
 * @param overrides - Overrides keyed by rule id.
 * @returns Rules with overrides applied and patterns compiled.
 */
export function compileRules(
  rules: readonly CleanRule[],
  overrides: Readonly<Record<string, RuleOverride>>,
): CompiledRule[] {
  const compiled: CompiledRule[] = [];

  for (const rule of rules) {
    const override = overrides[rule.id];

    // I. Disabled rules never reach the matcher.
    if (override?.enabled === false) continue;

    // II. Field-level overrides, with `undefined` meaning "keep the default".
    const tuned: CleanRule = {
      ...rule,
      risk: override?.risk ?? rule.risk,
      olderThanDays: override?.olderThanDays ?? rule.olderThanDays,
      minEntries: override?.minEntries ?? rule.minEntries,
      reportOnly: override?.reportOnly ?? rule.reportOnly,
      patterns: override?.extraPatterns ? [...rule.patterns, ...override.extraPatterns] : rule.patterns,
    };

    // III. Per-rule `minSizeBytes` is not part of `CleanRule`; it is applied by
    //      the planner through the config snapshot, so nothing to do here.

    compiled.push({
      rule: tuned,
      matchers: tuned.patterns.map((pattern) => compileGlob(pattern)),
    });
  }

  return compiled;
}

/** Raw match produced by the walk, before deduplication and measurement. */
export interface RawMatch {
  /** The rule that matched. */
  readonly rule: CleanRule;
  /** Absolute path of the matched directory. */
  readonly path: string;
  /** Project the match belongs to, or null for a global rule. */
  readonly project: DetectedProject | null;
  /** Ecosystem context of the containing directory. */
  readonly ecosystems: readonly EcosystemId[];
  /** True when a strong project marker was found in the containing directory. */
  readonly withinProjectRoot: boolean;
  /** Lock reason already determined by a cheap check, or null. */
  readonly lockedReason: LockReason | null;
}

/** Options for {@link matchTargets}. */
export interface MatchOptions {
  /** Absolute root to walk. */
  readonly root: string;
  /** Compiled rules. */
  readonly rules: readonly CompiledRule[];
  /** Resolved config, for depth, whitelist and ecosystem toggles. */
  readonly config: ResolvedConfig;
  /** All scan roots, for the containment gate. */
  readonly roots: readonly string[];
  /** Cancellation signal. */
  readonly signal?: AbortSignal;
  /** Called with the number of directories visited so far. */
  readonly onVisit?: (count: number) => void;
}

/** Result of walking one scan root. */
export interface RootMatchResult {
  /** Every raw match found under the root, before deduplication. */
  readonly matches: readonly RawMatch[];
  /** Every project root discovered under the root, including the root itself. */
  readonly projects: readonly DetectedProject[];
  /** Number of directories visited. */
  readonly visited: number;
}

/**
 * Walk a root and collect every rule match plus every project it contains.
 *
 * I. Traversal rules
 *
 * 1. Symbolic links are never followed, for the same reason the size walker
 *    does not follow them: escaping the scan root invalidates the containment
 *    guarantee.
 * 2. A matched directory *is still descended into*, because deduplication
 *    happens after the walk. Descending is cheap relative to a second walk, and
 *    it is what lets a nested `target/` under a `node_modules` be found when the
 *    outer directory matched a different rule.
 * 3. Depth is bounded by `config.maxDepth`, counted from the root.
 *
 * II. Project attribution
 *
 * 1. Detection is per-directory: any directory holding a strong marker is a
 *    project root. The scan root is *not* special-cased here, because a scan
 *    root is usually a container (`~/dev`) rather than a project, and treating
 *    it as the project for everything beneath it would collapse a whole
 *    workspace into one row in the UI.
 * 2. Attribution to the *nearest* ancestor project is therefore deferred to the
 *    scanner, which has the measured targets and the full project list in hand.
 *
 * III. Ecosystem scoping
 *
 * 1. `withinEcosystem` uses the directory's *visible* project context: the
 *    nearest ancestor marker set, or the directory's own markers when it is
 *    itself a root. This mirrors the inherited-context behaviour a developer
 *    expects from a monorepo, without threading state through the recursion.
 *
 * @param options - Match options.
 * @returns Matches, discovered projects and the visit count.
 */
export async function matchTargets(options: MatchOptions): Promise<RootMatchResult> {
  const { root, rules, config, roots, signal, onVisit } = options;
  const matches: RawMatch[] = [];
  const projects: DetectedProject[] = [];
  const enabledEcosystems = Object.entries(config.ecosystems)
    .filter(([, value]) => value.enabled)
    .map(([id]) => id as EcosystemId);
  const maxDepth = config.maxDepth;
  let visited = 0;

  /**
   * Recursive walk.
   *
   * @param directoryPath - Directory being visited.
   * @param depth - Depth below the scan root.
   * @param inheritedEcosystems - Ecosystems of the nearest ancestor project.
   */
  async function walk(
    directoryPath: string,
    depth: number,
    inheritedEcosystems: readonly EcosystemId[],
  ): Promise<void> {
    if (signal?.aborted) return;
    visited += 1;
    if (onVisit && visited % 200 === 0) onVisit(visited);

    // I. Read the directory once; every downstream decision uses this list.
    let entries: Dirent[];
    try {
      const handle = await opendir(directoryPath);
      entries = [];
      for await (const entry of handle) entries.push(entry);
    } catch {
      // An unreadable directory is reported by the scanner's own counter; the
      // matcher simply has nothing to say about it.
      return;
    }

    const names = entries.map((entry) => entry.name);
    const detection = detectInEntries(names, { enabledEcosystems });

    // II. Establish this directory's project identity when it has one.
    let projectEcosystems = inheritedEcosystems;
    if (detection.isProjectRoot) {
      projectEcosystems = detection.ecosystems;
      projects.push({
        path: directoryPath,
        name: directoryPath.split(sep).filter(Boolean).at(-1) ?? directoryPath,
        ecosystems: detection.ecosystems,
        markers: detection.markers,
        targetLabels: [],
        bytes: 0,
      });
    }

    const normalizedPath = normalizeForCompare(directoryPath);
    const basename = normalizedPath.split('/').at(-1) ?? normalizedPath;
    const insideRoot = findContainingRoot(directoryPath, roots) !== null;
    // The strict variant, because directories walked under a canonicalized root
    // carry the canonical path: on macOS a legitimate `/tmp` project reads as
    // `/private/tmp/...`, which the plain denylist test would reject outright.
    const protectedPath = isProtectedResolvedPath(directoryPath);

    // III. Test every rule against this directory.
    for (const compiled of rules) {
      const { rule } = compiled;

      // (1) Machine-global rules are matched by the scanner against the known
      //     global cache roots, never during a project tree walk.
      if (rule.scope === 'global') continue;

      if (!compiled.matchers.some((matcher) => matchesGlob(matcher, normalizedPath, basename))) continue;

      // (2) Ecosystem scoping: a rule declared for Node must not match a random
      //     `vendor` directory in a tree with no PHP or Ruby context.
      if (rule.withinEcosystem && rule.withinEcosystem.length > 0) {
        const inEcosystem = rule.withinEcosystem.some((id) => projectEcosystems.includes(id as EcosystemId));
        if (!inEcosystem) continue;
      }

      // (3) Cheap lock reasons are resolved here; size- and age-based ones are
      //     applied after measurement, because they need the numbers.
      let lockedReason: LockReason | null = null;
      if (!insideRoot) lockedReason = 'outside-root';
      else if (protectedPath) lockedReason = 'protected-path';
      else if (isWhitelisted(directoryPath, config.whitelist)) lockedReason = 'whitelisted';

      matches.push({
        rule,
        path: directoryPath,
        project: null,
        ecosystems: projectEcosystems,
        withinProjectRoot: detection.isProjectRoot,
        lockedReason,
      });
    }

    // IV. Recurse, respecting the depth ceiling.
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (signal?.aborted) return;
      // (1) Never follow a symbolic link: it can leave the scan root entirely.
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      // (2) Skip directory names that can never hold a target and are expensive
      //     or unreadable to traverse.
      if (SHALLOW_SKIP.has(entry.name)) continue;
      // (3) A fresh `node_modules` inside a project introduces its own nested
      //     projects, which detection picks up on the next level down.
      await walk(join(directoryPath, entry.name), depth + 1, projectEcosystems);
    }
  }

  await walk(root, 0, []);
  onVisit?.(visited);
  return { matches, projects, visited };
}

/**
 * Directory names never descended into during pattern matching.
 *
 * I. Rationale
 *
 * 1. Version-control object stores are enormous and can never contain a
 *    cleanup target; descending into `.git` would burn the scan budget the user
 *    is waiting on and risks matching a rule inside a repository's internals,
 *    which would be a deletion bug rather than a cleanup.
 * 2. `node_modules` is deliberately *not* skipped. A monorepo's nested
 *    workspaces live there and `pnpm`'s layout puts each package's own
 *    `node_modules` under it, so skipping would silently under-report the exact
 *    directories this tool exists to find.
 */
const SHALLOW_SKIP: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  '.Trash',
  '.Spotlight-V100',
  '.fseventsd',
  '.DocumentRevisions-V100',
  'System Volume Information',
  '$RECYCLE.BIN',
]);

/**
 * Test a path against the user whitelist.
 *
 * @param targetPath - Absolute path.
 * @param whitelist - Absolute path fragments from the config.
 * @returns True when the path must not be deleted.
 */
export function isWhitelisted(targetPath: string, whitelist: readonly string[]): boolean {
  if (whitelist.length === 0) return false;
  const candidate = normalizeForCompare(targetPath);
  const home = homedir();
  return whitelist.some((entry) => {
    // A `~`-prefixed entry is expanded against the real home directory so the
    // config file stays portable between machines and user accounts.
    const normalized = normalizeForCompare(entry.replace(/^~(?=[/\\]|$)/, home));
    return candidate === normalized || candidate.startsWith(`${normalized}/`);
  });
}

/**
 * Remove nested matches so no byte is counted twice.
 *
 * I. Algorithm
 *
 * 1. Sort matches by path, which places a parent immediately before any of its
 *    descendants because a parent path is a strict prefix of them.
 * 2. Sweep the sorted list keeping the set of accepted ancestors; a match is
 *    dropped when it sits inside the most recently accepted directory.
 * 3. A match on the exact same path as an accepted one is dropped too, which
 *    collapses two rules that recognise the same directory (for example
 *    `**\/build` and `**\/build/libs`) to the rule listed first in the catalog.
 *
 * II. Why sorting is sufficient
 *
 * 1. Lexicographic order guarantees `/a/b` precedes `/a/b/c`, so a single
 *    forward sweep sees every ancestor before its descendants. No second pass
 *    or per-path lookup structure is needed.
 *
 * @param matches - Raw matches, unsorted and possibly nested.
 * @returns The deduplicated matches, sorted by path and then by catalog order.
 */
export function dedupeNestedMatches(matches: readonly RawMatch[]): RawMatch[] {
  const sorted = [...matches].sort((left, right) => {
    const leftPath = normalizeForCompare(left.path);
    const rightPath = normalizeForCompare(right.path);
    if (leftPath !== rightPath) return leftPath < rightPath ? -1 : 1;
    // Same directory matched by two rules: keep catalog order stable so the
    // surviving rule is deterministic across runs and platforms.
    return 0;
  });

  const accepted: RawMatch[] = [];
  let currentAncestor: string | null = null;

  for (const match of sorted) {
    const candidate = normalizeForCompare(match.path);

    // I. Same directory as the accepted ancestor: a duplicate rule hit.
    if (currentAncestor !== null && candidate === currentAncestor) continue;

    // II. Strictly inside the accepted ancestor: a double count, drop it.
    if (currentAncestor !== null && candidate.startsWith(`${currentAncestor}/`)) continue;

    // III. Otherwise this match is the new outermost accepted directory. A
    //      later sibling cannot be inside it, so replacing the ancestor is safe:
    //      sorted order guarantees no pending path is contained by the old one.
    accepted.push(match);
    currentAncestor = candidate;
  }

  return accepted;
}

/**
 * Escalate a rule's risk when the measured target is unusually large.
 *
 * I. Rationale
 *
 * 1. Deleting a 40 MB `dist` is routine; deleting a 40 GB `dist` on a full disk
 *    is a decision the user should make deliberately. The rule author cannot
 *    know the size, so the planner applies the escalation with the measurement
 *    in hand.
 *
 * @param baseRisk - The rule's declared risk.
 * @param bytes - Measured size in bytes.
 * @param highRiskBytes - Threshold above which risk escalates to `high`.
 * @returns The effective risk; never lower than the base risk.
 */
export function escalateRisk(baseRisk: RiskLevel, bytes: number, highRiskBytes: number): RiskLevel {
  const order: readonly RiskLevel[] = ['safe', 'low', 'medium', 'high'];
  const baseIndex = order.indexOf(baseRisk);
  const escalated: RiskLevel =
    bytes >= highRiskBytes ? 'high' : bytes >= highRiskBytes / 4 ? 'medium' : baseRisk;
  return order[Math.max(baseIndex, order.indexOf(escalated))] as RiskLevel;
}

/**
 * Order layers for display, cheapest-to-lose first.
 *
 * The TUI and the Markdown report both render layers in this order so the
 * "what should I delete first" question has a consistent answer.
 */
export const LAYER_ORDER: readonly TargetLayer[] = ['cache', 'build', 'dependencies', 'artifacts'];
