import {
  Project,
  Node,
  SyntaxKind,
  CallExpression,
  SourceFile,
} from 'ts-morph';
import path from 'path';
import { GraphQLOperation, GraphQLFragment, HookUsage, Library } from '../types';
import { DocBinding } from '../parsers/graphql-files';

/** Hooks/functions that execute a GraphQL document, and the client they belong to. */
const APOLLO_HOOKS = new Set([
  'useQuery',
  'useLazyQuery',
  'useSuspenseQuery',
  'useBackgroundQuery',
  'useReadQuery',
  'useMutation',
  'useSubscription',
  'useFragment',
]);
const URQL_HOOKS = new Set(['useQuery', 'useMutation', 'useSubscription']);
const REQUEST_FNS = new Set(['request', 'rawRequest']);
const RELAY_HOOKS = new Set(['useLazyLoadQuery', 'usePreloadedQuery', 'useFragment']);
/**
 * Apollo Client's imperative API: `client.query({ query: DOC })` /
 * `client.mutate({ mutation: DOC })`. Common in SSR/server-side data fetching
 * where hooks aren't available. Maps the method name to the options key that
 * carries the document.
 */
const APOLLO_CLIENT_METHOD_KEYS: Record<string, 'query' | 'mutation'> = {
  query: 'query',
  mutate: 'mutation',
};

/** Clients without a normalized cache: a discarded result really is wasted. */
const NO_CACHE_LIBRARIES = new Set<Library>(['graphql-request', 'codegen']);

const GENERATED_HOOK_RE = /^use([A-Z]\w*?)(LazyQuery|SuspenseQuery|Query|Mutation|Subscription)$/;

/** Iteration methods whose callback's element param aliases a list element. */
const CB_ELEMENT_METHODS = new Set([
  'map',
  'forEach',
  'filter',
  'flatMap',
  'find',
  'findIndex',
  'some',
  'every',
  'sort',
]);
/** reduce/reduceRight: element is the callback's *second* param (after the accumulator). */
const REDUCE_METHODS = new Set(['reduce', 'reduceRight']);
/**
 * Methods whose result keeps the same element shape as the source list. When
 * the chain flows through one of these we keep walking with the same path, so a
 * `.filter(...)` result that's re-aliased or passed to a child is still tracked.
 */
const SHAPE_PRESERVING = new Set(['filter', 'slice', 'sort', 'reverse', 'concat', 'flat', 'find']);

/** Option keys whose function value receives the query result as its first param. */
const RESULT_CALLBACKS = new Set(['onCompleted', 'onData']);

interface Alias {
  ident: string;
  /** Start the walk from this node instead of searching for `ident` (e.g. `useQuery(D).data`). */
  node?: Node;
  /** Response-key path this identifier is rooted at ('' = operation root). */
  base: string;
  /** Scope to search for references (defaults to the enclosing function). */
  scope: Node;
  /** When true, skip a leading `.data` segment (identifier holds the whole hook result). */
  viaData?: boolean;
}

/** Resolution indexes built once from the parsed model. */
export function buildResolvers(
  operations: GraphQLOperation[],
  fragments: GraphQLFragment[],
  bindings: DocBinding[]
) {
  const opByVar = new Map<string, GraphQLOperation>();
  const opByName = new Map<string, GraphQLOperation>();
  const fragByVar = new Map<string, GraphQLFragment>();
  const fragByName = new Map<string, GraphQLFragment>();

  for (const op of operations) {
    if (op.varName) opByVar.set(op.varName, op);
    if (op.name) opByName.set(op.name.toLowerCase(), op);
  }
  for (const f of fragments) {
    if (f.varName) fragByVar.set(f.varName, f);
    fragByName.set(f.name.toLowerCase(), f);
  }
  // Bindings help when a var holds an anonymous operation (no op name).
  for (const b of bindings) {
    if (b.primaryName && b.kind === 'operation') {
      const op = opByName.get(b.primaryName.toLowerCase());
      if (op && !opByVar.has(b.varName)) opByVar.set(b.varName, op);
    }
  }

  const resolveOp = (identifier: string | null): GraphQLOperation | null => {
    if (!identifier) return null;
    if (opByVar.has(identifier)) return opByVar.get(identifier)!;
    // Codegen convention: `FooDocument` → operation `Foo`.
    if (identifier.endsWith('Document')) {
      const base = identifier.slice(0, -'Document'.length);
      const hit = opByName.get(base.toLowerCase());
      if (hit) return hit;
    }
    return opByName.get(identifier.toLowerCase()) ?? null;
  };

  const resolveFrag = (identifier: string | null): GraphQLFragment | null => {
    if (!identifier) return null;
    if (fragByVar.has(identifier)) return fragByVar.get(identifier)!;
    if (identifier.endsWith('FragmentDoc')) {
      const base = identifier.slice(0, -'FragmentDoc'.length);
      const hit = fragByName.get(base.toLowerCase());
      if (hit) return hit;
    }
    return fragByName.get(identifier.toLowerCase()) ?? null;
  };

  return { resolveOp, resolveFrag, opByName };
}

