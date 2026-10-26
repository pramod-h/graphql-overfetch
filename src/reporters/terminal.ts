import path from 'path';
import { AnalysisResult, OverfetchFinding } from '../types';
import { c, heading, line, kv } from '../utils/logger';

function rel(root: string, file: string): string {
  const r = path.relative(root, file);
  return r.startsWith('..') ? file : r;
}

const confColor: Record<string, (s: string) => string> = {
  high: (s) => c.red(s),
  medium: (s) => c.yellow(s),
  low: (s) => c.dim(s),
};

export function printSummary(a: AnalysisResult): void {
  heading('graphql-overfetch');
  kv('Operations', a.operations.length);
  kv('Fragments', a.fragments.length);
  kv('Components', a.stats.components);
  kv('Source files', a.stats.sourceFiles);
  line();
  line(c.bold('Issues'));
  const issue = (label: string, n: number) =>
    kv('  ' + label, n === 0 ? c.green('0') : c.yellow(String(n)));
  issue('Dead queries', a.deadQueries.length);
  issue('Dead fragments', a.deadFragments.length);
  issue('Duplicate queries', a.duplicateQueries.length);
  issue('Duplicate fragments', a.duplicateFragments.length);
  issue('Overfetching queries', a.overfetch.length);
  if (a.schemaLoaded) issue('Schema drift', a.schemaDrift.length);
  else kv('  Schema drift', c.dim('n/a (pass --schema to enable)'));

  const complexTop = a.complexity[0];
  if (complexTop) {
    line();
    kv('Largest query', `${complexTop.operation} ${c.dim(`(depth ${complexTop.depth})`)}`);
  }
  const savings = aggregateSavings(a.overfetch);
  if (a.overfetch.length) {
    kv('Est. payload savings', c.bold(`${savings}%`) + c.dim(' across overfetching queries'));
  }
}

function aggregateSavings(findings: OverfetchFinding[]): number {
  if (!findings.length) return 0;
  let req = 0;
  let unused = 0;
  for (const f of findings) {
    req += f.requestedCount;
    unused += f.requestedCount - f.usedCount;
  }
  return req ? Math.round((unused / req) * 100) : 0;
}

export function printOverfetch(a: AnalysisResult): void {
  heading('Overfetching  ·  requested but never read in components');
  if (!a.overfetch.length) {
    line(c.green('  None detected among analyzable queries.'));
    return;
  }
  for (const f of a.overfetch) {
    line(
      `\n${c.bold(f.operation)}  ${c.dim(rel(a.project.root, f.file) + ':' + f.line)}`
    );
    line(
      `  requested ${c.bold(String(f.requestedCount))} · used ${c.bold(
        String(f.usedCount)
      )} · ${c.red('~' + f.estimatedReductionPct + '% payload reduction')}`
    );
    for (const u of f.unused.slice(0, 20)) {
      const tag = confColor[u.confidence](`[${u.confidence}]`);
      line(`    ${c.red('-')} ${u.path} ${tag}`);
    }
    if (f.unused.length > 20) line(c.dim(`    …and ${f.unused.length - 20} more`));
  }
  line(
    c.dim(
      '\n  Confidence: high = entire field never referenced; medium = sibling fields used but this one not.'
    )
  );
}

export function printDeadQueries(a: AnalysisResult): void {
  heading(`Dead queries  ·  ${a.deadQueries.length}`);
  if (!a.deadQueries.length) return line(c.green('  None.'));
  for (const op of a.deadQueries) {
    line(
      `  ${c.red('✗')} ${op.name ?? op.varName ?? '(anonymous)'} ${c.dim(
        '(' + op.operation + ') ' + rel(a.project.root, op.loc.file) + ':' + op.loc.line
      )}`
    );
  }
}

export function printDeadFragments(a: AnalysisResult): void {
  heading(`Dead fragments  ·  ${a.deadFragments.length}`);
  if (!a.deadFragments.length) return line(c.green('  None.'));
  for (const f of a.deadFragments) {
    line(
      `  ${c.red('✗')} ${f.name} ${c.dim(
        'on ' + f.typeCondition + ' ' + rel(a.project.root, f.loc.file) + ':' + f.loc.line
      )}`
    );
  }
}

