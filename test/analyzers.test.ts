import { describe, it, expect } from 'vitest';
import path from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { Project } from 'ts-morph';
import { buildSchema } from 'graphql';
import { extractTaggedTemplates } from '../src/parsers/graphql-files';
import { buildModel } from '../src/parsers/operations';
import { mapComponents, collectReferencedNames } from '../src/analyzers/component-map';
import { analyzeOverfetch } from '../src/analyzers/overfetch';
import { findDeadQueries } from '../src/analyzers/dead-queries';
import { findDuplicates } from '../src/analyzers/duplicates';
import { analyzeGeneratedTypes } from '../src/analyzers/generated-types';
import { analyzeComplexity } from '../src/analyzers/complexity';
import { analyzeSchemaDrift } from '../src/analyzers/schema-drift';
import { analyzeImpact } from '../src/analyzers/impact';
import { detectProject } from '../src/parsers/project';
import { scan } from '../src/core/scan';
import { parseFailOn, evaluateFailOn } from '../src/core/fail-on';
import { setQuiet } from '../src/utils/logger';

function projectOf(files: Record<string, string>) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, jsx: 2 },
  });
  for (const [name, text] of Object.entries(files)) project.createSourceFile(name, text);
  return project;
}

function analyze(files: Record<string, string>) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, jsx: 2 /* react */ },
  });
  for (const [name, text] of Object.entries(files)) project.createSourceFile(name, text);
  const errors: any[] = [];
  const { defs, bindings } = extractTaggedTemplates(project, errors);
  const { operations, fragments } = buildModel(defs);
  const usages = mapComponents(project, operations, fragments, bindings);
  const referencedNames = collectReferencedNames(project);
  return { operations, fragments, usages, bindings, referencedNames, errors };
}

const QUERIES = `
import { gql } from '@apollo/client';
export const GET_USER = gql\`
  query GetUser {
    user { id name email avatar { url alt } }
  }
\`;
export const GET_POSTS = gql\`
  query GetPosts { posts { id title } }
\`;
`;

describe('overfetch analyzer', () => {
  it('flags requested fields the component never reads', () => {
    const { operations, fragments, usages, bindings } = analyze({
      'queries.ts': QUERIES,
      'UserCard.tsx': `
        import { useQuery } from '@apollo/client';
        import { GET_USER } from './queries';
        export function UserCard() {
          const { data } = useQuery(GET_USER);
          const name = data?.user?.name;
          return name;
        }
      `,
      // GET_POSTS is intentionally unused (dead query, not overfetch).
    });

    const findings = analyzeOverfetch(operations, fragments, usages, bindings);
    const user = findings.find((f) => f.operation === 'GetUser');
    expect(user).toBeTruthy();
    const unusedPaths = user!.unused.map((u) => u.path);
    expect(unusedPaths).toContain('user.id');
    expect(unusedPaths).toContain('user.email');
    expect(unusedPaths).toContain('user.avatar.url');
    expect(unusedPaths).not.toContain('user.name');
    expect(user!.estimatedReductionPct).toBeGreaterThan(50);
  });

  it('does NOT flag fields passed through wholesale (custom-hook / child component)', () => {
    const { operations, fragments, usages, bindings } = analyze({
      'queries.ts': QUERIES,
      'UserRaw.tsx': `
        import { useQuery } from '@apollo/client';
        import { GET_USER } from './queries';
        function render(x) { return x; }
        export function UserRaw() {
          const { data } = useQuery(GET_USER);
          return render(data?.user);
        }
      `,
    });
    const findings = analyzeOverfetch(operations, fragments, usages, bindings);
    // `data.user` handed to a function → whole subtree treated as used.
    expect(findings.find((f) => f.operation === 'GetUser')).toBeFalsy();
  });

  it('captures reads inside .map() callbacks', () => {
    const { operations, fragments, usages, bindings } = analyze({
      'q.ts': `
        import { gql } from '@apollo/client';
        export const LIST = gql\`query List { posts { id title body author { name } } }\`;
      `,
      'List.tsx': `
        import { useQuery } from '@apollo/client';
        import { LIST } from './q';
        export function List() {
          const { data } = useQuery(LIST);
          return data?.posts?.map(p => p.title);
        }
      `,
    });
    const findings = analyzeOverfetch(operations, fragments, usages, bindings);
    const f = findings.find((x) => x.operation === 'List');
    expect(f).toBeTruthy();
    const paths = f!.unused.map((u) => u.path);
    expect(paths).toContain('posts.id');
    expect(paths).toContain('posts.body');
    expect(paths).toContain('posts.author.name');
    expect(paths).not.toContain('posts.title'); // read inside the map callback
  });
});

