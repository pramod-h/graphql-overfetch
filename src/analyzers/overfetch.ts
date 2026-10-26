import {
  Confidence,
  GraphQLFragment,
  GraphQLOperation,
  HookUsage,
  OverfetchFinding,
} from '../types';
import { DocBinding } from '../parsers/graphql-files';
import { buildResolvers, isNoCacheUsage } from './component-map';

/** Always needed by normalized caches; Apollo adds `__typename` on its own. */
const DEFAULT_CACHE_KEYS = ['id', 'uid', '_id'];

/** True if `leaf` is covered by any pass-through (whole-object) ancestor. */
function passthroughCovers(leaf: string, passthrough: Set<string>): boolean {
  if (passthrough.has('')) return true; // '' = the entire operation result passed through
  for (const p of passthrough) {
    if (leaf === p || leaf.startsWith(p + '.')) return true;
  }
  return false;
}

/** True if any accessed/passthrough path touches the subtree rooted at `top`. */
function subtreeTouched(top: string, sets: Set<string>[]): boolean {
  for (const set of sets) {
    if (set.has('')) return true; // '' = the entire operation result passed through
    for (const a of set) {
      if (a === top || a.startsWith(top + '.')) return true;
    }
  }
  return false;
}

/**
 * The differentiating analysis: compare each query's requested fields against
 * the fields actually read in the components that run it, and report the fields
 * that are fetched but never used.
 *
 * Precision-biased: if we captured no field reads at all for an operation (e.g.
 * the result is only returned from a custom hook we don't follow), we skip it
 * rather than claim everything is unused.
 */
export function analyzeOverfetch(
  operations: GraphQLOperation[],
  fragments: GraphQLFragment[],
  usages: HookUsage[],
  bindings: DocBinding[],
  cacheKeyFields: Set<string> = new Set()
): OverfetchFinding[] {
  const cacheKeys = new Set([...DEFAULT_CACHE_KEYS, ...cacheKeyFields]);
  const { resolveUsage } = buildResolvers(operations, fragments, bindings);

  // Group usages by the operation they resolve to.
  const byOp = new Map<GraphQLOperation, HookUsage[]>();
  for (const u of usages) {
    const op = resolveUsage(u);
    if (!op) continue;
    if (!byOp.has(op)) byOp.set(op, []);
    byOp.get(op)!.push(u);
  }

  const findings: OverfetchFinding[] = [];

  for (const op of operations) {
    const allUsages = byOp.get(op) ?? [];
    if (allUsages.length === 0) continue; // no consumer → dead-query territory, not overfetch

    // Every call site throws the result away → the whole selection is wasted,
    // for mutations too (see HookUsage.resultDiscarded).
    if (allUsages.every((u) => u.resultDiscarded)) {
      const leaves = op.leafPaths;
      if (!leaves.length) continue;
      findings.push({
        operation: op.name ?? op.varName ?? `(anonymous ${op.operation})`,
        file: op.loc.file,
        line: op.loc.line,
        requestedCount: leaves.length,
        usedCount: 0,
        unused: leaves.map((path) => ({ path, confidence: 'high' as Confidence })).sort((a, b) => a.path.localeCompare(b.path)),
        estimatedReductionPct: 100,
        reason: 'result-discarded',
      });
      continue;
    }

    if (op.operation !== 'query') continue; // otherwise queries only — mutations rarely render their result
    const opUsages = allUsages.filter((u) => !u.resultDiscarded);

    const accessed = new Set<string>();
    const passthrough = new Set<string>();
    for (const u of opUsages) {
      u.accessedPaths.forEach((p) => accessed.add(p));
      u.passthroughPaths.forEach((p) => passthrough.add(p));
    }
    if (accessed.size === 0 && passthrough.size === 0) continue; // not analyzable

    // Cache identity fields aren't overfetch: the cache needs them even when no
    // component reads them. Without a cache (graphql-request, codegen fetchers)
    // an unread id is real waste, so only `__typename` is skipped there.
    const usesCache = !opUsages.every(isNoCacheUsage);
    const leaves = op.leafPaths.filter((l) => {
      const last = l.slice(l.lastIndexOf('.') + 1);
      return last !== '__typename' && !(usesCache && cacheKeys.has(last));
    });
    if (leaves.length === 0) continue;

    const topLevel = Array.from(new Set(leaves.map((l) => l.split('.')[0])));
    const unused: { path: string; confidence: Confidence }[] = [];
    let unusedLeafCount = 0;
    const reportedBranches = new Set<string>();

    // 1) Whole top-level branches never touched → high-confidence overfetch.
    for (const top of topLevel) {
      if (!subtreeTouched(top, [accessed, passthrough])) {
        unused.push({ path: top, confidence: 'high' });
        reportedBranches.add(top);
        unusedLeafCount += leaves.filter(
          (l) => l === top || l.startsWith(top + '.')
        ).length;
      }
    }

    // 2) Individual unused leaves inside branches we DO otherwise use.
    for (const leaf of leaves) {
      const top = leaf.split('.')[0];
      if (reportedBranches.has(top)) continue;
      const covered = accessed.has(leaf) || passthroughCovers(leaf, passthrough);
      if (!covered) {
        unused.push({ path: leaf, confidence: 'medium' });
        unusedLeafCount++;
      }
    }

    if (unused.length === 0) continue;

    findings.push({
      operation: op.name ?? op.varName ?? '(anonymous query)',
      file: op.loc.file,
      line: op.loc.line,
      requestedCount: leaves.length,
      usedCount: leaves.length - unusedLeafCount,
      unused: unused.sort((a, b) => a.path.localeCompare(b.path)),
      estimatedReductionPct: Math.round((unusedLeafCount / leaves.length) * 100),
    });
  }

  return findings.sort((a, b) => b.estimatedReductionPct - a.estimatedReductionPct);
}