interface Classified {
  library: Library;
  hook: string;
  docArg: Node | null;
  generatedName: string | null;
  /** The call resolves to the data itself, not a `{ data }` result object. */
  direct?: boolean;
}

/** Classify a call as a GraphQL execution and return its library + doc argument. */
function classifyCall(call: CallExpression): Classified | null {
  const callee = call.getExpression();
  const args = call.getArguments();

  // GraphQL Code Generator's typescript-react-query static fetcher runs the
  // document outside React: `useFooQuery.fetcher(variables)()` resolves to the data.
  if (Node.isCallExpression(callee)) {
    const inner = callee.getExpression();
    if (Node.isPropertyAccessExpression(inner) && inner.getName() === 'fetcher') {
      const hookName = inner.getExpression().getText();
      const gen = GENERATED_HOOK_RE.exec(hookName);
      if (gen) {
        return { library: 'codegen', hook: `${hookName}.fetcher`, docArg: null, generatedName: gen[1], direct: true };
      }
    }
    return null;
  }

  const hook = Node.isPropertyAccessExpression(callee)
    ? callee.getName()
    : callee.getText();

  // Apollo Client's imperative API: client.query({ query: DOC }) / client.mutate({ mutation: DOC }).
  const clientOptKey = APOLLO_CLIENT_METHOD_KEYS[hook];
  if (
    clientOptKey &&
    Node.isPropertyAccessExpression(callee) &&
    args[0] &&
    Node.isObjectLiteralExpression(args[0])
  ) {
    const obj = args[0];
    const prop = obj.getProperty(clientOptKey);
    const docArg = prop && Node.isPropertyAssignment(prop) ? prop.getInitializer() ?? null : null;
    if (docArg) {
      return { library: 'apollo', hook: `client.${hook}`, docArg, generatedName: null };
    }
  }

  // Codegen-generated hooks embed the document: use<Name>Query / ...Mutation / etc.
  const gen = /^use([A-Z]\w*?)(LazyQuery|SuspenseQuery|Query|Mutation|Subscription)$/.exec(
    hook
  );
  // Exclude known client hooks — Relay's useLazyLoadQuery/usePreloadedQuery
  // otherwise match this regex (use + "LazyLoad" + "Query") and get mislabeled.
  if (gen && !APOLLO_HOOKS.has(hook) && !URQL_HOOKS.has(hook) && !RELAY_HOOKS.has(hook)) {
    return { library: 'codegen', hook, docArg: null, generatedName: gen[1] };
  }

  // useQuery/useMutation/useSubscription exist in BOTH Apollo and urql. urql
  // passes `{ query|mutation|document: DOC }`; Apollo passes the DOC directly.
  // Disambiguate by the first argument's shape before defaulting to Apollo.
  if (URQL_HOOKS.has(hook) && args[0] && Node.isObjectLiteralExpression(args[0])) {
    const obj = args[0];
    const prop =
      obj.getProperty('query') ?? obj.getProperty('mutation') ?? obj.getProperty('document');
    const docArg =
      prop && Node.isPropertyAssignment(prop) ? prop.getInitializer() ?? null : null;
    return { library: 'urql', hook, docArg, generatedName: null };
  }
  if (APOLLO_HOOKS.has(hook)) {
    return { library: 'apollo', hook, docArg: args[0] ?? null, generatedName: null };
  }
  if (RELAY_HOOKS.has(hook)) {
    return { library: 'relay', hook, docArg: args[0] ?? null, generatedName: null };
  }
  if (REQUEST_FNS.has(hook)) {
    // graphql-request resolves to the data: request(url, DOC, vars) or client.request(DOC, vars).
    const docArg = Node.isPropertyAccessExpression(callee) ? args[0] : args[1];
    return { library: 'graphql-request', hook, docArg: docArg ?? null, generatedName: null, direct: true };
  }
  return null;
}

