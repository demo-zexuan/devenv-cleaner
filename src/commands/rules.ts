/**
 * Rules Inspection Command
 *
 * Read-only views over the built-in rule catalogue and the overrides in effect.
 *
 * I. Why users need this
 *
 * 1. A rule engine is only trustworthy if its decisions are inspectable. A user
 *    who cannot see *why* a directory was not offered for cleanup will assume
 *    the tool is broken rather than that a guard fired.
 * 2. It is also the discovery surface: it states the exact rule id to use as a
 *    key in `dvc.config.json`, which is otherwise guesswork.
 *
 * @module commands/rules
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import pc from 'picocolors';
import { renderTable } from '../cli/output.js';
import { formatBytes, type ResolvedConfig } from '../core/index.js';
import { BUILTIN_RULES, indexRules } from '../rules/builtin.js';
import { type CompiledRule, compileRules, LAYER_ORDER } from '../rules/engine.js';

/** Options for {@link runRulesList}. */
export interface RulesCommandOptions {
  /** Resolved configuration, whose overrides shape the effective rule set. */
  readonly config: ResolvedConfig;
  /** Emit JSON. */
  readonly json: boolean;
  /** Suppress colour. */
  readonly noColor: boolean;
  /** Show only rules feeding this layer. */
  readonly layer?: string | undefined;
}

/**
 * List the rule catalogue with the overrides that are in effect.
 *
 * I. Presentation
 *
 * 1. Rules are grouped by layer in `LAYER_ORDER`, because that is the order a
 *    user reasons in when deciding what is cheap to lose.
 * 2. Disabled rules are still listed, struck through in the status column. A
 *    rule the user disabled is a fact about the configuration, and hiding it
 *    would make the config file's effect invisible.
 *
 * @param options - Command options.
 * @returns The effective rule set, so a caller can assert on it.
 */
export function runRulesList(options: RulesCommandOptions): CompiledRule[] {
  const compiled = compileRules(BUILTIN_RULES, options.config.rules);
  const activeIds = new Set(compiled.map((entry) => entry.rule.id));

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          total: BUILTIN_RULES.length,
          active: compiled.length,
          rules: BUILTIN_RULES.map((rule) => {
            const override = options.config.rules[rule.id];
            return {
              id: rule.id,
              label: rule.label,
              description: rule.description,
              layer: rule.layer,
              kind: rule.kind,
              scope: rule.scope,
              risk: override?.risk ?? rule.risk,
              patterns: override?.extraPatterns
                ? [...rule.patterns, ...override.extraPatterns]
                : rule.patterns,
              reportOnly: override?.reportOnly ?? rule.reportOnly,
              enabled: activeIds.has(rule.id),
              note: rule.note,
            };
          }),
        },
        null,
        2,
      )}\n`,
    );
    return compiled;
  }

  const dim = options.noColor ? (value: string): string => value : pc.dim;
  const bold = options.noColor ? (value: string): string => value : pc.bold;
  const yellow = options.noColor ? (value: string): string => value : pc.yellow;

  const wanted = options.layer ? BUILTIN_RULES.filter((rule) => rule.layer === options.layer) : BUILTIN_RULES;
  const out = process.stdout;

  for (const layer of LAYER_ORDER) {
    const inLayer = wanted.filter((rule) => rule.layer === layer);
    if (inLayer.length === 0) continue;

    out.write(`\n${bold(layer)}\n`);
    out.write(
      `${renderTable(
        ['rule id', 'label', 'risk', 'status', 'patterns'],
        inLayer.map((rule) => {
          const override = options.config.rules[rule.id];
          const enabled = activeIds.has(rule.id);
          const reportOnly = override?.reportOnly ?? rule.reportOnly;
          const status = !enabled ? 'disabled' : reportOnly ? 'report only' : 'active';
          return [
            rule.id,
            rule.label,
            override?.risk ?? rule.risk,
            status,
            rule.patterns.slice(0, 2).join(' '),
          ];
        }),
        ['left', 'left', 'left', 'left', 'left'],
      )}\n`,
    );
  }

  out.write(
    `\n${dim(`${compiled.length} of ${BUILTIN_RULES.length} rules active`)}` +
      `${options.layer ? dim(` · filtered to layer "${options.layer}"`) : ''}\n`,
  );
  out.write(`${dim('override any rule under "rules" in dvc.config.json, keyed by the rule id column')}\n`);
  if (compiled.length < BUILTIN_RULES.length) {
    out.write(`${yellow('note')} disabled rules produce no targets and are excluded from every total\n`);
  }
  return compiled;
}

/**
 * Explain one rule in full.
 *
 * @param ruleId - Rule id to explain.
 * @param options - Command options.
 * @returns True when the rule exists.
 */
export function runRulesExplain(ruleId: string, options: RulesCommandOptions): boolean {
  const rule = indexRules().get(ruleId);
  const out = process.stdout;
  const bold = options.noColor ? (value: string): string => value : pc.bold;
  const dim = options.noColor ? (value: string): string => value : pc.dim;

  if (!rule) {
    const close = BUILTIN_RULES.filter((candidate) => candidate.id.includes(ruleId)).map(
      (candidate) => candidate.id,
    );
    out.write(`unknown rule: ${ruleId}\n`);
    if (close.length > 0) out.write(`did you mean: ${close.join(', ')}\n`);
    out.write(`run "dvc rules list" to see every rule id\n`);
    return false;
  }

  const override = options.config.rules[ruleId];
  out.write(`\n${bold(rule.label)} ${dim(`(${rule.id})`)}\n\n`);
  out.write(`${rule.description}\n\n`);
  out.write(`  layer        ${rule.layer}\n`);
  out.write(`  kind         ${rule.kind}\n`);
  out.write(`  scope        ${rule.scope}\n`);
  out.write(`  risk         ${override?.risk ?? rule.risk}${override?.risk ? ' (overridden)' : ''}\n`);
  out.write(`  report only  ${(override?.reportOnly ?? rule.reportOnly) ? 'yes' : 'no'}\n`);
  if (rule.withinEcosystem) out.write(`  ecosystem    ${rule.withinEcosystem.join(', ')}\n`);
  if (rule.minEntries !== null) out.write(`  min entries  ${rule.minEntries}\n`);
  if (rule.olderThanDays !== null) out.write(`  older than   ${rule.olderThanDays} days\n`);
  if (rule.note) out.write(`  note         ${rule.note}\n`);
  out.write(`\n  patterns\n`);
  for (const pattern of rule.patterns) out.write(`    ${pattern}\n`);
  if (override?.extraPatterns) {
    for (const pattern of override.extraPatterns) out.write(`    ${pattern}   ${dim('(from config)')}\n`);
  }
  out.write(`\n  config override\n`);
  out.write(`    "rules": { "${ruleId}": { "enabled": true, "risk": "${rule.risk}" } }\n\n`);
  return true;
}

/** Effective minimum byte floor for a rule, surfaced for `dvc rules explain`. */
export function ruleSizeFloor(ruleId: string, config: ResolvedConfig): number {
  return Math.max(config.minSizeBytes, config.rules[ruleId]?.minSizeBytes ?? 0);
}

/** Human string for a rule's effective floor, used in the explain output. */
export function formatRuleFloor(ruleId: string, config: ResolvedConfig): string {
  return formatBytes(ruleSizeFloor(ruleId, config));
}
