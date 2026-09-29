/**
 * Rule Engine Behaviour
 *
 * Pins glob compilation, nested-match deduplication and risk escalation — the
 * three pieces of `src/rules/engine.ts` that decide *what* the product is
 * willing to delete and *how much* it claims to free.
 *
 * I. Why the glob dialect is tested by counterexample
 *
 * 1. Every pattern in the built-in catalog is compared against absolute paths,
 *    so a translation that is merely "close" is a deletion-scope bug: a `*` that
 *    crosses a separator widens `**\/build` into a rule that matches an entire
 *    subtree, and an unanchored pattern turns one directory name into thousands
 *    of matches.
 * 2. Deduplication is the double-counting guard. If it fails, the reclaimable
 *    total is inflated by every nested `node_modules` *and* the plan names a
 *    directory that is about to disappear with its parent.
 *
 * @module tests/engine
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { RiskLevel } from '../src/core/types.js';
import { BUILTIN_RULE_COUNT, BUILTIN_RULES, indexRules } from '../src/rules/builtin.js';
import {
  compileGlob,
  compileRules,
  dedupeNestedMatches,
  escalateRisk,
  isWhitelisted,
  LAYER_ORDER,
  type RawMatch,
} from '../src/rules/engine.js';

describe('compileGlob', () => {
  it('matches a double-star prefix at the filesystem root and below it', () => {
    const matcher = compileGlob('**/node_modules');
    expect(matcher.regex.test('/node_modules')).toBe(true);
    expect(matcher.regex.test('/a/b/node_modules')).toBe(true);
    expect(matcher.regex.test('/Users/dev/proj/node_modules')).toBe(true);
  });

  it('does not match a directory whose name merely starts with the pattern tail', () => {
    const matcher = compileGlob('**/node_modules');
    expect(matcher.regex.test('/a/node_modulesextra')).toBe(false);
    expect(matcher.regex.test('/a/xnode_modules')).toBe(false);
  });

  it('anchors the pattern so a substring elsewhere in the path does not match', () => {
    const matcher = compileGlob('/a/build');
    expect(matcher.regex.test('/a/build')).toBe(true);
    expect(matcher.regex.test('/x/a/build')).toBe(false);
    expect(matcher.regex.test('/a/build/sub')).toBe(false);
    expect(matcher.regex.test('/pre/a/build')).toBe(false);
  });

  it('does not let a single star cross a separator', () => {
    const matcher = compileGlob('/a/*/build');
    expect(matcher.regex.test('/a/b/build')).toBe(true);
    expect(matcher.regex.test('/a/b/c/build')).toBe(false);
  });

  it('treats a question mark as exactly one non-separator character', () => {
    const matcher = compileGlob('/a/?');
    expect(matcher.regex.test('/a/b')).toBe(true);
    expect(matcher.regex.test('/a/bc')).toBe(false);
    expect(matcher.regex.test('/a/')).toBe(false);
  });

  it('expands a brace group as alternation', () => {
    const matcher = compileGlob('/a/{dist,build}');
    expect(matcher.regex.test('/a/dist')).toBe(true);
    expect(matcher.regex.test('/a/build')).toBe(true);
    expect(matcher.regex.test('/a/out')).toBe(false);
    expect(matcher.regex.test('/a/distbuild')).toBe(false);
  });

  it('escapes regex metacharacters inside a brace alternative', () => {
    // `x.y` must not match `xzy`: an unescaped dot inside the alternation would
    // silently widen the rule.
    const matcher = compileGlob('/a/{x.y,z}');
    expect(matcher.regex.test('/a/x.y')).toBe(true);
    expect(matcher.regex.test('/a/xzy')).toBe(false);
  });

  it('supports a character class and its negation', () => {
    const single = compileGlob('/a/[abc]');
    expect(single.regex.test('/a/a')).toBe(true);
    expect(single.regex.test('/a/c')).toBe(true);
    expect(single.regex.test('/a/d')).toBe(false);
    expect(single.regex.test('/a/ab')).toBe(false);

    const negated = compileGlob('/a/[!abc]');
    expect(negated.regex.test('/a/d')).toBe(true);
    expect(negated.regex.test('/a/a')).toBe(false);
  });

  it('escapes a dot that appears in a literal segment', () => {
    const matcher = compileGlob('**/.next/cache');
    expect(matcher.regex.test('/proj/.next/cache')).toBe(true);
    // An unescaped `.` would make `xnext` match as well.
    expect(matcher.regex.test('/proj/xnext/cache')).toBe(false);
  });

  it('lets a trailing double star cover the directory itself and everything below', () => {
    const matcher = compileGlob('/a/**');
    expect(matcher.regex.test('/a/')).toBe(true);
    expect(matcher.regex.test('/a/b')).toBe(true);
    expect(matcher.regex.test('/a/b/c/d')).toBe(true);
    expect(matcher.regex.test('/b/c')).toBe(false);
  });

  it('degrades a double star that is not followed by a separator to a single segment', () => {
    const matcher = compileGlob('/a/**b');
    expect(matcher.regex.test('/a/xb')).toBe(true);
    expect(matcher.regex.test('/a/b')).toBe(true);
    // The degraded wildcard cannot cross a separator, so a nested match is out.
    expect(matcher.regex.test('/a/x/yb')).toBe(false);
  });

  it('treats an unbalanced brace or bracket as a literal character', () => {
    const brace = compileGlob('/a/{');
    expect(brace.regex.test('/a/{')).toBe(true);
    expect(brace.regex.test('/a/x')).toBe(false);

    const bracket = compileGlob('/a/[');
    expect(bracket.regex.test('/a/[')).toBe(true);
    expect(bracket.regex.test('/a/x')).toBe(false);
  });

  it('accepts a Windows-style separator in the pattern', () => {
    const matcher = compileGlob('**\\node_modules');
    expect(matcher.regex.test('/a/b/node_modules')).toBe(true);
    expect(matcher.source).toBe('**\\node_modules');
  });

  it('extracts a trailing literal only when the pattern ends in a literal', () => {
    expect(compileGlob('**/node_modules').trailingLiteral).toBe('node_modules');
    expect(compileGlob('/a/*').trailingLiteral).toBeNull();
    expect(compileGlob('/a/?').trailingLiteral).toBeNull();
    expect(compileGlob('/a/[abc]').trailingLiteral).toBeNull();
    expect(compileGlob('/a/{dist,build}').trailingLiteral).toBeNull();
  });

  it('compiles every built-in pattern into an anchored regular expression', () => {
    for (const rule of BUILTIN_RULES) {
      for (const pattern of rule.patterns) {
        const matcher = compileGlob(pattern);
        expect(matcher.regex.source.startsWith('^')).toBe(true);
        expect(matcher.regex.source.endsWith('$')).toBe(true);
      }
    }
  });
});