export function printDuplicates(a: AnalysisResult): void {
  heading('Duplicate documents');
  const show = (label: string, groups: AnalysisResult['duplicateQueries']) => {
    line(c.bold(`\n  ${label}: ${groups.length}`));
    for (const g of groups) {
      const sim = g.similarity === 1 ? 'identical' : `${Math.round(g.similarity * 100)}% identical`;
      line(`    ${c.yellow(sim)}`);
      for (const m of g.members) {
        line(`      · ${m.name} ${c.dim(rel(a.project.root, m.file) + ':' + m.line)}`);
      }
    }
    if (!groups.length) line(c.green('    None.'));
  };
  show('Queries', a.duplicateQueries);
  show('Fragments', a.duplicateFragments);
}

export function printComplexity(a: AnalysisResult): void {
  heading('Query complexity  ·  top 15 by depth');
  for (const r of a.complexity.slice(0, 15)) {
    const risk =
      r.risk === 'high' ? c.red('high') : r.risk === 'medium' ? c.yellow('medium') : c.dim('low');
    line(
      `  ${risk.padEnd(16)} depth ${String(r.depth).padStart(2)} · ${String(
        r.fieldCount
      ).padStart(3)} fields · ${r.operation} ${c.dim(rel(a.project.root, r.file) + ':' + r.line)}`
    );
  }
}

export function printSchemaDrift(a: AnalysisResult): void {
  heading(`Schema drift  ·  ${a.schemaLoaded ? a.schemaDrift.length : 'n/a'}`);
  if (!a.schemaLoaded) return line(c.dim('  No schema found — pass --schema <path> to enable.'));
  if (!a.schemaDrift.length) return line(c.green('  None — all requested fields exist in the schema.'));
  for (const d of a.schemaDrift) {
    line(`  ${c.red('✗')} ${d.operation} ${c.dim(rel(a.project.root, d.file) + ':' + d.line)}`);
    line(`      ${d.message}`);
  }
}

export function printGeneratedTypes(a: AnalysisResult): void {
  heading('Generated type usage');
  const g = a.generatedTypes;
  if (!g || !g.found) {
    line(
      c.dim(
        '  No GraphQL Code Generator output found.\n' +
          '  Point at it with --generated "<glob>" (e.g. --generated "src/**/*.generated.ts").'
      )
    );
    return;
  }
  kv('  Generated files', g.generatedFiles);
  kv('  Generated types', g.total);
  kv('  Used', `${c.green(String(g.used))} ${c.dim(`(${g.usagePct}%)`)}`);
  kv('  Unused', g.unused.length ? c.yellow(String(g.unused.length)) : c.green('0'));
  if (g.unused.length) {
    line(c.dim('\n  Unused generated types:'));
    for (const t of g.unused.slice(0, 40)) {
      line(`    ${c.yellow('-')} ${t.name} ${c.dim(rel(a.project.root, t.file) + ':' + t.line)}`);
    }
    if (g.unused.length > 40) line(c.dim(`    …and ${g.unused.length - 40} more`));
    line(
      c.dim(
        '\n  "Used" = reachable from app-code references (incl. via query types /\n' +
          '  Document consts). Confirm before deleting — re-exports may hide usage.'
      )
    );
  }
}

export function printUnusedVariables(a: AnalysisResult): void {
  const withUnused = a.operations.filter((o) => o.unusedVariables.length);
  if (!withUnused.length) return;
  heading('Unused variables  ·  declared but never referenced');
  for (const op of withUnused) {
    line(
      `  ${c.yellow('!')} ${op.name ?? op.varName} — $${op.unusedVariables.join(', $')} ${c.dim(
        rel(a.project.root, op.loc.file) + ':' + op.loc.line
      )}`
    );
  }
}

export function printFull(a: AnalysisResult, details: boolean): void {
  printSummary(a);
  if (details) {
    printOverfetch(a);
    printDeadQueries(a);
    printDeadFragments(a);
    printDuplicates(a);
    printComplexity(a);
    printSchemaDrift(a);
    printUnusedVariables(a);
    if (a.generatedTypes) printGeneratedTypes(a);
  } else {
    line(c.dim('\nRun with --details, or a subcommand (overfetch, unused, complexity, …) for specifics.'));
  }
}
