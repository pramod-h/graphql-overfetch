import {
  parse,
  print,
  visit,
  Kind,
  DefinitionNode,
  SelectionSetNode,
  OperationDefinitionNode,
  FragmentDefinitionNode,
} from 'graphql';
import {
  DocSource,
  FieldNode,
  GraphQLFragment,
  GraphQLOperation,
  SourceLocation,
} from '../types';
import { fieldSetHash } from '../utils/hash';

/** Intermediate: a single definition extracted from a source, pre-resolution. */
export interface ParsedDef {
  node: OperationDefinitionNode | FragmentDefinitionNode;
  file: string;
  /** Line in the original file where the containing document/template starts. */
  startLine: number;
  source: DocSource;
  /** JS/TS identifier this document was assigned to, when known. */
  varName?: string | null;
}

export interface ParseError {
  file: string;
  line: number;
  message: string;
}

/**
 * Parse one GraphQL document string into its definitions. `startLine` is the
 * 1-based line in the original file where this text begins (for tagged
 * templates); 0 for standalone `.graphql` files.
 */
export function extractDefinitions(
  text: string,
  source: DocSource,
  file: string,
  startLine: number,
  errors: ParseError[]
): ParsedDef[] {
  let doc;
  try {
    doc = parse(text);
  } catch (e) {
    errors.push({
      file,
      line: startLine || 1,
      message: (e as Error).message.split('\n')[0],
    });
    return [];
  }
  const out: ParsedDef[] = [];
  for (const def of doc.definitions as DefinitionNode[]) {
    if (
      def.kind === Kind.OPERATION_DEFINITION ||
      def.kind === Kind.FRAGMENT_DEFINITION
    ) {
      out.push({ node: def, file, startLine, source });
    }
  }
  return out;
}

function locOf(def: ParsedDef): SourceLocation {
  const tok = def.node.loc?.startToken;
  const innerLine = tok?.line ?? 1;
  const line = def.startLine ? def.startLine + innerLine - 1 : innerLine;
  return { file: def.file, line, column: tok?.column ?? 1 };
}

/** Direct fragment spread names referenced anywhere in a selection set. */
function directSpreads(selectionSet: SelectionSetNode): string[] {
  const names = new Set<string>();
  visit(selectionSet, {
    FragmentSpread(n) {
      names.add(n.name.value);
    },
  });
  return Array.from(names);
}

/** Variable names ($x) actually referenced within a selection set. */
function usedVariables(selectionSet: SelectionSetNode): Set<string> {
  const names = new Set<string>();
  visit(selectionSet, {
    Variable(n) {
      names.add(n.name.value);
    },
  });
  return names;
}

/** Merge a field node into a list, unioning children on matching response keys. */
function mergeField(into: FieldNode[], node: FieldNode): void {
  const existing = into.find((f) => f.responseKey === node.responseKey);
  if (!existing) {
    into.push(node);
    return;
  }
  existing.hasSelection = existing.hasSelection || node.hasSelection;
  for (const child of node.children) mergeField(existing.children, child);
}

/**
 * Fragments injected into others at build time: GraphCommerce's codegen adds a
 * fragment marked `@inject(into: ["Target"])` to every selection that spreads
 * `Target`. Maps target name → injecting fragment names.
 */
function injectionMap(fragments: Iterable<FragmentDefinitionNode>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const frag of fragments) {
    for (const dir of frag.directives ?? []) {
      if (dir.name.value !== 'inject') continue;
      const into = dir.arguments?.find((a) => a.name.value === 'into')?.value;
      const targets =
        into?.kind === Kind.LIST
          ? into.values.filter((v) => v.kind === Kind.STRING).map((v) => (v as { value: string }).value)
          : into?.kind === Kind.STRING
          ? [into.value]
          : [];
      for (const target of targets) {
        if (!map.has(target)) map.set(target, []);
        map.get(target)!.push(frag.name.value);
      }
    }
  }
  return map;
}

/**
 * Walk a selection set into a FieldNode tree, inlining fragment spreads and
 * inline fragments so that `path`s reflect the true requested response shape.
 */
function walk(
  selectionSet: SelectionSetNode,
  parentPath: string,
  fragments: Map<string, FragmentDefinitionNode[]>,
  seenFragments: Set<string>,
  injected: Map<string, string[]> = new Map()
): FieldNode[] {
  const result: FieldNode[] = [];
  for (const sel of selectionSet.selections) {
    if (sel.kind === Kind.FIELD) {
      const responseKey = sel.alias?.value ?? sel.name.value;
      const path = parentPath ? `${parentPath}.${responseKey}` : responseKey;
      const hasSelection = !!sel.selectionSet;
      const args = sel.arguments?.length
        ? `(${sel.arguments.map((a) => `${a.name.value}:${print(a.value)}`).sort().join(',')})`
        : '';
      const children = hasSelection
        ? walk(sel.selectionSet!, path, fragments, seenFragments, injected)
        : [];
      mergeField(result, {
        name: sel.name.value,
        responseKey,
        path,
        hasSelection,
        args,
        children,
      });
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      // Same level — merge the inline fragment's fields at parentPath.
      for (const node of walk(sel.selectionSet, parentPath, fragments, seenFragments, injected)) {
        mergeField(result, node);
      }
    } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
      for (const node of expandFragment(sel.name.value, parentPath, fragments, seenFragments, injected)) {
        mergeField(result, node);
      }
    }
  }
  return result;
}

