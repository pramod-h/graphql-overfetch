import path from 'path';
import { scan } from '../core/scan';
import { evaluateFailOn, FailOnCheck, parseFailOn } from '../core/fail-on';
import { toJson } from '../reporters/json';
import * as term from '../reporters/terminal';
import { c, line, setQuiet, heading } from '../utils/logger';
import { AnalysisResult, ScanOptions } from '../types';
import { analyzeImpact } from '../analyzers/impact';

export interface CommonOpts {
  json?: boolean;
  schema?: string;
  ignore?: string[];
  generated?: string[];
  failOn?: string;
}

function optionsFrom(pathArg: string | undefined, opts: CommonOpts): ScanOptions {
  return {
    cwd: path.resolve(pathArg ?? process.cwd()),
    schema: opts.schema ?? null,
    ignore: opts.ignore,
    generated: opts.generated,
  };
}

function run(pathArg: string | undefined, opts: CommonOpts, analyzeTypes = false) {
  // Parse --fail-on before scanning so a typo fails fast, not after a long scan.
  const failOn = parseFailOn(opts.failOn);
  setQuiet(!!opts.json);
  const result = scan({
    ...optionsFrom(pathArg, opts),
    analyzeTypes: analyzeTypes || failOn.includes('unused-types'),
  });
  return { ...result, failOn };
}

/** Apply --fail-on after output: exit code 1 if any selected check has findings. */
function gate(analysis: AnalysisResult, checks: FailOnCheck[], json: boolean): void {
  if (!checks.length) return;
  const failed = evaluateFailOn(analysis, checks).filter((r) => r.count > 0);
  if (!failed.length) {
    if (!json) line(c.green(`\n✔ --fail-on passed (${checks.join(', ')})`));
    return;
  }
  // stderr, so --json output on stdout stays parseable.
  console.error(
    c.red(`\n✖ --fail-on: ${failed.map((r) => `${r.check} (${r.count})`).join(', ')}`)
  );
  process.exitCode = 1;
}

function maybeParseNote(count: number, json: boolean) {
  if (!json && count > 0) {
    line(c.dim(`\n(${count} document(s) could not be parsed and were skipped.)`));
  }
}

export function scanCommand(
  pathArg: string | undefined,
  opts: CommonOpts & { details?: boolean }
): void {
  const { analysis, parseErrors, failOn } = run(pathArg, opts);
  if (opts.json) {
    console.log(toJson(analysis));
  } else {
    term.printFull(analysis, !!opts.details);
    maybeParseNote(parseErrors.length, false);
  }
  gate(analysis, failOn, !!opts.json);
}

export function overfetchCommand(pathArg: string | undefined, opts: CommonOpts): void {
  const { analysis, failOn } = run(pathArg, opts);
  if (opts.json) console.log(JSON.stringify(analysis.overfetch, null, 2));
  else {
    term.printOverfetch(analysis);
    term.printUnrequestedReads(analysis);
  }
  gate(analysis, failOn, !!opts.json);
}

export function unusedCommand(pathArg: string | undefined, opts: CommonOpts): void {
  const { analysis, failOn } = run(pathArg, opts);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          deadQueries: analysis.deadQueries.map((o) => o.name ?? o.varName),
          deadFragments: analysis.deadFragments.map((f) => f.name),
          unusedVariables: analysis.operations
            .filter((o) => o.unusedVariables.length)
            .map((o) => ({ operation: o.name, variables: o.unusedVariables })),
        },
        null,
        2
      )
    );
  } else {
    term.printDeadQueries(analysis);
    term.printDeadFragments(analysis);
    term.printUnusedVariables(analysis);
  }
  gate(analysis, failOn, !!opts.json);
}

export function complexityCommand(pathArg: string | undefined, opts: CommonOpts): void {
  const { analysis, failOn } = run(pathArg, opts);
  if (opts.json) console.log(JSON.stringify(analysis.complexity, null, 2));
  else term.printComplexity(analysis);
  gate(analysis, failOn, !!opts.json);
}

export function duplicatesCommand(pathArg: string | undefined, opts: CommonOpts): void {
  const { analysis, failOn } = run(pathArg, opts);
  if (opts.json) {
    console.log(
      JSON.stringify(
        { queries: analysis.duplicateQueries, fragments: analysis.duplicateFragments },
        null,
        2
      )
    );
  } else {
    term.printDuplicates(analysis);
  }
  gate(analysis, failOn, !!opts.json);
}

/** `impact <Type.field | fieldName | OperationName>` — blast radius of a field. */
export function impactCommand(
  target: string,
  pathArg: string | undefined,
  opts: CommonOpts
): void {
  const { analysis } = run(pathArg, opts);
  const result = analyzeImpact(analysis.operations, analysis.fragments, analysis.usages, target);

  if (opts.json) {
    return console.log(
      JSON.stringify(
        {
          target: result.target,
          affectedOperations: result.operations,
          affectedFragments: result.fragments,
          affectedComponents: result.components,
        },
        null,
        2
      )
    );
  }

  heading(`Impact of "${target}"`);
  line(`  Affected operations: ${c.bold(String(result.operations.length))}`);
  line(`  Affected fragments:  ${c.bold(String(result.fragments.length))}`);
  line(`  Affected components: ${c.bold(String(result.components.length))}`);
  for (const name of result.operations.slice(0, 30)) {
    line(`    · ${name}`);
  }
}

export function typesCommand(pathArg: string | undefined, opts: CommonOpts): void {
  const { analysis, failOn } = run(pathArg, opts, true);
  if (opts.json) console.log(JSON.stringify(analysis.generatedTypes, null, 2));
  else term.printGeneratedTypes(analysis);
  gate(analysis, failOn, !!opts.json);
}