/** Nearest enclosing named function/component, else `<basename>`. */
function enclosingComponent(node: Node, file: string): string {
  let cur: Node | undefined = node;
  while (cur) {
    if (Node.isFunctionDeclaration(cur) && cur.getName()) return cur.getName()!;
    if (
      (Node.isArrowFunction(cur) || Node.isFunctionExpression(cur)) &&
      Node.isVariableDeclaration(cur.getParent())
    ) {
      return (cur.getParent() as any).getName();
    }
    if (Node.isMethodDeclaration(cur)) return cur.getName();
    cur = cur.getParent();
  }
  return `<${path.basename(file)}>`;
}

/** Extract the document identifier text from the hook's doc argument. */
function docIdentifier(docArg: Node | null): string | null {
  if (!docArg) return null;
  if (Node.isIdentifier(docArg)) return docArg.getText();
  // Tolerate `SomeDocument as DocumentNode` etc.
  if (Node.isAsExpression(docArg) && Node.isIdentifier(docArg.getExpression())) {
    return docArg.getExpression().getText();
  }
  return null;
}

const GQL_TAG_BASES = new Set(['gql', 'graphql', 'graphqlTag']);
function isGqlTag(tagText: string): boolean {
  const base = tagText.split('.')[0].split('(')[0];
  return GQL_TAG_BASES.has(base) || tagText.endsWith('gql');
}

/**
 * Relay commonly inlines the document: `useLazyLoadQuery(graphql`query Foo…`)`
 * or `useFragment(graphql`fragment Bar…`, ref)`. Pull the operation/fragment
 * name straight out of the template so it can be resolved by name.
 */
function inlineDocName(docArg: Node | null): string | null {
  if (docArg && Node.isTaggedTemplateExpression(docArg) && isGqlTag(docArg.getTag().getText())) {
    const m = /(?:query|mutation|subscription|fragment)\s+(\w+)/.exec(docArg.getText());
    return m ? m[1] : null;
  }
  return null;
}

/**
 * Recursively resolve a binding name — a plain identifier, or a (possibly
 * nested, possibly defaulted) object pattern — into alias entries rooted at
 * `base`. Needed because `BindingElement.getName()` returns the pattern's raw
 * source text (e.g. `"{ storeConfig }"`) rather than a usable identifier when
 * the binding is nested, silently dropping extremely common Apollo code like
 * `const { data: { storeConfig } = {} } = useQuery(...)`.
 */
function bindNamePattern(nameNode: Node, base: string, scope: Node, aliases: Alias[]): void {
  if (Node.isIdentifier(nameNode)) {
    aliases.push({ ident: nameNode.getText(), base, scope });
    return;
  }
  if (Node.isObjectBindingPattern(nameNode)) {
    for (const el of nameNode.getElements()) {
      if (el.getDotDotDotToken()) continue; // rest element — not a single field path
      const elNameNode = el.getNameNode();
      const prop =
        el.getPropertyNameNode()?.getText() ??
        (Node.isIdentifier(elNameNode) ? elNameNode.getText() : undefined);
      if (prop === undefined) continue;
      bindNamePattern(elNameNode, base ? `${base}.${prop}` : prop, scope, aliases);
    }
  }
}