/** A spread fragment's fields, plus those of every fragment injected into it. */
function expandFragment(
  fragName: string,
  parentPath: string,
  fragments: Map<string, FragmentDefinitionNode[]>,
  seenFragments: Set<string>,
  injected: Map<string, string[]>
): FieldNode[] {
  // Several definitions can share a name (per-edition `.ee.js` / `.ce.js` files
  // swapped at build time): request the union, since any of them may be live.
  const defs = fragments.get(fragName);
  if (!defs || seenFragments.has(fragName)) return [];
  const nextSeen = new Set(seenFragments).add(fragName);
  const out: FieldNode[] = [];
  for (const frag of defs) {
    for (const node of walk(frag.selectionSet, parentPath, fragments, nextSeen, injected)) {
      mergeField(out, node);
    }
  }
  for (const injector of injected.get(fragName) ?? []) {
    for (const node of expandFragment(injector, parentPath, fragments, nextSeen, injected)) {
      mergeField(out, node);
    }
  }
  return out;
}

function collectPaths(fields: FieldNode[]): { leaf: string[]; all: string[] } {
  const leaf: string[] = [];
  const all: string[] = [];
  const rec = (nodes: FieldNode[]) => {
    for (const n of nodes) {
      all.push(n.path);
      if (n.children.length === 0) leaf.push(n.path);
      else rec(n.children);
    }
  };
  rec(fields);
  return { leaf, all };
}

/** Paths built from real field names + arguments (aliases ignored), for documentHash. */
function signaturePaths(fields: FieldNode[], parent = ''): string[] {
  const out: string[] = [];
  for (const n of fields) {
    const seg = `${parent}.${n.name}${n.args}`;
    out.push(seg, ...signaturePaths(n.children, seg));
  }
  return out;
}

function treeDepth(fields: FieldNode[]): number {
  let max = 0;
  for (const n of fields) {
    max = Math.max(max, n.children.length ? 1 + treeDepth(n.children) : 1);
  }
  return max;
}

/**
 * Resolve a batch of parsed definitions into the full operation/fragment model,
 * inlining fragments across files.
 */
export function buildModel(defs: ParsedDef[]): {
  operations: GraphQLOperation[];
  fragments: GraphQLFragment[];
} {
  const fragmentNodes = new Map<string, FragmentDefinitionNode[]>();
  for (const d of defs) {
    if (d.node.kind === Kind.FRAGMENT_DEFINITION) {
      const name = d.node.name.value;
      fragmentNodes.set(name, [...(fragmentNodes.get(name) ?? []), d.node]);
    }
  }

  const injected = injectionMap([...fragmentNodes.values()].flat());

  const operations: GraphQLOperation[] = [];
  const fragments: GraphQLFragment[] = [];

  for (const d of defs) {
    let fields = walk(d.node.selectionSet, '', fragmentNodes, new Set(), injected);
    let spreads = directSpreads(d.node.selectionSet);
    if (d.node.kind === Kind.FRAGMENT_DEFINITION) {
      // A fragment's own shape includes whatever is injected into it.
      const self = d.node.name.value;
      const injectors = injected.get(self) ?? [];
      for (const injector of injectors) {
        const merged = [...fields];
        for (const node of expandFragment(injector, '', fragmentNodes, new Set([self]), injected)) {
          mergeField(merged, node);
        }
        fields = merged;
      }
      spreads = Array.from(new Set([...spreads, ...injectors]));
    }
    const { leaf, all } = collectPaths(fields);
    const depth = treeDepth(fields);
    const loc = locOf(d);
    const rawText = print(d.node);

    if (d.node.kind === Kind.OPERATION_DEFINITION) {
      const op = d.node;
      const declared = (op.variableDefinitions ?? []).map((v) => v.variable.name.value);
      const varDefs = (op.variableDefinitions ?? []).map((v) => print(v)).sort().join(',');
      const used = usedVariables(op.selectionSet);
      operations.push({
        kind: 'operation',
        name: op.name?.value ?? null,
        operation: op.operation,
        variables: declared,
        unusedVariables: declared.filter((v) => !used.has(v)),
        fields,
        leafPaths: leaf,
        allPaths: all,
        fragmentSpreads: spreads,
        depth,
        loc,
        source: d.source,
        rawText,
        fieldSetHash: fieldSetHash(leaf, op.operation),
        documentHash: fieldSetHash(signaturePaths(fields), `${op.operation}(${varDefs})`),
        varName: d.varName ?? null,
      });
    } else {
      const frag = d.node;
      fragments.push({
        kind: 'fragment',
        name: frag.name.value,
        typeCondition: frag.typeCondition.name.value,
        fields,
        leafPaths: leaf,
        allPaths: all,
        fragmentSpreads: spreads,
        depth,
        loc,
        source: d.source,
        rawText,
        fieldSetHash: fieldSetHash(leaf, frag.typeCondition.name.value),
        documentHash: fieldSetHash(signaturePaths(fields), `on ${frag.typeCondition.name.value}`),
        varName: d.varName ?? null,
      });
    }
  }

  return { operations, fragments };
}