describe('compileRules', () => {
  it('compiles the whole catalog when there are no overrides', () => {
    const compiled = compileRules(BUILTIN_RULES, {});
    expect(compiled).toHaveLength(BUILTIN_RULE_COUNT);
    expect(new Set(compiled.map((entry) => entry.rule.id)).size).toBe(BUILTIN_RULE_COUNT);
  });

  it('drops a rule the user disabled', () => {
    const compiled = compileRules(BUILTIN_RULES, { 'node-modules': { enabled: false } });
    expect(compiled.map((entry) => entry.rule.id)).not.toContain('node-modules');
    expect(compiled).toHaveLength(BUILTIN_RULE_COUNT - 1);
  });

  it('never invents a rule from an override for an unknown id', () => {
    // A typo in a rule id must not be able to create a deletion rule.
    const compiled = compileRules(BUILTIN_RULES, { 'no-such-rule': { enabled: true } });
    expect(compiled).toHaveLength(BUILTIN_RULE_COUNT);
  });

  it('applies field-level overrides without touching the other fields', () => {
    const compiled = compileRules(BUILTIN_RULES, {
      'node-modules': { risk: 'high', olderThanDays: 14, minEntries: 9, reportOnly: true },
    });
    const rule = compiled.find((entry) => entry.rule.id === 'node-modules')?.rule;
    expect(rule?.risk).toBe('high');
    expect(rule?.olderThanDays).toBe(14);
    expect(rule?.minEntries).toBe(9);
    expect(rule?.reportOnly).toBe(true);
    // Untouched fields keep the catalog value.
    expect(rule?.patterns).toEqual(['**/node_modules']);
    expect(rule?.layer).toBe('dependencies');
  });

  it('appends extra patterns instead of replacing the built-in ones', () => {
    const compiled = compileRules(BUILTIN_RULES, {
      'node-modules': { extraPatterns: ['**/node_modules.bak'] },
    });
    const entry = compiled.find((candidate) => candidate.rule.id === 'node-modules');
    expect(entry?.rule.patterns).toEqual(['**/node_modules', '**/node_modules.bak']);
    expect(entry?.matchers).toHaveLength(2);
    expect(entry?.matchers[1]?.regex.test('/a/node_modules.bak')).toBe(true);
  });

  it('keeps the catalog order of the surviving rules', () => {
    const compiled = compileRules(BUILTIN_RULES, { 'node-modules': { enabled: false } });
    const expected = BUILTIN_RULES.filter((rule) => rule.id !== 'node-modules').map((rule) => rule.id);
    expect(compiled.map((entry) => entry.rule.id)).toEqual(expected);
  });
});

