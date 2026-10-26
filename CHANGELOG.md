# Changelog

## 0.3.0 — renamed to `graphql-overfetch`

### Changed
- **Package renamed** from `@pramod_sh/graphql-inspector` to `graphql-overfetch`.
  The old name clashed with The Guild's GraphQL Inspector (`@graphql-inspector/cli`),
  including its `graphql-inspector` command.
- **Commands renamed:** `graphql-inspector` → `graphql-overfetch`, `gqi` → `gqo`.
  Subcommands, flags, JSON output, and the programmatic API are unchanged.

### Migrating
- `npx @pramod_sh/graphql-inspector …` → `npx graphql-overfetch …`
- `npm uninstall @pramod_sh/graphql-inspector && npm install --save-dev graphql-overfetch`,
  then update scripts that call `graphql-inspector` or `gqi`.
- `import { scan } from '@pramod_sh/graphql-inspector'` → `import { scan } from 'graphql-overfetch'`

## 0.2.2 — `--ignore` & `--version` fixes

### Fixed
- **`--ignore` now applies to TS/JS source files.** Previously it only excluded
  `.graphql`/`.gql` files; component mapping, overfetch, and tagged-template
  scanning still read every source file. `coverage/` is now skipped by default
  as well.
- **`--version` reported `0.2.0`.** It is now read from `package.json`.

## 0.2.1 — imperative-API & destructuring fixes

### Fixed
- **Apollo Client imperative API invisible to the tracer.** `client.query({ query: DOC })` /
  `client.mutate({ mutation: DOC })` — common in SSR/server-side data fetching
  (e.g. Next.js `getServerSideProps` / route handlers) — were never classified
  as GraphQL execution, so overfetch/usage tracing silently skipped these call
  sites entirely. Now recognized, including `.then(({ data }) => ...)` promise
  chaining.
- **Whole-result passthrough at the root silently dropped.** Handing off the
  *entire* query result under a new key (e.g. `return { storeConfig: data }`)
  was ignored because the internal root path (`''`) is falsy and got skipped by
  a truthiness check — reporting 100% overfetch on fields that were actually
  fully consumed downstream. Root-level passthrough is now tracked correctly.
- **Nested destructuring with defaults lost all field tracking.** The extremely
  common Apollo pattern `const { data: { user } = {} } = useQuery(...)` was
  silently untracked because `BindingElement.getName()` returns raw source text
  (e.g. `"{ user }"`) instead of an identifier for nested binding patterns.
  Fixed with recursive pattern resolution, applied consistently across result
  destructuring, re-aliasing, and `.map()`/`.filter()` callback params.

## 0.2.0 — accuracy hardening

### Fixed
- **Dead-query false positives.** Detection is now based on whether a document's
  identifier is referenced anywhere as a *value* (hook call, custom wrapper
  hook, operations-map object, named import, or generated hook) instead of
  resolving each usage to a single operation object. This correctly handles
  duplicate operation definitions and custom-hook / Venia-talon indirection, and
  is precision-biased (won't call a query dead just because the exact hook
  couldn't be traced). Real-world impact on two production storefronts: 89 → 69
  and 25 → 7 dead queries, with the remainder verified genuinely unused.
- **Relay hooks misclassified.** `useLazyLoadQuery` / `usePreloadedQuery` matched
  the codegen generated-hook pattern (`use` + `LazyLoad` + `Query`) and were
  mislabeled; they're now recognized as Relay. Inline `graphql`…`` documents
  passed directly to a hook are resolved by operation/fragment name.
- **urql `useQuery` mis-parsed as Apollo.** `useQuery` exists in both clients;
  it's now disambiguated by argument shape (`{ query: DOC }` → urql), including
  `[{ data }]` and `[result]` tuple results.

### Added
- `types` command: unused GraphQL Code Generator type detection (reachability
  from application-code references, following references between generated
  types). `--generated <globs...>` overrides auto-detection.
- Tests for complexity, schema drift, impact, project detection, urql, and Relay
  (16 total).

## 0.1.0 — initial release
Overfetch analysis, dead queries/fragments, duplicate/near-duplicate detection,
query complexity, schema drift, unused variables, and field impact. Supports
`.graphql` + GraphQL Code Generator and `gql`` tagged templates across Apollo,
urql, graphql-request, and Relay, in TypeScript and plain JS/JSX.