/** The outermost node that still holds the call's result: through `await`, parens, `!` and `as`. */
export function resultHolder(call: CallExpression): Node {
  let holder: Node = call;
  let parent = holder.getParent();
  while (
    parent &&
    (Node.isAwaitExpression(parent) ||
      Node.isParenthesizedExpression(parent) ||
      Node.isNonNullExpression(parent) ||
      Node.isAsExpression(parent))
  ) {
    holder = parent;
    parent = holder.getParent();
  }
  return holder;
}

/** From a hook call, figure out the identifiers that hold the result data. */
function resultAliases(
  call: CallExpression,
  library: Library,
  hook: string,
  scope: Node,
  direct = false
): Alias[] {
  const aliases: Alias[] = [];
  // Only a variable initialised with the call's result itself holds the result.
  const holder = resultHolder(call);
  const holderParent = holder.getParent();
  const decl =
    holderParent && Node.isVariableDeclaration(holderParent) && holderParent.getInitializer() === holder
      ? holderParent
      : undefined;
  const nameNode = decl?.getNameNode();

  // Read straight off the call: useQuery(DOC).data?.page, (await fetch()).user
  if (holderParent && Node.isPropertyAccessExpression(holderParent) && holderParent.getExpression() === holder) {
    aliases.push({ ident: '', node: holder, base: '', scope, viaData: !direct && library !== 'relay' && hook !== 'useFragment' });
  }

  const pushObjData = (objPattern: Node, altScope?: Node) => {
    if (!Node.isObjectBindingPattern(objPattern)) return;
    for (const el of objPattern.getElements()) {
      const prop = el.getPropertyNameNode()?.getText() ?? el.getName();
      if (prop === 'data') bindNamePattern(el.getNameNode(), '', altScope ?? scope, aliases);
    }
  };

  if (nameNode && direct) {
    // The result IS the data: const data = await request(...) / const { user } = await ...
    bindNamePattern(nameNode, '', scope, aliases);
  } else if (nameNode) {
    if (Node.isObjectBindingPattern(nameNode)) {
      // Apollo: const { data } = useQuery(...)  /  const { data: { user } = {} } = ...
      pushObjData(nameNode);
    } else if (Node.isArrayBindingPattern(nameNode)) {
      const els = nameNode.getElements();
      if (library === 'urql') {
        // urql result is the FIRST tuple element: const [{ data }] = useQuery()
        // or const [result] = useQuery() → result.data.<field>
        const first = els[0];
        if (first && Node.isBindingElement(first)) {
          const nn = first.getNameNode();
          if (Node.isObjectBindingPattern(nn)) pushObjData(nn);
          else if (Node.isIdentifier(nn)) {
            aliases.push({ ident: nn.getText(), base: '', scope, viaData: true });
          }
        }
      } else {
        // Apollo mutation: const [mutate, { data }] = useMutation(...)
        const second = els[1];
        if (second && Node.isBindingElement(second)) pushObjData(second.getNameNode());
      }
    } else if (Node.isIdentifier(nameNode)) {
      if (hook === 'useFragment' || library === 'relay') {
        // useFragment returns the data object directly.
        aliases.push({ ident: nameNode.getText(), base: '', scope });
      } else {
        // const result = useQuery(...)  → result.data.<field>
        aliases.push({ ident: nameNode.getText(), base: '', scope, viaData: true });
      }
    }
  }

  // onCompleted / onData callbacks receive the result as their first param.
  const optsArg = call.getArguments().find((a) => Node.isObjectLiteralExpression(a));
  if (optsArg && Node.isObjectLiteralExpression(optsArg)) {
    for (const prop of optsArg.getProperties()) {
      if (!Node.isPropertyAssignment(prop) && !Node.isMethodDeclaration(prop)) continue;
      const key = (prop as any).getName?.();
      if (!RESULT_CALLBACKS.has(key)) continue;
      const fn = Node.isPropertyAssignment(prop) ? prop.getInitializer() : prop;
      if (fn && (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isMethodDeclaration(fn))) {
        const p0 = (fn as any).getParameters?.()[0];
        const body = (fn as any).getBody?.() ?? fn;
        if (p0 && Node.isIdentifier(p0.getNameNode())) {
          aliases.push({ ident: p0.getName(), base: '', scope: body });
        }
      }
    }
  }

  // Promise chaining on imperative calls: client.query(opts).then(({ data }) => ...)
  // or .then((result) => result.data...). Direct calls: request(...).then((data) => ...).
  const thenAccess = call.getParent();
  if (Node.isPropertyAccessExpression(thenAccess) && thenAccess.getName() === 'then') {
    const thenCall = thenAccess.getParent();
    if (Node.isCallExpression(thenCall) && thenCall.getExpression() === thenAccess) {
      const cb = thenCall.getArguments()[0];
      if (cb && (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb))) {
        const p0 = cb.getParameters()[0];
        if (p0) {
          const pn = p0.getNameNode();
          const body = cb.getBody();
          if (direct) {
            bindNamePattern(pn, '', body, aliases);
          } else if (Node.isIdentifier(pn)) {
            aliases.push({ ident: pn.getText(), base: '', scope: body, viaData: true });
          } else if (Node.isObjectBindingPattern(pn)) {
            pushObjData(pn, body);
          }
        }
      }
    }
  }

  return aliases;
}