describe('dead queries', () => {
  it('flags operations no code references', () => {
    const { operations, referencedNames } = analyze({
      'queries.ts': QUERIES,
      'UserCard.tsx': `
        import { useQuery } from '@apollo/client';
        import { GET_USER } from './queries';
        export function UserCard() { const { data } = useQuery(GET_USER); return data; }
      `,
    });
    const dead = findDeadQueries(operations, referencedNames);
    expect(dead.map((o) => o.name)).toContain('GetPosts');
    expect(dead.map((o) => o.name)).not.toContain('GetUser');
  });

  it('does NOT flag a query used only via a custom wrapper hook or operations-map', () => {
    const { operations, referencedNames } = analyze({
      'queries.ts': QUERIES,
      // GET_USER goes through a custom hook; GET_POSTS is registered in an
      // operations-map object and consumed by property access elsewhere.
      'wrapper.ts': `
        import { GET_USER, GET_POSTS } from './queries';
        function useCustomerQuery(doc: any) { return doc; }
        export const ops = { getPosts: GET_POSTS };
        export function useThings() { return useCustomerQuery(GET_USER); }
      `,
    });
    const dead = findDeadQueries(operations, referencedNames).map((o) => o.name);
    expect(dead).not.toContain('GetUser'); // via wrapper hook (call arg)
    expect(dead).not.toContain('GetPosts'); // via operations-map value
  });
});

describe('duplicates & unused variables', () => {
  it('detects identical field sets and unused variables', () => {
    const { operations } = analyze({
      'dupes.ts': `
        import { gql } from '@apollo/client';
        export const A = gql\`query A { user { id name } }\`;
        export const B = gql\`query B { user { id name } }\`;
        export const C = gql\`query C($id: ID!, $unused: String) { node(id: $id) { id } }\`;
      `,
    });
    const dups = findDuplicates(operations);
    expect(dups.some((g) => g.similarity === 1 && g.members.length === 2)).toBe(true);

    const c = operations.find((o) => o.name === 'C');
    expect(c?.unusedVariables).toEqual(['unused']);
  });
});

describe('generated type usage', () => {
  it('counts a type reachable via a used Document const as used, flags orphans', () => {
    const project = projectOf({
      'x.gql.ts': `
        export type GetUserQuery = { user: { id: string; name: string } };
        export type GetUserQueryVariables = { id: string };
        export type OrphanFragment = { foo: string };
        export const GetUserDocument = {} as unknown as DocumentNode<GetUserQuery, GetUserQueryVariables>;
      `,
      'App.tsx': `
        import { GetUserDocument } from './x.gql';
        export function App() { return GetUserDocument; }
      `,
    });
    const report = analyzeGeneratedTypes(project, '/');
    expect(report.found).toBe(true);
    expect(report.total).toBe(3);
    expect(report.unused.map((u) => u.name)).toEqual(['OrphanFragment']);
    expect(report.used).toBe(2); // GetUserQuery + GetUserQueryVariables via the imported Document
  });

  it('reports found=false when there is no codegen output', () => {
    const report = analyzeGeneratedTypes(projectOf({ 'a.ts': 'export const x = 1;' }), '/');
    expect(report.found).toBe(false);
  });
});