/** Build a raw match for the dedupe tests. */
function rawMatch(path: string, ruleId = 'node-modules'): RawMatch {
  const rule = indexRules().get(ruleId);
  if (rule === undefined) throw new Error(`unknown rule id in test fixture: ${ruleId}`);
  return {
    rule,
    path,
    project: null,
    ecosystems: ['node'],
    withinProjectRoot: true,
    lockedReason: null,
  };
}

describe('dedupeNestedMatches', () => {
  it('drops a node_modules nested inside another node_modules', () => {
    const outer = rawMatch('/proj/node_modules');
    const inner = rawMatch('/proj/node_modules/pkg/node_modules');
    const result = dedupeNestedMatches([outer, inner]);
    expect(result.map((match) => match.path)).toEqual(['/proj/node_modules']);
  });

  it('keeps an arbitrarily deep nesting chain collapsed to its outermost match', () => {
    const result = dedupeNestedMatches([
      rawMatch('/p/a/node_modules/b/node_modules/c/node_modules'),
      rawMatch('/p/a/node_modules'),
      rawMatch('/p/a/node_modules/b/node_modules'),
    ]);
    expect(result.map((match) => match.path)).toEqual(['/p/a/node_modules']);
  });

  it('keeps sibling matches that are not nested in each other', () => {
    const paths = ['/p/a/node_modules', '/p/b/node_modules', '/p/a/dist', '/p/dist'];
    const result = dedupeNestedMatches(paths.map((path) => rawMatch(path)));
    expect(result.map((match) => match.path).sort()).toEqual([...paths].sort());
  });

  it('does not treat a shared name prefix as containment', () => {
    const result = dedupeNestedMatches([rawMatch('/p/node_modules'), rawMatch('/p/node_modules-backup')]);
    expect(result).toHaveLength(2);
  });

  it('collapses the same directory matched by two rules to one survivor', () => {
    const first = rawMatch('/p/proj/build', 'node-build-output');
    const second = rawMatch('/p/proj/build', 'java-gradle-build');
    const result = dedupeNestedMatches([first, second]);
    expect(result).toHaveLength(1);
    // The survivor is the first entry in the input, which for the engine is the
    // first rule in catalog order; the sort is stable, so this is repeatable.
    expect(result[0]?.rule.id).toBe('node-build-output');
    expect(dedupeNestedMatches([first, second])[0]?.rule.id).toBe('node-build-output');
  });

  it('returns matches sorted by normalized path with a parent before its descendants', () => {
    const result = dedupeNestedMatches([
      rawMatch('/z/node_modules'),
      rawMatch('/a/b/node_modules'),
      rawMatch('/a/node_modules'),
    ]);
    // Lexicographic order, so the '/a/b' branch precedes '/a/node_modules'
    // ('b' < 'n'); what matters is that '/a/node_modules' still precedes every
    // path nested inside it, which is what makes the single forward sweep sound.
    expect(result.map((match) => match.path)).toEqual([
      '/a/b/node_modules',
      '/a/node_modules',
      '/z/node_modules',
    ]);
  });

  it('returns an empty list for an empty input', () => {
    expect(dedupeNestedMatches([])).toEqual([]);
  });

  it('preserves the raw match payload of every survivor', () => {
    const match = rawMatch('/p/node_modules');
    const [survivor] = dedupeNestedMatches([match]);
    expect(survivor).toBe(match);
  });
});