/** Global functions passed as callbacks (`.filter(Boolean)`) that read no fields. */
const BUILTIN_CALLBACKS = new Set(['Boolean', 'String', 'Number', 'isFinite', 'isNaN', 'parseInt', 'parseFloat']);

/** A same-file function declared by name: `function add(c) {}` or `const add = (c) => …`. */
function localFunction(name: string, from: Node): Node | null {
  const sf = from.getSourceFile();
  const fn = sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration).find((f) => f.getName() === name);
  if (fn) return fn;
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (decl.getName() !== name) continue;
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return init;
  }
  return null;
}

/**
 * Bind an iteration callback's element param(s) as aliases rooted at `base`.
 * Returns false when the callback can't be followed (e.g. a function imported
 * from another file), so the caller treats the elements as handed off whole.
 */
function bindCallbackParams(
  call: CallExpression,
  base: string,
  method: string,
  queue: Alias[]
): boolean {
  let cb: Node | undefined = call.getArguments()[0];
  if (cb && Node.isIdentifier(cb)) {
    if (BUILTIN_CALLBACKS.has(cb.getText())) return true;
    const resolved = localFunction(cb.getText(), cb);
    if (!resolved) return false;
    cb = resolved;
  }
  if (!cb || !(Node.isArrowFunction(cb) || Node.isFunctionExpression(cb) || Node.isFunctionDeclaration(cb))) {
    return true;
  }
  const body = cb.getBody();
  if (!body) return true;
  const params = cb.getParameters();
  const elementParams = REDUCE_METHODS.has(method)
    ? [params[1]]
    : method === 'sort'
    ? [params[0], params[1]]
    : [params[0]];

  for (const p of elementParams) {
    if (!p) continue;
    const pn = p.getNameNode();
    if (Node.isIdentifier(pn)) {
      queue.push({ ident: pn.getText(), base, scope: body });
    } else if (Node.isObjectBindingPattern(pn)) {
      for (const el of pn.getElements()) {
        if (el.getDotDotDotToken()) continue;
        const elNameNode = el.getNameNode();
        const prop =
          el.getPropertyNameNode()?.getText() ??
          (Node.isIdentifier(elNameNode) ? elNameNode.getText() : undefined);
        if (prop === undefined) continue;
        bindNamePattern(elNameNode, base ? `${base}.${prop}` : prop, body, queue);
      }
    }
  }
  return true;
}

/** Hooks whose last argument is a dependency array: listing a value there reads nothing. */
const DEPENDENCY_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useMemo', 'useCallback', 'useInsertionEffect']);

function isDependencyArray(node: Node): boolean {
  const call = node.getParent();
  if (!call || !Node.isCallExpression(call)) return false;
  const callee = call.getExpression();
  const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
  const args = call.getArguments();
  return DEPENDENCY_HOOKS.has(name) && args[args.length - 1] === node;
}