describe('complexity', () => {
  it('rates deep queries high-risk and shallow ones low', () => {
    const { operations } = analyze({
      'q.ts': `
        import { gql } from '@apollo/client';
        export const DEEP = gql\`query Deep { a { b { c { d { e { f { g { h { i } } } } } } } } }\`;
        export const FLAT = gql\`query Flat { x y z }\`;
      `,
    });
    const reports = analyzeComplexity(operations);
    const deep = reports.find((r) => r.operation === 'Deep')!;
    const flat = reports.find((r) => r.operation === 'Flat')!;
    expect(deep.depth).toBe(9);
    expect(deep.risk).toBe('high');
    expect(flat.risk).toBe('low');
    expect(reports[0].operation).toBe('Deep'); // sorted by depth desc
  });
});

describe('schema drift', () => {
  const schema = buildSchema(`
    type Query { user: User }
    type User { id: ID! name: String }
  `);

  it('flags requested fields the schema no longer has', () => {
    const { operations, fragments } = analyze({
      'q.ts': `
        import { gql } from '@apollo/client';
        export const Q = gql\`query Q { user { id name removedField } }\`;
      `,
    });
    const drift = analyzeSchemaDrift(schema, operations, fragments);
    expect(drift.length).toBeGreaterThan(0);
    expect(drift[0].message).toMatch(/removedField/);
  });

  it('reports no drift for a valid operation', () => {
    const { operations, fragments } = analyze({
      'q.ts': `
        import { gql } from '@apollo/client';
        export const Q = gql\`query Q { user { id name } }\`;
      `,
    });
    expect(analyzeSchemaDrift(schema, operations, fragments)).toHaveLength(0);
  });

  it('returns nothing when no schema is provided', () => {
    const { operations, fragments } = analyze({
      'q.ts': `import { gql } from '@apollo/client'; export const Q = gql\`query Q { anything }\`;`,
    });
    expect(analyzeSchemaDrift(null, operations, fragments)).toHaveLength(0);
  });
});

describe('impact', () => {
  it('finds operations and components affected by a field', () => {
    const { operations, fragments, usages } = analyze({
      'q.ts': `
        import { gql } from '@apollo/client';
        export const GET_PROD = gql\`query GetProd { product { id price name } }\`;
        export const GET_CAT = gql\`query GetCat { category { id title } }\`;
      `,
      'ProductView.tsx': `
        import { useQuery } from '@apollo/client';
        import { GET_PROD } from './q';
        export function ProductView() { const { data } = useQuery(GET_PROD); return data; }
      `,
    });
    const impact = analyzeImpact(operations, fragments, usages, 'Product.price');
    expect(impact.field).toBe('price');
    expect(impact.operations).toContain('GetProd');
    expect(impact.operations).not.toContain('GetCat');
    expect(impact.components).toContain('ProductView');
  });
});

describe('project detection', () => {
  it('detects client libs and codegen from a real fixture', () => {
    const root = path.resolve('test/fixtures/detect');
    const info = detectProject(root);
    expect(info.detected).toContain('Apollo Client');
    expect(info.detected).toContain('Next.js');
    expect(info.hasCodegen).toBe(true);
  });
});

describe('urql', () => {
  it('resolves useQuery({ query }) and flags overfetch (not Apollo mis-parse)', () => {
    const { operations, fragments, usages, bindings, referencedNames } = analyze({
      'q.ts': `
        import { gql } from 'urql';
        export const GET_USER = gql\`query GetUser { user { id name email } }\`;
      `,
      'C.tsx': `
        import { useQuery } from 'urql';
        import { GET_USER } from './q';
        export function C() {
          const [{ data }] = useQuery({ query: GET_USER });
          return data?.user?.name;
        }
      `,
    });
    const f = analyzeOverfetch(operations, fragments, usages, bindings).find(
      (x) => x.operation === 'GetUser'
    );
    expect(f).toBeTruthy();
    const paths = f!.unused.map((u) => u.path);
    expect(paths).toContain('user.id');
    expect(paths).toContain('user.email');
    expect(paths).not.toContain('user.name');
    expect(findDeadQueries(operations, referencedNames).map((o) => o.name)).not.toContain(
      'GetUser'
    );
  });
});

