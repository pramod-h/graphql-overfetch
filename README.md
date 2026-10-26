# graphql-overfetch — Detect GraphQL Overfetching, Dead Queries & Unused Fields in React Apps

[![npm version](https://img.shields.io/npm/v/graphql-overfetch.svg)](https://www.npmjs.com/package/graphql-overfetch)
[![npm downloads](https://img.shields.io/npm/dm/graphql-overfetch.svg)](https://www.npmjs.com/package/graphql-overfetch)
[![license: MIT](https://img.shields.io/npm/l/graphql-overfetch.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/graphql-overfetch.svg)](https://www.npmjs.com/package/graphql-overfetch)

![graphql-overfetch finding unused fields, a dead query and a dead fragment in a small Apollo app](https://raw.githubusercontent.com/pramod-h/graphql-overfetch/main/docs/demo.gif)

**graphql-overfetch** is a zero-config, static-analysis CLI that shows you how your
frontend **actually uses GraphQL** — not just what your schema or documents look
like. It traces the full chain **GraphQL operation → hook → React component → UI**
to find overfetching, dead queries, dead fragments, duplicate documents, unused
Code Generator types, risky query complexity, and schema drift. It runs entirely
on your machine: no server, no account, no code leaves your computer.

Works with **Apollo Client**, **urql**, **Relay**, and **graphql-request**, in
**React**, **Next.js**, TypeScript, and plain JavaScript projects.

> **Renamed:** this package was previously published as
> `@pramod_sh/graphql-inspector`. Run it with `npx graphql-overfetch` now. The
> `graphql-inspector` and `gqi` commands are now `graphql-overfetch` and `gqo`;
> every subcommand and flag is unchanged.

```bash
npx graphql-overfetch            # summary report for the current directory
```

## Table of contents

- [Why graphql-overfetch](#why-graphql-overfetch)
- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Flags](#flags)
- [Using in CI](#using-in-ci)
- [What it understands](#what-it-understands)
- [How overfetch detection works (and its limits)](#how-overfetch-detection-works-and-its-limits)
- [FAQ](#faq)
- [Known limitations](#known-limitations)
- [Programmatic use](#programmatic-use)
- [Roadmap](#roadmap)
- [Development](#development)

## Why graphql-overfetch

Most GraphQL tooling — linters, codegen, schema validators — checks whether your
**documents are well-formed**. None of it tells you whether the **fields you're
fetching are actually read by the component that requested them**. That gap is
where overfetching lives, and it's invisible to every other tool in the
ecosystem:

- **Overfetching** — fields a query requests but the component never reads. ⭐
  The differentiator: no other open-source tool traces field reads all the way
  from a GraphQL document, through hooks and custom talons, into JSX.
- **Dead queries** — operations no component executes.
- **Dead fragments** — fragments never spread anywhere.
- **Duplicate & near-duplicate documents** (e.g. `SearchProducts` vs
  `ProductSearch`, 98% identical).
- **Query complexity** — depth and field-count risk.
- **Schema drift** — requested fields that no longer exist in the schema.
- **Unused variables** — declared operation variables never referenced.
- **Impact analysis** — the blast radius of a schema field across operations,
  fragments, and components (useful before a breaking schema change).
- **Unused GraphQL Code Generator types** — generated types your app never
  imports.

## Install

No install required — run it with `npx`:

```bash
npx graphql-overfetch
```

Or add it as a dev dependency for repeatable CI runs (it's a dev-time analysis
tool, not a runtime dependency of your app):

```bash
npm install --save-dev graphql-overfetch
# or
yarn add -D graphql-overfetch
```

## Quick start

```bash
npx graphql-overfetch            # full summary for the current directory
npx graphql-overfetch --details  # every section, expanded
```

Once installed, both `graphql-overfetch` and the short alias `gqo` are
available:

```bash
npx gqo overfetch ./src --schema ./schema.graphql
```

## Commands

| Command | What it reports |
|---|---|
| `graphql-overfetch [path]` | Full report across every analyzer (add `--details`) |
| `graphql-overfetch overfetch [path]` | ⭐ Fields requested but never read in components |
| `graphql-overfetch unused [path]` | Dead queries, dead fragments, unused variables |
| `graphql-overfetch complexity [path]` | Query depth / field-count risk |
| `graphql-overfetch duplicates [path]` | Identical & near-identical documents |
| `graphql-overfetch impact <Type.field>` | Affected operations, fragments, and components for a schema field |
| `graphql-overfetch types [path]` | Unused GraphQL Code Generator types |

`[path]` defaults to the current directory. `gqo` is a drop-in short alias for
`graphql-overfetch` — every command above works identically with `gqo` in
place of `graphql-overfetch`.

## Flags

| Flag | Applies to | Description |
|---|---|---|
| `--details` | root report | Expand every section instead of just the summary |
| `--json` | all commands | Machine-readable output, e.g. for CI or piping into `jq` |
| `--schema <path>` | all commands | SDL or introspection JSON; enables schema-drift detection |
| `--ignore <globs...>` | all commands | Exclude paths (`node_modules`, generated files, tests, …) |
| `--generated <globs...>` | `types` only | Point at codegen output when auto-detection misses it |
| `--fail-on <checks>` | all except `impact` | Exit with code 1 if any listed check has findings — see [Using in CI](#using-in-ci) |

## Using in CI

`--fail-on` turns any check into a gate. Pass a comma-separated list of checks;
if any of them has findings, the command exits with code **1** after printing
its normal report.

```bash
npx graphql-overfetch --fail-on dead-queries,dead-fragments,schema-drift --schema ./schema.graphql
```

| Check | Fails when |
|---|---|
| `overfetch` | Any query requests fields its components never read |
| `unrequested-reads` | Code reads a field the query never requests (always `undefined`) |
| `dead-queries` | Any operation is never executed |
| `dead-fragments` | Any fragment is never spread |
| `duplicates` | Any identical or near-identical documents exist |
| `unused-variables` | Any operation declares a variable it never uses |
| `complexity` | Any operation is rated **high** risk |
| `schema-drift` | Any operation requests fields the schema no longer has (needs `--schema`) |
| `unused-types` | Any GraphQL Code Generator type is never used |

Exit codes: **0** = no findings in the selected checks, **1** = findings,
**2** = error (bad arguments, an unknown check, or a check that can't run —
e.g. `schema-drift` without a schema, so CI never passes silently).

With `--json`, the report still goes to stdout and the failure summary goes to
stderr, so you can save the report and gate on the exit code at once.

GitHub Actions example:

```yaml
name: GraphQL usage
on: pull_request
jobs:
  graphql-overfetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx graphql-overfetch@latest --fail-on dead-queries,dead-fragments
```

Start by gating on the checks your project already passes, so the gate only
catches new problems. Overfetch findings can include deliberate cache-filling
selections (see [its limits](#how-overfetch-detection-works-and-its-limits)),
so review them before adding `overfetch` to the gate.

## What it understands

| Style | Support |
|---|---|
| `.graphql` / `.gql` files + GraphQL Code Generator | ✅ (resolves `FooDocument` → operation `Foo`) |
| `gql\`\`` / `graphql\`\`` tagged templates | ✅ (incl. `${Fragment}` interpolation) |
| Apollo Client hooks (`useQuery`, `useMutation`, `useSuspenseQuery`, `useFragment`, …) | ✅ |
| Apollo Client imperative API (`client.query({ query })`, `client.mutate({ mutation })`, incl. `.then()` chaining) | ✅ |
| urql (`useQuery({ query })`, `useMutation`, imperative `client.query`) | ✅ |
| graphql-request (`request(url, DOC)`, `client.request(DOC)`) | ✅ |
| GraphQL Code Generator client-preset / gql.tada (`graphql(\`…\`)`) | ✅ |
| Codegen static fetchers (`useFooQuery.fetcher(vars)()`) | ✅ |
| Your own client function or wrapper hook called with a document (`gql(DOC, vars)`, `useCartQuery(DOC)`) | ✅ |
| Operations maps (`operations.GET_FOO`, Venia `mergeOperations` keys) | ✅ |
| GraphCommerce `@inject(into: [...])` fragments | ✅ |
| Relay (`useLazyLoadQuery`, `useFragment`) | ✅ |
| TypeScript **and** plain JS/JSX | ✅ |

Field-read tracing handles optional chaining (`data?.a?.b`), destructuring
(incl. renamed and nested defaults like `const { data: { user } = {} } = ...`),
`.map()`/`.filter()`/`.reduce()` callbacks (inline or same-file functions
passed by name), `for…of` loops, `...rest`, `useMemo`, awaited and stored
promises, `onCompleted`/`onData` callbacks, local re-aliasing, and pass-through (an object handed to a child component,
returned from a custom hook, or spread into page props is treated as
**used**, so custom-hook indirection and SSR prop drilling don't produce false
positives).

## How overfetch detection works (and its limits)

For each **query**, the tool inlines fragments to get the true requested field
set, then compares it against every field read in the components that run it.

- It is **precision-biased**: if it can't observe any field reads for a query
  (e.g. the result is only returned from a hook it can't follow), it reports
  nothing for that query rather than claiming everything is unused.
- Confidence is labeled: **high** = a whole top-level field is never
  referenced; **medium** = sibling fields are read but this one isn't.

This is a static heuristic, not a proof — review findings before deleting
fields.

## FAQ

**What is GraphQL overfetching, and why does it matter?**
Overfetching is when a query requests fields the UI never actually renders —
extra payload, extra parsing, extra bandwidth, with zero user-facing benefit.
It's invisible to schema validators and linters because the query is
perfectly valid GraphQL; you only see it by cross-referencing the query
against how the *component* consumes the result, which is exactly what
`graphql-overfetch overfetch` does.

**Does this replace ESLint / `graphql-eslint` / GraphQL Code Generator?**
No — those validate document syntax and generate types. graphql-overfetch is
complementary: it analyzes runtime *usage* (which fields are actually read),
a dimension none of those tools cover.

**Does it work with Next.js?**
Yes, including server-side data fetching that uses Apollo Client's imperative
`client.query()`/`client.mutate()` API (common in `getServerSideProps` /
route handlers), not just React hooks.

**Do I need a GraphQL server or schema file to run it?**
No. Most analyzers (overfetch, dead queries, duplicates, complexity) work
purely from your source code. Only schema-drift detection needs `--schema`.

**Is it safe to run in CI? Does any code leave my machine?**
Yes — it's a local static-analysis CLI. No network calls, no account, no code
or schema is ever uploaded anywhere.

**Why do some fields I know are used still show up as overfetched?**
The tracer is precision-biased but not perfect — see
[Known limitations](#known-limitations) below for patterns (e.g. React
Context, Redux, deeply indirect custom hooks) it can't yet see through.
Treat findings as a strong signal to review, not an automatic delete list.

## Known limitations

This is a static heuristic. Where it can't see something, it errs toward *not*
crying wolf — but be aware:

- **Overfetch** doesn't follow reads through **React Context**
  (`createContext`/`useContext`), Redux/zustand stores, or into another file
  (a custom hook's caller, a mapper imported from elsewhere). Data handed to
  any of those, spread into an object, or collected for `Promise.all` is
  treated as fully used, so the tool stays silent rather than guessing. It
  misses some real overfetch that way, but it doesn't report fields your app
  needs.
- **Mutations** are only analysed when every call site discards the result
  (graphql-request / codegen fetchers).
- **Cache-filling selections**: fields a query requests so *other*
  components can read them from the Apollo cache (shared fragments) are
  reported as unused. They are, for that query; check before removing.
- **Dead queries** are detected by whether the document's identifier is
  referenced anywhere as a value (hook call, wrapper hook, operations-map,
  named import, generated hook). This handles custom-hook indirection and
  duplicate definitions, and is precision-biased — it won't call a query dead
  just because the exact hook couldn't be traced (so it may under-report).
- **Dead fragments** use spread-reachability from operations. A fragment
  spread only by a fragment defined in `node_modules` / another package can
  still show as dead — confirm before deleting.
- **Schema drift** requires an accurate, current schema (`--schema`). A stale
  or partial snapshot will produce noise.
- **Generated type usage** counts a type as used if it's reachable from
  app-code imports/type-references (following references between generated
  types). Types reached only via `export *` barrels or dynamic access may
  show as unused.

## Programmatic use

```ts
import { scan } from 'graphql-overfetch';
const { analysis } = scan({ cwd: process.cwd() });
console.log(analysis.overfetch);
```

## Roadmap

- HTML report (`--html`), a ready-made GitHub Action, and Claude integration.

## Development

```bash
git clone https://github.com/pramod-h/graphql-overfetch.git
cd graphql-overfetch
yarn install
yarn dev overfetch ../some-graphql-project   # run from source
yarn build && yarn test
```

## License

MIT © [Pramod H](https://github.com/pramod-h)