const WHOLE_OBJECT_PARENTS = new Set([
  SyntaxKind.JsxExpression,
  SyntaxKind.CallExpression,
  SyntaxKind.SpreadAssignment,
  SyntaxKind.SpreadElement,
  SyntaxKind.ReturnStatement,
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.ShorthandPropertyAssignment, // return { selectedPaymentMethod }
  SyntaxKind.JsxSpreadAttribute,
]);

/**
 * Walk every reference to `alias.ident` within its scope, following member
 * chains, iteration callbacks, and re-aliasing, recording which response-key
 * paths are read (`accessed`) and which subtrees are handed off whole
 * (`passthrough`).
 */
function collectAccesses(
  alias: Alias,
  accessed: Set<string>,
  passthrough: Set<string>,
  queue: Alias[]
): void {
  const refs: Node[] = alias.node
    ? [alias.node]
    : alias.scope
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .filter((id) => id.getText() === alias.ident);

  for (const ref of refs) {
    // Skip the declaration site itself.
    const p = ref.getParent();
    if (
      p &&
      (Node.isVariableDeclaration(p) ||
        Node.isBindingElement(p) ||
        Node.isParameterDeclaration(p) ||
        Node.isPropertyAssignment(p))
    ) {
      // Only skip when the identifier is the *name* being declared.
      const nameNode = (p as any).getNameNode?.();
      if (nameNode === ref) continue;
    }

    let cur: Node = ref;
    let curPath = alias.base;
    let sawData = !alias.viaData;

    // Walk up the member-access / index chain.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const parent = cur.getParent();
      if (!parent) break;

      if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === cur) {
        const name = parent.getName();
        const gp = parent.getParent();
        const isMethodCall =
          gp && Node.isCallExpression(gp) && gp.getExpression() === parent;

        if (isMethodCall) {
          const call = gp as CallExpression;
          if (CB_ELEMENT_METHODS.has(name) || REDUCE_METHODS.has(name)) {
            if (!bindCallbackParams(call, curPath, name, queue)) passthrough.add(curPath);
          }
          if (curPath) accessed.add(curPath);
          if (SHAPE_PRESERVING.has(name)) {
            // e.g. list.filter(...) → keep walking; result carries the same element shape.
            cur = call;
            continue;
          }
          break;
        }

        // Plain field access — extend the path (skip the leading `.data`).
        if (!sawData) {
          if (name === 'data') {
            sawData = true;
            cur = parent;
            continue;
          }
          break; // result.loading etc. — not part of the data tree
        }
        curPath = curPath ? `${curPath}.${name}` : name;
        cur = parent;
        continue;
      }

      if (Node.isElementAccessExpression(parent) && parent.getExpression() === cur) {
        cur = parent; // list[0] — index into a list, path unchanged
        continue;
      }
      if (
        Node.isNonNullExpression(parent) ||
        Node.isParenthesizedExpression(parent) ||
        Node.isAsExpression(parent) ||
        Node.isAwaitExpression(parent) // const r = client.query(...); … (await r).data
      ) {
        cur = parent;
        continue;
      }
      // `a || b`, `a ?? b`, `a && b`, and ternary branches are transparent —
      // the chain result flows through them (e.g. `x?.items?.filter() || []`).
      if (Node.isBinaryExpression(parent)) {
        const op = parent.getOperatorToken().getText();
        if ((op === '||' || op === '??' || op === '&&') &&
          (parent.getLeft() === cur || parent.getRight() === cur)) {
          cur = parent;
          continue;
        }
      }
      if (
        Node.isConditionalExpression(parent) &&
        (parent.getWhenTrue() === cur || parent.getWhenFalse() === cur)
      ) {
        cur = parent;
        continue;
      }
      break;
    }

    // How is the chain endpoint consumed?
    const endParent = cur.getParent();

    if (!sawData) {
      // The whole result moved to another variable before `.data` was read:
      // const r2 = await r  /  const { data } = await r
      if (endParent && Node.isVariableDeclaration(endParent) && endParent.getInitializer() === cur) {
        const bn = endParent.getNameNode();
        if (Node.isIdentifier(bn)) {
          queue.push({ ident: bn.getText(), base: curPath, scope: alias.scope, viaData: true });
        } else if (Node.isObjectBindingPattern(bn)) {
          for (const el of bn.getElements()) {
            const prop = el.getPropertyNameNode()?.getText() ?? el.getName();
            if (prop === 'data') bindNamePattern(el.getNameNode(), curPath, alias.scope, queue);
          }
        }
      }
      continue; // never reached the data tree (e.g. `result.loading`)
    }

    // const x = <chain>  → re-alias
    if (endParent && Node.isVariableDeclaration(endParent) && endParent.getInitializer() === cur) {
      const bn = endParent.getNameNode();
      if (Node.isIdentifier(bn)) {
        queue.push({ ident: bn.getText(), base: curPath, scope: alias.scope });
      } else if (Node.isObjectBindingPattern(bn)) {
        for (const el of bn.getElements()) {
          if (el.getDotDotDotToken()) continue;
          const elNameNode = el.getNameNode();
          const prop =
            el.getPropertyNameNode()?.getText() ??
            (Node.isIdentifier(elNameNode) ? elNameNode.getText() : undefined);
          if (prop === undefined) continue;
          bindNamePattern(elNameNode, curPath ? `${curPath}.${prop}` : prop, alias.scope, queue);
        }
      }
      if (curPath) accessed.add(curPath);
      continue;
    }

    // Handed off as a whole object/subtree → treat it as used. `curPath` may
    // legitimately be '' here (the entire operation result passed on wholesale,
    // e.g. `return { storeConfig: data }`) — must not be dropped just because
    // '' is falsy.
    // obj.children = <chain>: the subtree now lives on another object we don't follow.
    if (
      endParent &&
      Node.isBinaryExpression(endParent) &&
      endParent.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
      endParent.getRight() === cur
    ) {
      passthrough.add(curPath);
      if (curPath) accessed.add(curPath);
      continue;
    }

    // useEffect(fn, [data.items]) only compares the value; it reads no fields.
    if (endParent && Node.isArrayLiteralExpression(endParent) && isDependencyArray(endParent)) {
      if (curPath) accessed.add(curPath);
      continue;
    }

    if (endParent && WHOLE_OBJECT_PARENTS.has(endParent.getKind())) {
      passthrough.add(curPath);
      if (curPath) accessed.add(curPath);
    } else if (curPath) {
      accessed.add(curPath);
    }
  }
}

