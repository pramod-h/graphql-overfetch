/**
 * Shared domain model for the whole pipeline:
 *   detect → scan → parse → map components → analyze → report
 */

export type OperationType = 'query' | 'mutation' | 'subscription';

export type DocSource = 'graphql-file' | 'tagged-template';

export type Library =
  | 'apollo'
  | 'urql'
  | 'graphql-request'
  | 'relay'
  | 'codegen'
  | 'unknown';

export interface SourceLocation {
  /** Absolute path. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
}

/** A field within a selection set, keyed by its response key (alias || name). */
export interface FieldNode {
  /** GraphQL field name (ignores alias). */
  name: string;
  /** Response key = alias if present, else name. Paths are built from this. */
  responseKey: string;
  /** Dotted response-key path from the document root, e.g. `products.items.price`. */
  path: string;
  /** True when the field has a sub-selection (object/list-of-object). */
  hasSelection: boolean;
  children: FieldNode[];
}

interface DocumentDefBase {
  fields: FieldNode[];
  /** All leaf field paths (scalars / fields with no sub-selection). */
  leafPaths: string[];
  /** Every field path, interior + leaf. */
  allPaths: string[];
  /** Direct fragment spread names referenced in this document. */
  fragmentSpreads: string[];
  depth: number;
  loc: SourceLocation;
  source: DocSource;
  rawText: string;
  /** Stable hash of the normalized field set — used for duplicate detection. */
  fieldSetHash: string;
  /** JS/TS identifier this document was assigned to (`const FOO = gql\`\``). */
  varName: string | null;
}

export interface GraphQLOperation extends DocumentDefBase {
  kind: 'operation';
  name: string | null;
  operation: OperationType;
  /** Declared variable names (without `$`). */
  variables: string[];
  /** Declared variables never referenced in the operation body. */
  unusedVariables: string[];
}

export interface GraphQLFragment extends DocumentDefBase {
  kind: 'fragment';
  name: string;
  typeCondition: string;
}

export type GraphQLDocumentDef = GraphQLOperation | GraphQLFragment;

/** A place in component code that executes / references a GraphQL document. */
export interface HookUsage {
  hook: string;
  library: Library;
  /** Resolved operation or fragment name, when we could resolve it. */
  operationName: string | null;
  /** Variable identifier of the gql document passed to the hook. */
  documentIdentifier: string | null;
  /** Enclosing component / function name, or `<filename>` fallback. */
  component: string;
  file: string;
  line: number;
  /** Response-key paths read off the query result within the component. */
  accessedPaths: string[];
  /** Subtrees handed off wholesale (JSX prop, fn arg, spread) — treated as fully used. */
  passthroughPaths: string[];
  /**
   * The call's result is thrown away (`await request(...);`) by a client with no
   * normalized cache, so nothing can ever read the selected fields.
   */
  resultDiscarded?: boolean;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface OverfetchFinding {
  operation: string;
  file: string;
  line: number;
  requestedCount: number;
  usedCount: number;
  unused: { path: string; confidence: Confidence }[];
  /** Rough payload-reduction estimate = unusedLeafs / requestedLeafs. */
  estimatedReductionPct: number;
  /** Set when every call site throws the result away. */
  reason?: 'result-discarded';
}

/** Fields the code reads off a result but the operation never requests. */
export interface UnrequestedReadFinding {
  operation: string;
  file: string;
  line: number;
  /** Each missing field path, with one place it's read. */
  reads: { path: string; file: string; line: number }[];
}

export interface DuplicateGroup {
  members: { name: string; file: string; line: number }[];
  /** 1.0 = identical field sets; < 1.0 = near-duplicate (Jaccard). */
  similarity: number;
}

export interface ComplexityReport {
  operation: string;
  file: string;
  line: number;
  depth: number;
  /** Fields with sub-selections (object/list). Exact list-ness needs a schema. */
  nestedSelections: number;
  fieldCount: number;
  risk: 'low' | 'medium' | 'high';
}

export interface SchemaDriftFinding {
  operation: string;
  file: string;
  line: number;
  message: string;
}

export interface ProjectInfo {
  root: string;
  /** Detected client libs / frameworks / tooling. */
  detected: string[];
  hasCodegen: boolean;
  schemaPath: string | null;
}

export interface GeneratedTypesReport {
  /** False when no GraphQL Code Generator output could be located. */
  found: boolean;
  generatedFiles: number;
  /** Total exported type declarations (excluding codegen plumbing helpers). */
  total: number;
  /** Reachable from application-code references (directly or transitively). */
  used: number;
  unused: { name: string; file: string; line: number }[];
  usagePct: number;
}

export interface AnalysisResult {
  project: ProjectInfo;
  operations: GraphQLOperation[];
  fragments: GraphQLFragment[];
  usages: HookUsage[];
  deadQueries: GraphQLOperation[];
  deadFragments: GraphQLFragment[];
  duplicateQueries: DuplicateGroup[];
  duplicateFragments: DuplicateGroup[];
  complexity: ComplexityReport[];
  overfetch: OverfetchFinding[];
  unrequestedReads: UnrequestedReadFinding[];
  schemaDrift: SchemaDriftFinding[];
  schemaLoaded: boolean;
  /** Populated only by the `types` command (opt-in via ScanOptions.analyzeTypes). */
  generatedTypes: GeneratedTypesReport | null;
  /** Files scanned counts, for the summary header. */
  stats: {
    graphqlFiles: number;
    sourceFiles: number;
    components: number;
  };
}

export interface ScanOptions {
  cwd: string;
  /** Extra ignore globs on top of the defaults. */
  ignore?: string[];
  /** Explicit schema path override. */
  schema?: string | null;
  /** Run the (more expensive) generated-type usage analysis. */
  analyzeTypes?: boolean;
  /** Explicit globs for generated files, overriding auto-detection. */
  generated?: string[];
}
