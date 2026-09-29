/**
 * Deterministic Identifier Generation
 *
 * Produces stable ids for targets and scans so a report can be diffed, and a
 * TUI selection can be restored, across separate runs.
 *
 * I. Why not a UUID
 *
 * 1. Ids travel in the JSON report. A random id would make every run's report
 *    incomparable and would break the growth diff, which is a headline feature.
 * 2. Deriving the id from the rule plus the canonical path means the same
 *    directory keeps the same id on the same machine, which is what lets a
 *    saved selection be re-applied after a rescan.
 *
 * II. Why not the bare path
 *
 * 1. The path is already a field on the target. The id additionally encodes the
 *    rule, so two rules matching the same directory stay distinguishable in
 *    logs and in the execution result list.
 *
 * @module core/ids
 * @author zexuan.peng <pengzexuan2001@gmail.com>
 * @created 2026-09-29
 */

import { createHash } from 'node:crypto';

/**
 * Hash a string to a short, stable hex digest.
 *
 * I. Algorithm
 *
 * 1. SHA-256 truncated to 16 hex characters (64 bits). Collision probability is
 *    negligible at the scale of a single machine's directory count, and 16
 *    characters keeps report ids readable in a terminal.
 * 2. Truncation is of the hex string, not of the output buffer, so the result is
 *    stable regardless of endianness.
 *
 * @param input - Arbitrary string.
 * @returns A 16-character lowercase hex digest.
 */
export function shortHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Build the stable id for a cleanup target.
 *
 * @param ruleId - Id of the rule that produced the target.
 * @param targetPath - Absolute path of the target directory.
 * @returns The target id, of the form `<ruleId>#<hash>`.
 */
export function targetId(ruleId: string, targetPath: string): string {
  return `${ruleId}#${shortHash(targetPath)}`;
}

/**
 * Build the stable id for a scan.
 *
 * @param root - Absolute scan root.
 * @param scannedAt - ISO-8601 timestamp of the scan.
 * @returns A short identifier suitable for a report filename.
 */
export function scanId(root: string, scannedAt: string): string {
  return shortHash(`${root}|${scannedAt}`);
}