/**
 * Every identifier referenced as a *value* across the project (call arguments,
 * object-literal values, named imports) plus generated-hook operation names.
 *
 * This deliberately over-collects: it's the signal for "this GraphQL document
 * is used *somewhere*", even through custom wrapper hooks, Venia operations-map
 * objects, or duplicate definitions that share a name. Declaration name nodes
 * are never in these positions, so an identifier here always means a reference.
 */
export function collectReferencedNames(project: Project): Set<string> {
  const names = new Set<string>();
  const add = (t?: string | null) => {
    if (t) names.add(t);
  };

  for (const sf of project.getSourceFiles()) {
    for (const imp of sf.getImportDeclarations()) {
      for (const ni of imp.getNamedImports()) {
        const name = ni.getNameNode().getText();
        add(name);
        const gen = GENERATED_HOOK_RE.exec(name);
        if (gen) add(gen[1]); // import { useGetUserQuery } → GetUser
      }
    }
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const hookName = Node.isIdentifier(callee)
        ? callee.getText()
        : Node.isPropertyAccessExpression(callee)
        ? callee.getName()
        : '';
      const gen = GENERATED_HOOK_RE.exec(hookName);
      if (gen) add(gen[1]); // useGetUserQuery → GetUser
      for (const arg of call.getArguments()) {
        if (Node.isIdentifier(arg)) add(arg.getText());
        else if (Node.isObjectLiteralExpression(arg)) {
          for (const p of arg.getProperties()) {
            if (Node.isPropertyAssignment(p)) {
              const init = p.getInitializer();
              if (init && Node.isIdentifier(init)) add(init.getText());
            }
          }
        } else {
          // Inline documents: useLazyLoadQuery(graphql`query Foo…`) (Relay).
          add(inlineDocName(arg));
        }
      }
    }
    // Operation-map objects: `{ getFooData: GET_FOO }` (Venia mergeOperations pattern).
    for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      const init = pa.getInitializer();
      if (init && Node.isIdentifier(init)) add(init.getText());
    }
  }
  return names;
}

