import {
  GraphQLFragment,
  GraphQLOperation,
  HookUsage,
  UnrequestedReadFinding,
} from '../types';
import { DocBinding } from '../parsers/graphql-files';
import { buildResolvers } from './component-map';

/** Property reads on a requested value that aren't GraphQL fields. */
const NON_FIELD_PROPS = new Set(['length', '__typename']);

/**
 * The reverse of overfetch: fields the code reads off a result that the
 * operation never requests, so they're always `undefined` at runtime.
 *
 * Only reported when the missing field's parent object *is* requested (e.g.
 * `cart.wants_to_enroll` with `cart { … }` in the query). That keeps unrelated
 * same-named variables and JSON scalars from producing false reports.
 */
export function analyzeUnrequestedReads(
  operations: GraphQLOperation[],
  fragments: GraphQLFragment[],
  usages: HookUsage[],
  bindings: DocBinding[]
): UnrequestedReadFinding[] {
  const { resolveOp } = buildResolvers(operations, fragments, bindings);
  const findings: UnrequestedReadFinding[] = [];
  const byOp = new Map<GraphQLOperation, HookUsage[]>();
  for (const u of usages) {
    const op = resolveOp(u.documentIdentifier ?? u.operationName);
    if (!op) continue;
    if (!byOp.has(op)) byOp.set(op, []);
    byOp.get(op)!.push(u);
  }

  for (const [op, opUsages] of byOp) {
    const requested = new Set(op.allPaths);
    const leaves = new Set(op.leafPaths);
    const reads = new Map<string, { file: string; line: number }>();

    for (const u of opUsages) {
      for (const p of u.accessedPaths) {
        const segments = p.split('.');
        // Shortest prefix that isn't requested — deeper segments follow from it.
        let missing: string | null = null;
        let parent = '';
        for (const seg of segments) {
          const next = parent ? `${parent}.${seg}` : seg;
          if (!requested.has(next)) {
            missing = next;
            break;
          }
          if (leaves.has(next)) break; // below a scalar (e.g. a JSON field): not a GraphQL path
          parent = next;
        }
        if (!missing || !parent) continue; // top-level misses are too ambiguous to report
        if (NON_FIELD_PROPS.has(missing.slice(parent.length + 1))) continue;
        if (!reads.has(missing)) reads.set(missing, { file: u.file, line: u.line });
      }
    }

    if (!reads.size) continue;
    findings.push({
      operation: op.name ?? op.varName ?? `(anonymous ${op.operation})`,
      file: op.loc.file,
      line: op.loc.line,
      reads: Array.from(reads, ([path, at]) => ({ path, file: at.file, line: at.line })).sort((a, b) =>
        a.path.localeCompare(b.path)
      ),
    });
  }

  return findings.sort((a, b) => a.operation.localeCompare(b.operation));
}
