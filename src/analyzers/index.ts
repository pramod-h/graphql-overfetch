import { GraphQLSchema } from 'graphql';
import {
  AnalysisResult,
  GraphQLFragment,
  GraphQLOperation,
  HookUsage,
  ProjectInfo,
} from '../types';
import { DocBinding } from '../parsers/graphql-files';
import { findDeadQueries } from './dead-queries';
import { findDeadFragments } from './dead-fragments';
import { findDuplicates } from './duplicates';
import { analyzeComplexity } from './complexity';
import { analyzeOverfetch } from './overfetch';
import { analyzeSchemaDrift } from './schema-drift';

export interface AnalyzeInput {
  project: ProjectInfo;
  operations: GraphQLOperation[];
  fragments: GraphQLFragment[];
  usages: HookUsage[];
  bindings: DocBinding[];
  /** Identifiers referenced as values anywhere in the project (for dead-query detection). */
  referencedNames: Set<string>;
  /** Field names the app's cache keys objects by (`typePolicies` `keyFields`). */
  cacheKeyFields?: Set<string>;
  schema: GraphQLSchema | null;
  stats: AnalysisResult['stats'];
}

/** Run every analyzer and assemble the full result. */
export function runAnalysis(input: AnalyzeInput): AnalysisResult {
  const { project, operations, fragments, usages, bindings, referencedNames, schema, stats, cacheKeyFields } =
    input;
  return {
    project,
    operations,
    fragments,
    usages,
    deadQueries: findDeadQueries(operations, referencedNames),
    deadFragments: findDeadFragments(operations, fragments),
    duplicateQueries: findDuplicates(operations),
    duplicateFragments: findDuplicates(fragments),
    complexity: analyzeComplexity(operations),
    overfetch: analyzeOverfetch(operations, fragments, usages, bindings, cacheKeyFields),
    schemaDrift: analyzeSchemaDrift(schema, operations, fragments),
    schemaLoaded: !!schema,
    generatedTypes: null,
    stats,
  };
}
