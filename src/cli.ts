#!/usr/bin/env node
import { readFileSync } from 'fs';
import path from 'path';
import { Command } from 'commander';
import {
  scanCommand,
  overfetchCommand,
  unusedCommand,
  complexityCommand,
  duplicatesCommand,
  impactCommand,
  typesCommand,
} from './commands';

// package.json sits one level above both src/ (tsx) and dist/ (published build).
const { version } = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
) as { version: string };

const program = new Command();

program
  .name('graphql-inspector')
  .description(
    'Understand how your frontend actually uses GraphQL — dead queries, duplicates, complexity, schema drift, and overfetch analysis.'
  )
  .version(version);

// Shared options. NOTE: options/actions must live on subcommands, never on the
// root program — a root action + argument silently breaks subcommand option
// parsing in Commander v12. `scan` is the default command instead.
const withOpts = (cmd: Command) =>
  cmd
    .argument('[path]', 'project root to analyze')
    .option('--json', 'output machine-readable JSON')
    .option('--schema <path>', 'path to schema.graphql or introspection .json')
    .option('--ignore <globs...>', 'extra ignore globs');

withOpts(program.command('scan', { isDefault: true }).description('Full report (summary + optional details)'))
  .option('--details', 'print every section, not just the summary')
  .action(scanCommand);

withOpts(program.command('overfetch').description('Fields requested but never read in components')).action(
  overfetchCommand
);

withOpts(program.command('unused').description('Dead queries, dead fragments, and unused variables')).action(
  unusedCommand
);

withOpts(program.command('complexity').description('Per-operation depth and field-count risk')).action(
  complexityCommand
);

withOpts(program.command('duplicates').description('Identical and near-identical documents')).action(
  duplicatesCommand
);

program
  .command('impact')
  .description('Blast radius of a field: affected operations, fragments, components')
  .argument('<target>', 'e.g. Product.price, price, or an operation name')
  .argument('[path]', 'project root to analyze')
  .option('--json', 'output machine-readable JSON')
  .option('--schema <path>', 'path to schema.graphql or introspection .json')
  .option('--ignore <globs...>', 'extra ignore globs')
  .action((target: string, pathArg: string | undefined, opts) =>
    impactCommand(target, pathArg, opts)
  );

withOpts(program.command('types').description('Generated type usage / unused generated types'))
  .option('--generated <globs...>', 'globs for generated files (overrides auto-detection)')
  .action(typesCommand);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