describe('Apollo Client imperative API', () => {
  it('resolves client.query({ query }) awaited + destructured, flags overfetch', () => {
    const { operations, fragments, usages, bindings } = analyze({
      'q.ts': `
        import { gql } from '@apollo/client';
        export const GET_STORE_CONFIG = gql\`query storeConfig { storeConfig { id base_url amxnotif_stock_placeholder } }\`;
      `,
      'service.ts': `
        import { GET_STORE_CONFIG } from './q';
        export async function fetchPageData(client) {
          const { data } = await client.query({ query: GET_STORE_CONFIG });
          return data?.storeConfig?.id;
        }
      `,
    });
    const f = analyzeOverfetch(operations, fragments, usages, bindings).find(
      (x) => x.operation === 'storeConfig'
    );
    expect(f).toBeTruthy();
    const paths = f!.unused.map((u) => u.path);
    expect(paths).toContain('storeConfig.base_url');
    expect(paths).toContain('storeConfig.amxnotif_stock_placeholder');
    expect(paths).not.toContain('storeConfig.id');
  });

  it('does NOT flag fields when the whole result is passed through wholesale (SSR props hand-off)', () => {
    const { operations, fragments, usages, bindings } = analyze({
      'q.ts': `
        import { gql } from '@apollo/client';
        export const GET_STORE_CONFIG = gql\`query storeConfig { storeConfig { id base_url amxnotif_stock_placeholder } }\`;
      `,
      'service.ts': `
        import { GET_STORE_CONFIG } from './q';
        export async function fetchPageData(client) {
          const { data } = await client.query({ query: GET_STORE_CONFIG });
          return { category: null, storeConfig: data, token: 'x' };
        }
      `,
    });
    // The whole query result is handed off as a page-props value (\`storeConfig: data\`)
    // — this is a real passthrough and must not be reported as 100% overfetch.
    expect(analyzeOverfetch(operations, fragments, usages, bindings).find(
      (x) => x.operation === 'storeConfig'
    )).toBeFalsy();
  });

  it('resolves client.query(...).then(({ data }) => ...) promise chaining', () => {
    const { operations, fragments, usages, bindings } = analyze({
      'q.ts': `
        import { gql } from '@apollo/client';
        export const GET_USER = gql\`query GetUser { user { id name email } }\`;
      `,
      'service.ts': `
        import { GET_USER } from './q';
        export function loadUser(client) {
          return client.query({ query: GET_USER }).then(({ data }) => data?.user?.name);
        }
      `,
    });
    const f = analyzeOverfetch(operations, fragments, usages, bindings).find(
      (x) => x.operation === 'GetUser'
    );
    expect(f).toBeTruthy();
    const paths = f!.unused.map((u) => u.path);
    expect(paths).toContain('user.id');
    expect(paths).toContain('user.email');
    expect(paths).not.toContain('user.name');
  });
});

describe('nested destructuring with defaults', () => {
  it('traces reads through `const { data: { storeConfig } = {} } = useQuery(...)`', () => {
    const { operations, fragments, usages, bindings } = analyze({
      'q.ts': `
        import { gql } from '@apollo/client';
        export const GET_STORE_CONFIG = gql\`query storeConfig { storeConfig { id base_url amxnotif_stock_placeholder } }\`;
      `,
      'Comp.tsx': `
        import { useQuery } from '@apollo/client';
        import { GET_STORE_CONFIG } from './q';
        export function Comp() {
          const { data: { storeConfig } = {} } = useQuery(GET_STORE_CONFIG);
          return storeConfig?.amxnotif_stock_placeholder ? null : storeConfig?.id;
        }
      `,
    });
    const f = analyzeOverfetch(operations, fragments, usages, bindings).find(
      (x) => x.operation === 'storeConfig'
    );
    expect(f).toBeTruthy();
    const paths = f!.unused.map((u) => u.path);
    expect(paths).toContain('storeConfig.base_url');
    expect(paths).not.toContain('storeConfig.id');
    expect(paths).not.toContain('storeConfig.amxnotif_stock_placeholder');
  });
});