describe('escalateRisk', () => {
  const THRESHOLD = 1000;

  it('escalates to high at or above the configured threshold', () => {
    expect(escalateRisk('safe', 1000, THRESHOLD)).toBe('high');
    expect(escalateRisk('low', 1001, THRESHOLD)).toBe('high');
  });

  it('escalates to medium at or above a quarter of the threshold', () => {
    expect(escalateRisk('safe', 250, THRESHOLD)).toBe('medium');
    expect(escalateRisk('safe', 999, THRESHOLD)).toBe('medium');
  });

  it('leaves the base risk alone just below a quarter of the threshold', () => {
    expect(escalateRisk('safe', 249, THRESHOLD)).toBe('safe');
    expect(escalateRisk('low', 0, THRESHOLD)).toBe('low');
  });

  it('never lowers a base risk that already exceeds the escalation', () => {
    expect(escalateRisk('high', 0, THRESHOLD)).toBe('high');
    expect(escalateRisk('high', 250, THRESHOLD)).toBe('high');
    expect(escalateRisk('medium', 250, THRESHOLD)).toBe('medium');
    expect(escalateRisk('low', 250, THRESHOLD)).toBe('medium');
  });

  it('treats a zero threshold as always escalating to high', () => {
    expect(escalateRisk('safe', 0, 0)).toBe('high');
  });

  it('never returns a level below the base for every combination', () => {
    const order: readonly RiskLevel[] = ['safe', 'low', 'medium', 'high'];
    for (const base of order) {
      for (const bytes of [0, 249, 250, 999, 1000, 1_000_000]) {
        const effective = escalateRisk(base, bytes, THRESHOLD);
        expect(order.indexOf(effective)).toBeGreaterThanOrEqual(order.indexOf(base));
      }
    }
  });
});

describe('isWhitelisted', () => {
  it('returns false when nothing is whitelisted', () => {
    expect(isWhitelisted('/a/b', [])).toBe(false);
  });

  it('matches the exact path and any descendant of it', () => {
    expect(isWhitelisted('/a/b', ['/a/b'])).toBe(true);
    expect(isWhitelisted('/a/b/c/d', ['/a/b'])).toBe(true);
  });

  it('matches on a component boundary only', () => {
    expect(isWhitelisted('/a/bc', ['/a/b'])).toBe(false);
    expect(isWhitelisted('/a/b-other', ['/a/b'])).toBe(false);
  });

  it('normalizes a trailing separator on the whitelist entry', () => {
    expect(isWhitelisted('/a/b', ['/a/b/'])).toBe(true);
  });

  it('normalizes separator style so a Windows-style entry matches a POSIX path', () => {
    expect(isWhitelisted('/a/b/c', ['\\a\\b'])).toBe(true);
  });

  it('expands a leading tilde against the real home directory', () => {
    const home = homedir();
    expect(isWhitelisted(join(home, 'work', 'node_modules'), ['~/work'])).toBe(true);
    expect(isWhitelisted(join(home, 'workshop'), ['~/work'])).toBe(false);
  });

  it('leaves a tilde that is not a leading segment literal', () => {
    expect(isWhitelisted('/a/~/b', ['/a/~/b'])).toBe(true);
  });
});

describe('LAYER_ORDER', () => {
  it('orders layers cheapest-to-lose first', () => {
    expect(LAYER_ORDER).toEqual(['cache', 'build', 'dependencies', 'artifacts']);
  });
});
