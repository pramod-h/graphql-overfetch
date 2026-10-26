import { AnalysisResult } from '../types';

/** A serializable, CI-friendly projection of the analysis. */
export function toJson(a: AnalysisResult): string {
  return JSON.stringify(
    {
      summary: {
        operations: a.operations.length,
        fragments: a.fragments.length,
        components: a.stats.components,
        sourceFiles: a.stats.sourceFiles,
        graphqlFiles: a.stats.graphqlFiles,
        deadQueries: a.deadQueries.length,
        deadFragments: a.deadFragments.length,
        duplicateQueries: a.duplicateQueries.length,
        duplicateFragments: a.duplicateFragments.length,
        overfetchingQueries: a.overfetch.length,
        unrequestedReads: a.unrequestedReads.length,
        schemaDrift: a.schemaLoaded ? a.schemaDrift.length : null,
      },
      overfetch: a.overfetch,
      unrequestedReads: a.unrequestedReads,
      deadQueries: a.deadQueries.map((o) => ({
        name: o.name,
        operation: o.operation,
        file: o.loc.file,
        line: o.loc.line,
      })),
      deadFragments: a.deadFragments.map((f) => ({
        name: f.name,
        typeCondition: f.typeCondition,
        file: f.loc.file,
        line: f.loc.line,
      })),
      duplicateQueries: a.duplicateQueries,
      duplicateFragments: a.duplicateFragments,
      complexity: a.complexity,
      schemaDrift: a.schemaDrift,
      unusedVariables: a.operations
        .filter((o) => o.unusedVariables.length)
        .map((o) => ({ operation: o.name, variables: o.unusedVariables })),
    },
    null,
    2
  );
}
