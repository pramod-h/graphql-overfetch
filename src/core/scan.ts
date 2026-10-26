import fg from 'fast-glob';
import { Project } from 'ts-morph';
import { AnalysisResult, ScanOptions } from '../types';
import { detectProject } from '../parsers/project';
import { loadSchema } from '../parsers/schema';
import { buildModel, ParseError } from '../parsers/operations';
import {
  DEFAULT_IGNORE,
  extractGraphqlFiles,
  extractTaggedTemplates,
} from '../parsers/graphql-files';
import {
  mapComponents,
  collectReferencedNames,
  collectCacheKeyFields,
} from '../analyzers/component-map';
import { runAnalysis } from '../analyzers';
import { analyzeGeneratedTypes } from '../analyzers/generated-types';
import { spinner } from '../utils/logger';

const SOURCE_IGNORE = DEFAULT_IGNORE.filter((g) => g !== '**/*.d.ts');

export interface ScanResult {
  analysis: AnalysisResult;
  parseErrors: ParseError[];
}

/**
 * The end-to-end pipeline:
 *   detect → build source project → scan GraphQL → parse model →
 *   map components → run analyzers.
 */
export function scan(options: ScanOptions): ScanResult {
  const root = options.cwd;
  const ignore = [...DEFAULT_IGNORE, ...(options.ignore ?? [])];
  const parseErrors: ParseError[] = [];

  const sp = spinner('Detecting project…');
  const project = detectProject(root, options.schema);
  const schema = loadSchema(options.schema ?? project.schemaPath);

  sp.text = 'Loading source files…';
  const tsProject = new Project({
    compilerOptions: { allowJs: true, checkJs: false, noEmit: true },
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
  // Glob ourselves so user `--ignore` patterns (relative to root) apply here
  // too. `.d.ts` stays in: codegen output can be declaration files. Files are
  // added one by one because paths like `[id].tsx` are not safe as globs.
  const sourceFiles = fg.sync('**/*.{ts,tsx,js,jsx}', {
    cwd: root,
    absolute: true,
    ignore: [...SOURCE_IGNORE, ...(options.ignore ?? [])],
    suppressErrors: true,
  });
  for (const file of sourceFiles) tsProject.addSourceFileAtPath(file);
  const sourceFileCount = tsProject.getSourceFiles().length;

  sp.text = 'Scanning GraphQL documents…';
  const fileDefs = extractGraphqlFiles(root, ignore, parseErrors);
  const { defs: templateDefs, bindings } = extractTaggedTemplates(tsProject, parseErrors);
  const allDefs = [...fileDefs, ...templateDefs];

  sp.text = 'Building operation model…';
  const { operations, fragments } = buildModel(allDefs);

  sp.text = 'Mapping components → operations…';
  const usages = mapComponents(tsProject, operations, fragments, bindings);
  const referencedNames = collectReferencedNames(tsProject);
  const components = new Set(usages.map((u) => `${u.file}:${u.component}`)).size;

  sp.text = 'Running analyzers…';
  const analysis = runAnalysis({
    project,
    operations,
    fragments,
    usages,
    bindings,
    referencedNames,
    cacheKeyFields: collectCacheKeyFields(tsProject),
    schema,
    stats: {
      graphqlFiles: fileDefs.length,
      sourceFiles: sourceFileCount,
      components,
    },
  });

  if (options.analyzeTypes) {
    sp.text = 'Analyzing generated types…';
    analysis.generatedTypes = analyzeGeneratedTypes(tsProject, root, options.generated);
  }

  sp.succeed('Analysis complete');
  return { analysis, parseErrors };
}
