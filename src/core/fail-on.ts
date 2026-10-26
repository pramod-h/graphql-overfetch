import { AnalysisResult } from '../types';

/**
 * `--fail-on` checks: each maps to a count of findings in the analysis. Any
 * selected check with a non-zero count makes the CLI exit with code 1.
 */
export const FAIL_ON_CHECKS = {
  overfetch: (a: AnalysisResult) => a.overfetch.length,
  'unrequested-reads': (a: AnalysisResult) => a.unrequestedReads.length,
  'dead-queries': (a: AnalysisResult) => a.deadQueries.length,
  'dead-fragments': (a: AnalysisResult) => a.deadFragments.length,
  duplicates: (a: AnalysisResult) => a.duplicateQueries.length + a.duplicateFragments.length,
  'unused-variables': (a: AnalysisResult) =>
    a.operations.filter((o) => o.unusedVariables.length).length,
  // Only high-risk operations; medium is too common to gate on.
  complexity: (a: AnalysisResult) => a.complexity.filter((r) => r.risk === 'high').length,
  'schema-drift': (a: AnalysisResult) => a.schemaDrift.length,
  'unused-types': (a: AnalysisResult) => a.generatedTypes?.unused.length ?? 0,
};

export type FailOnCheck = keyof typeof FAIL_ON_CHECKS;

export interface FailOnResult {
  check: FailOnCheck;
  count: number;
}

/** Parse `overfetch,dead-queries` into checks; throws on unknown names. */
export function parseFailOn(value: string | undefined): FailOnCheck[] {
  if (value === undefined) return [];
  const names = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = Object.keys(FAIL_ON_CHECKS);
  const unknown = names.filter((n) => !valid.includes(n));
  if (unknown.length || !names.length) {
    throw new Error(
      `--fail-on: unknown check "${unknown.join('", "') || value}". Valid checks: ${valid.join(', ')}`
    );
  }
  return [...new Set(names)] as FailOnCheck[];
}

/**
 * Count findings for each selected check. Throws when a check can't run,
 * so CI never passes silently because a schema or codegen output was missing.
 */
export function evaluateFailOn(a: AnalysisResult, checks: FailOnCheck[]): FailOnResult[] {
  if (checks.includes('schema-drift') && !a.schemaLoaded) {
    throw new Error('--fail-on schema-drift needs a schema: pass --schema <path>');
  }
  if (checks.includes('unused-types') && !a.generatedTypes?.found) {
    throw new Error(
      '--fail-on unused-types found no GraphQL Code Generator output ' +
        '(point the types command at it with --generated <globs...>)'
    );
  }
  return checks.map((check) => ({ check, count: FAIL_ON_CHECKS[check](a) }));
}
