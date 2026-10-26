import path from 'path';
import { GraphQLOperation } from '../types';

/**
 * Operations no code references. An operation is considered *alive* if any of
 * its document identifiers — the `gql` const name, the operation name, the
 * codegen `<Name>Document`, or a generated `use<Name>Query` hook — is
 * referenced as a value anywhere in the project (see `collectReferencedNames`).
 *
 * This is precision-biased on purpose: it won't flag a query as dead just
 * because we couldn't trace which hook runs it (custom wrapper hooks, Venia
 * operations-map indirection, duplicate definitions sharing a name). The cost
 * is missing some genuinely-dead queries; the benefit is not telling you to
 * delete live code.
 */
export function findDeadQueries(
  operations: GraphQLOperation[],
  referencedNames: Set<string>
): GraphQLOperation[] {
  const varCount = new Map<string, number>();
  for (const op of operations) {
    if (op.varName) varCount.set(op.varName, (varCount.get(op.varName) ?? 0) + 1);
  }
  return operations.filter((op) => {
    // An inline anonymous document (`client.query({ query: gql`{ … }` })`) has
    // nothing to look up; it sits where it runs, so don't call it dead.
    if (!op.varName && !op.name) return false;
    // A .graphql file whose path appears in code is loaded as a string (fs.readFileSync).
    if (op.source === 'graphql-file' && referencedNames.has(`file:${path.basename(op.loc.file)}`)) return false;
    if (op.varName && (varCount.get(op.varName) ?? 0) > 1) {
      // Several files define this constant: only references traced to this
      // file count (or ones we couldn't trace, to stay on the safe side).
      return !(
        referencedNames.has(`${op.varName}@${op.loc.file}`) || referencedNames.has(`${op.varName}@?`)
      );
    }
    const ids = [op.varName, op.name, op.name ? `${op.name}Document` : null];
    return !ids.some((id) => id != null && referencedNames.has(id));
  });
}
