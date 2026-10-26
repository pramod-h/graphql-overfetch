import fs from 'fs';
import fg from 'fast-glob';
import { Project, SyntaxKind, Node } from 'ts-morph';
import { Kind } from 'graphql';
import { extractDefinitions, ParsedDef, ParseError } from './operations';

export const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/build/**',
  '**/coverage/**',
  '**/*.d.ts',
];

const GQL_TAGS = new Set(['gql', 'graphql', 'graphqlTag']);

/** Maps the variable a gql document is assigned to → its primary definition. */
export interface DocBinding {
  file: string;
  varName: string;
  primaryName: string | null;
  kind: 'operation' | 'fragment';
}

/** Standalone `.graphql` / `.gql` files. */
export function extractGraphqlFiles(
  root: string,
  ignore: string[],
  errors: ParseError[]
): ParsedDef[] {
  const files = fg.sync(['**/*.graphql', '**/*.gql'], {
    cwd: root,
    absolute: true,
    ignore,
    suppressErrors: true,
  });
  const defs: ParsedDef[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    defs.push(...extractDefinitions(text, 'graphql-file', file, 0, errors));
  }
  return defs;
}

/** Reconstruct a parseable document from a tagged template, dropping `${...}`. */
function templateText(tt: Node): string | null {
  const template = (tt as any).getTemplate?.();
  if (!template) return null;
  if (Node.isNoSubstitutionTemplateLiteral(template)) {
    return template.getLiteralText();
  }
  if (Node.isTemplateExpression(template)) {
    let text = template.getHead().getLiteralText();
    for (const span of template.getTemplateSpans()) {
      // Drop the interpolated expression; keep the surrounding literal text.
      text += ' ' + span.getLiteral().getLiteralText();
    }
    return text;
  }
  return null;
}

/**
 * Extract gql`...` / graphql`...` tagged templates across the ts-morph project.
 * Returns the parsed definitions plus the variable→document bindings used later
 * to resolve `useQuery(DOC)` back to an operation.
 */
export function extractTaggedTemplates(
  project: Project,
  errors: ParseError[]
): { defs: ParsedDef[]; bindings: DocBinding[] } {
  const defs: ParsedDef[] = [];
  const bindings: DocBinding[] = [];

  for (const sf of project.getSourceFiles()) {
    const file = sf.getFilePath();
    const tagged = sf.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression);
    for (const tt of tagged) {
      const tag = tt.getTag().getText();
      const bare = tag.split('.')[0].split('(')[0];
      if (!GQL_TAGS.has(bare) && !tag.endsWith('gql')) continue;

      const text = templateText(tt);
      if (!text || !text.trim()) continue;

      const startLine = tt.getStartLineNumber();
      const before = defs.length;
      const parsed = extractDefinitions(text, 'tagged-template', file, startLine, errors);

      // Only `const FOO = gql`…`` binds the document to FOO — not an enclosing
      // `const run = () => client.query({ query: gql`…` })`.
      let holder: Node = tt;
      while (Node.isAsExpression(holder.getParent()!) || Node.isParenthesizedExpression(holder.getParent()!)) {
        holder = holder.getParent()!;
      }
      const decl = holder.getParent();
      const varName =
        decl && Node.isVariableDeclaration(decl) && decl.getInitializer() === holder ? decl.getName() : undefined;
      for (const p of parsed) p.varName = varName ?? null;
      defs.push(...parsed);

      if (varName && defs.length > before) {
        const first = parsed[0];
        if (first) {
          bindings.push({
            file,
            varName,
            primaryName:
              first.node.kind === Kind.OPERATION_DEFINITION
                ? first.node.name?.value ?? null
                : first.node.name.value,
            kind:
              first.node.kind === Kind.OPERATION_DEFINITION ? 'operation' : 'fragment',
          });
        }
      }
    }
  }

  return { defs, bindings };
}
