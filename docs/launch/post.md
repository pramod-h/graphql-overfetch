<!--
DRAFT, not published. Numbers come from docs/launch/results.md (graphql-overfetch 0.3.0).
results.md recommends fixing the main false-positive patterns and re-running
before publishing; update the numbers below after that re-run.
Publish only after the release that includes --fail-on (planned 0.4.0); the
CI example below doesn't work with 0.3.0.
-->

# Your GraphQL queries are probably asking for fields nobody renders

GraphQL's promise is "ask for exactly what you need". In practice, queries
drift. A designer drops the review stars from the product page, the component
stops rendering them, and `reviews { rating text author }` stays in the query
forever. Nothing breaks, so nothing tells you.

That leftover is **overfetching**: fields a query requests but the component
that runs it never reads. Every one of them is extra work on the server, extra
bytes on the wire, and extra data parsed and cached in the browser, for no
visible benefit.

## Why your tooling doesn't catch it

The usual GraphQL tooling checks whether your documents are *valid*:

- **Schema validation and `graphql-eslint`** check that fields exist and
  queries are well-formed.
- **GraphQL Code Generator** gives the result a type, but an unused property
  on a type is not an error.
- **Server-side field usage metrics** tell you a field is requested, not
  whether the client that requested it actually used it.

An overfetched field is perfectly valid GraphQL. You only see the problem by
cross-referencing the query against how the component consumes the result.

## How graphql-overfetch finds it

[graphql-overfetch](https://github.com/pramod-h/graphql-overfetch) is a
static-analysis CLI. It runs locally on your source code, with no server and
no schema required, and traces the chain:

**GraphQL document → hook call (`useQuery`, `client.query`, …) → component → the
fields actually read**

For every query it:

1. Inlines fragments to get the full set of requested fields.
2. Finds where the query is executed: Apollo Client hooks and its imperative
   API, urql, Relay and graphql-request.
3. Follows the result through destructuring, optional chaining,
   `.map()`/`.filter()` callbacks and local aliases, and treats objects that
   are passed on wholesale (to a child component, returned from a hook, spread
   into props) as used.
4. Reports the requested fields it never saw read.

It is deliberately *precision-biased*: if it can't observe any reads for a
query, it reports nothing for that query rather than guessing. The same scan
also reports dead queries, dead fragments, duplicate documents, query
complexity and, with a schema, schema drift.

## What it found in two public storefronts

I ran it on two public, production-grade Magento storefronts:
[PWA Studio](https://github.com/magento/pwa-studio) and
[GraphCommerce](https://github.com/graphcommerce-org/graphcommerce). Then I
did the part most tool announcements skip: I traced every reported field by
hand to see whether it really was unused.

| | PWA Studio | GraphCommerce |
|---|---:|---:|
| Operations scanned | 221 | 172 |
| Overfetching queries reported | 7 | 19 |
| Fields reported unused | 23 | 92 |
| …actually unused (hand-checked) | 15 | 31 |
| Overfetch precision* | 79% | 46% |

\* Leaving out `id`, `uid` and `__typename`, which Apollo's cache needs even
when no component reads them.

Each scan took a few seconds. The full method, raw output and every verdict are
in the [results write-up](https://github.com/pramod-h/graphql-overfetch/blob/main/docs/launch/results.md).

## Examples

**An API key nothing uses, on every search page.** PWA Studio's Live Search
query `GetStoreConfigForLiveSearchPLP` fetches `ls_service_api_key` along with
the rest of the store config. The only line that read it is commented out,
and the next line hard-codes `apiKey: ''`:

```js
//apiKey: storeConfig?.ls_service_api_key || '',
apiKey: '',
```

The query still asks for it on every product-list and search-results page.

**Layered navigation the widget never shows.** PWA Studio's Page Builder
products widget (`getProductsByUrlKey`) requests `total_count` and the full
`filters { name filter_items_count request_var filter_items { … } }` block,
then renders only `data.products.items`. Filters are the expensive part: the
server has to compute aggregations for them.

**Half a payment config at checkout.** GraphCommerce's Adyen integration
(`UseAdyenPaymentMethods`) requests 14 fields that nothing in the package
reads, such as `brand`, `brands`, `merchantId`, `merchantName` and the
`details { … }` block. The UI uses only each method's `type`, `name`, `icon`
and `issuers`.

None of these are bugs, and nothing crashes. They're the slow drift that
makes every query a little heavier than the screen needs.

## Where it gets things wrong

The hand check also showed where the tool is wrong, and it's wrong more often
on GraphCommerce than on PWA Studio. The main causes:

- **Data that travels further than the tool follows.** For example, results
  passed through Next.js `getStaticProps` page props, read in a callback
  declared elsewhere (`items.forEach(add)`), or stored as a promise and
  awaited later.
- **Cache fields.** `__typename`, `id` and `uid` are reported even though
  Apollo needs them.
- **Framework conventions.** GraphCommerce injects fragments at build time
  with an `@inject` directive, so most of the fragments the tool calls "dead"
  are actually used.

Each pattern is documented with a real example in the
[results write-up](https://github.com/pramod-h/graphql-overfetch/blob/main/docs/launch/results.md).
Until they're fixed, treat the findings as a list to review, not a list to
delete. That's also why each finding carries a confidence level.

## Try it

```bash
npx graphql-overfetch            # summary for the current directory
npx graphql-overfetch overfetch  # every overfetched field, with file and line
```

To stop new dead code from landing, gate pull requests on it:

```yaml
- run: npx graphql-overfetch@latest --fail-on dead-queries,dead-fragments
```

The tool works with Apollo Client, urql, Relay and graphql-request, in
TypeScript and JavaScript React or Next.js apps. Treat its findings as a
review list, not an automatic delete list, and please
[open an issue](https://github.com/pramod-h/graphql-overfetch/issues) when it
gets something wrong.