describe('relay', () => {
  it('resolves an inline graphql`` query in useLazyLoadQuery and flags overfetch', () => {
    const { operations, fragments, usages, bindings, referencedNames } = analyze({
      'C.tsx': `
        import { useLazyLoadQuery, graphql } from 'react-relay';
        export function C() {
          const data = useLazyLoadQuery(
            graphql\`query CScreenQuery { viewer { id name email } }\`,
            {}
          );
          return data?.viewer?.name;
        }
      `,
    });
    const f = analyzeOverfetch(operations, fragments, usages, bindings).find(
      (x) => x.operation === 'CScreenQuery'
    );
    expect(f).toBeTruthy();
    const paths = f!.unused.map((u) => u.path);
    expect(paths).toContain('viewer.id');
    expect(paths).toContain('viewer.email');
    expect(paths).not.toContain('viewer.name');
    expect(findDeadQueries(operations, referencedNames).map((o) => o.name)).not.toContain(
      'CScreenQuery'
    );
  });
});

describe('scan --ignore', () => {
  it('excludes ignored TS/JS source files, not just .graphql files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gqo-ignore-'));
    mkdirSync(path.join(root, 'src/generated'), { recursive: true });
    mkdirSync(path.join(root, 'src/pages'), { recursive: true });
    writeFileSync(path.join(root, 'src/App.tsx'), 'export const App = () => null;');
    writeFileSync(path.join(root, 'src/pages/[id].tsx'), 'export default () => null;');
    writeFileSync(
      path.join(root, 'src/generated/q.ts'),
      'import { gql } from "@apollo/client";\nexport const Q = gql`query Gen { a }`;'
    );
    setQuiet(true);
    try {
      const all = scan({ cwd: root, schema: null });
      expect(all.analysis.stats.sourceFiles).toBe(3);
      expect(all.analysis.operations.map((o) => o.name)).toContain('Gen');

      const ignored = scan({ cwd: root, schema: null, ignore: ['src/generated/**'] });
      expect(ignored.analysis.stats.sourceFiles).toBe(2);
      expect(ignored.analysis.operations.map((o) => o.name)).not.toContain('Gen');
    } finally {
      setQuiet(false);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('--fail-on', () => {
  const makeFixture = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gqo-failon-'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(
      path.join(root, 'src/q.ts'),
      `import { gql } from '@apollo/client';
export const GET_USER = gql\`query GetUser { user { id name } }\`;
export const DEAD = gql\`query Dead { a }\`;`
    );
    writeFileSync(
      path.join(root, 'src/C.tsx'),
      `import { useQuery } from '@apollo/client';
import { GET_USER } from './q';
export function C() {
  const { data } = useQuery(GET_USER);
  return data?.user?.name;
}`
    );
    return root;
  };

  it('parses comma-separated checks and rejects unknown ones', () => {
    expect(parseFailOn(undefined)).toEqual([]);
    expect(parseFailOn('overfetch, dead-queries,overfetch')).toEqual(['overfetch', 'dead-queries']);
    expect(() => parseFailOn('dead-query')).toThrow(/unknown check "dead-query".*dead-queries/);
    expect(() => parseFailOn('')).toThrow(/Valid checks/);
  });

  it('counts findings per check and refuses checks that cannot run', () => {
    const root = makeFixture();
    setQuiet(true);
    try {
      const { analysis } = scan({ cwd: root, schema: null });
      expect(evaluateFailOn(analysis, ['dead-queries', 'complexity'])).toEqual([
        { check: 'dead-queries', count: 1 },
        { check: 'complexity', count: 0 },
      ]);
      expect(() => evaluateFailOn(analysis, ['schema-drift'])).toThrow(/needs a schema/);
      expect(() => evaluateFailOn(analysis, ['unused-types'])).toThrow(/Code Generator/);
    } finally {
      setQuiet(false);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sets the CLI exit code: 1 on findings, 0 when clean, 2 on bad input', () => {
    const root = makeFixture();
    const cli = (...args: string[]) =>
      spawnSync(path.resolve('node_modules/.bin/tsx'), [path.resolve('src/cli.ts'), ...args], {
        encoding: 'utf8',
      });
    try {
      const failing = cli('unused', root, '--json', '--fail-on', 'dead-queries');
      expect(failing.status).toBe(1);
      expect(JSON.parse(failing.stdout).deadQueries).toEqual(['Dead']);
      expect(failing.stderr).toContain('dead-queries (1)');

      expect(cli('unused', root, '--fail-on', 'complexity').status).toBe(0);
      expect(cli('unused', root).status).toBe(0);

      const bad = cli('unused', root, '--fail-on', 'nope');
      expect(bad.status).toBe(2);
      expect(bad.stderr).toContain('Valid checks');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

describe('direct-result fetchers', () => {
  const MENU = `
    import { gql } from 'graphql-tag';
    export const MENU = gql\`query Menu { categoryTree { name position children { name url_key } } }\`;
    export const ACCOUNT = gql\`query Account { account { id firstname email } }\`;
  `;

  it('traces codegen static fetchers: useFooQuery.fetcher(vars)()', () => {
    const { operations, fragments, usages, bindings } = analyze({
      'q.ts': MENU,
      'gateway.ts': `
        import { useMenuQuery, useAccountQuery } from './generated';
        export async function loadMenu() {
          const data = await useMenuQuery.fetcher()();
          return data.categoryTree?.children?.map((c) => c.name);
        }
        export async function loadAccount() {
          const { account } = await useAccountQuery.fetcher({})();
          return account?.firstname;
        }
      `,
    });
    const menuUsage = usages.find((u) => u.hook === 'useMenuQuery.fetcher');
    expect(menuUsage?.library).toBe('codegen');
    const findings = analyzeOverfetch(operations, fragments, usages, bindings);
    const menu = findings.find((f) => f.operation === 'Menu')!;
    expect(menu.unused.map((u) => u.path)).toEqual(
      expect.arrayContaining(['categoryTree.name', 'categoryTree.position', 'categoryTree.children.url_key'])
    );
    expect(menu.unused.map((u) => u.path)).not.toContain('categoryTree.children.name');
    const account = findings.find((f) => f.operation === 'Account')!;
    expect(account.unused.map((u) => u.path)).toContain('account.email');
    expect(account.unused.map((u) => u.path)).not.toContain('account.firstname');
  });

  it('treats graphql-request results as the data, incl. client.request(DOC)', () => {
    const { operations, fragments, usages, bindings } = analyze({
      'q.ts': MENU,
      'api.ts': `
        import { request, GraphQLClient } from 'graphql-request';
        import { MENU, ACCOUNT } from './q';
        const client = new GraphQLClient('/graphql');
        export async function a() {
          const res = await client.request(ACCOUNT);
          return res.account.email;
        }
        export function b() {
          return request('/graphql', MENU).then((data) => data.categoryTree.name);
        }
      `,
    });
    const findings = analyzeOverfetch(operations, fragments, usages, bindings);
    const account = findings.find((f) => f.operation === 'Account')!;
    expect(account.unused.map((u) => u.path)).toContain('account.firstname');
    expect(account.unused.map((u) => u.path)).not.toContain('account.email');
    const menu = findings.find((f) => f.operation === 'Menu')!;
    expect(menu.unused.map((u) => u.path)).not.toContain('categoryTree.name');
  });

  it('follows reads straight off the call and ignores unrelated outer variables', () => {
    const { operations, fragments, usages, bindings } = analyze({
      'q.ts': MENU,
      'Head.tsx': `
        import { useQuery } from '@apollo/client';
        import { ACCOUNT } from './q';
        export function Head() {
          const label = format(useQuery(ACCOUNT).data?.account?.firstname);
          return label;
        }
      `,
    });
    const findings = analyzeOverfetch(operations, fragments, usages, bindings);
    const account = findings.find((f) => f.operation === 'Account')!;
    // firstname is read (and handed to format), email never is
    expect(account.unused.map((u) => u.path)).toContain('account.email');
    expect(account.unused.map((u) => u.path)).not.toContain('account.firstname');
  });
});