/**
 * Field names the app's Apollo cache keys objects by: string entries of any
 * `keyFields: [...]` (typePolicies). Reported as unused, they'd break caching.
 */
export function collectCacheKeyFields(project: Project): Set<string> {
  const keys = new Set<string>();
  for (const sf of project.getSourceFiles()) {
    for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      if (pa.getName() !== 'keyFields') continue;
      const init = pa.getInitializer();
      if (!init || !Node.isArrayLiteralExpression(init)) continue;
      for (const s of init.getDescendantsOfKind(SyntaxKind.StringLiteral)) keys.add(s.getLiteralText());
    }
  }
  return keys;
}

/** True when the call site uses a client without a normalized cache. */
export function isNoCacheUsage(u: HookUsage): boolean {
  return u.library === 'graphql-request' || u.hook.endsWith('.fetcher');
}

/** Build the operation/fragment → component usage map for the whole project. */
export function mapComponents(
  project: Project,
  operations: GraphQLOperation[],
  fragments: GraphQLFragment[],
  bindings: DocBinding[]
): HookUsage[] {
  const { resolveOp, resolveFrag } = buildResolvers(operations, fragments, bindings);
  const usages: HookUsage[] = [];

  for (const sf of project.getSourceFiles()) {
    const file = sf.getFilePath();
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const classified = classifyCall(call);
      if (!classified) continue;
      const { library, hook, docArg, generatedName, direct } = classified;

      const identifier = generatedName ?? docIdentifier(docArg) ?? inlineDocName(docArg);
      const isFragmentHook = hook === 'useFragment';
      const op = isFragmentHook ? null : resolveOp(identifier);
      const frag = isFragmentHook ? resolveFrag(identifier) : null;

      const operationName = op?.name ?? frag?.name ?? generatedName ?? identifier ?? null;

      const scope: Node =
        call.getFirstAncestorByKind(SyntaxKind.Block) ??
        call.getFirstAncestorByKind(SyntaxKind.ArrowFunction) ??
        sf;

      const accessed = new Set<string>();
      const passthrough = new Set<string>();
      const queue = resultAliases(call, library, hook, scope, direct);
      const hasResultAliases = queue.length > 0;
      const guard = new Set<string>();
      // Recursive callbacks (cat.children.forEach(add) inside add) deepen the path
      // each round; stop once it's deeper than any document could be.
      const maxDepth = (op?.depth ?? 20) + 1;
      while (queue.length) {
        const a = queue.shift()!;
        const key = `${a.ident}|${a.base}`;
        if (guard.has(key) || a.base.split('.').length > maxDepth) continue;
        guard.add(key);
        collectAccesses(a, accessed, passthrough, queue);
      }

      // `await request(...);` — the selection is fetched and dropped. Only for
      // clients without a normalized cache: with Apollo/urql/Relay a discarded
      // mutation result still updates the cache, so selecting fields can be deliberate.
      const holderParent = resultHolder(call).getParent();
      const resultDiscarded =
        NO_CACHE_LIBRARIES.has(library) &&
        !!holderParent &&
        (Node.isExpressionStatement(holderParent) || Node.isVoidExpression(holderParent)) &&
        !hasResultAliases &&
        accessed.size === 0 &&
        passthrough.size === 0;

      usages.push({
        hook,
        library,
        operationName,
        documentIdentifier: identifier,
        component: enclosingComponent(call, file),
        file,
        line: call.getStartLineNumber(),
        accessedPaths: Array.from(accessed),
        passthroughPaths: Array.from(passthrough),
        ...(resultDiscarded ? { resultDiscarded } : {}),
      });
    }
  }

  return usages;
}
