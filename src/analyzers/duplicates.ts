import { DuplicateGroup, GraphQLDocumentDef } from '../types';
import { jaccard } from '../utils/hash';

const NEAR_DUP_THRESHOLD = 0.9;

interface Item {
  name: string;
  file: string;
  line: number;
  hash: string;
  scope: string;
  /** Root field names (not aliases): near-duplicates must query the same fields. */
  roots: string;
  leafPaths: string[];
  clientOnly: boolean;
}

/** `{ id __typename }` placeholders (e.g. edition stubs) aren't worth sharing. */
const isStub = (d: GraphQLDocumentDef) =>
  d.leafPaths.every((p) => /(^|\.)(id|uid|__typename)$/.test(p));

function toItems(defs: GraphQLDocumentDef[]): Item[] {
  return defs.filter((d) => !isStub(d)).map((d) => ({
    name: d.kind === 'operation' ? d.name ?? '(anonymous)' : d.name,
    file: d.loc.file,
    line: d.loc.line,
    hash: d.documentHash,
    scope: d.kind === 'operation' ? d.operation : d.typeCondition,
    roots: Array.from(new Set(d.fields.map((f) => f.name))).sort().join(','),
    clientOnly: /@client\b/.test(d.rawText),
    leafPaths: d.leafPaths,
  }));
}

/**
 * Group documents that request the same thing. Exact duplicates share a
 * document hash: same fields, arguments and variables, whatever the operation
 * name, aliases or field order (similarity 1.0). Near-duplicates (same scope
 * and root fields, Jaccard ≥ 0.9 over response paths) are reported too —
 * that's the "SearchProducts vs ProductSearch, 98% identical".
 */
export function findDuplicates(defs: GraphQLDocumentDef[]): DuplicateGroup[] {
  const items = toItems(defs);
  const groups: DuplicateGroup[] = [];
  const consumed = new Set<Item>();

  // Exact duplicates by hash.
  const byHash = new Map<string, Item[]>();
  for (const it of items) {
    if (!byHash.has(it.hash)) byHash.set(it.hash, []);
    byHash.get(it.hash)!.push(it);
  }
  for (const members of byHash.values()) {
    if (members.length > 1) {
      members.forEach((m) => consumed.add(m));
      groups.push({
        members: members.map((m) => ({ name: m.name, file: m.file, line: m.line })),
        similarity: 1,
      });
    }
  }

  // Near-duplicates among the remainder, within the same scope. Mutations that
  // differ are different writes, and @client documents only read the local
  // cache, so neither is a candidate for sharing.
  const rest = items.filter((it) => !consumed.has(it) && it.scope !== 'mutation' && !it.clientOnly);
  for (let i = 0; i < rest.length; i++) {
    if (consumed.has(rest[i])) continue;
    const cluster = [rest[i]];
    for (let j = i + 1; j < rest.length; j++) {
      if (consumed.has(rest[j])) continue;
      if (rest[i].scope !== rest[j].scope || rest[i].roots !== rest[j].roots) continue;
      const sim = jaccard(rest[i].leafPaths, rest[j].leafPaths);
      if (sim >= NEAR_DUP_THRESHOLD && sim < 1) {
        cluster.push(rest[j]);
        consumed.add(rest[j]);
      }
    }
    if (cluster.length > 1) {
      consumed.add(rest[i]);
      const sim = jaccard(cluster[0].leafPaths, cluster[1].leafPaths);
      groups.push({
        members: cluster.map((m) => ({ name: m.name, file: m.file, line: m.line })),
        similarity: Math.round(sim * 100) / 100,
      });
    }
  }

  return groups.sort((a, b) => b.similarity - a.similarity);
}
