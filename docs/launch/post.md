<!--
DRAFT, not published. Numbers come from docs/launch/results.md ("next" build).
Publish together with the release that contains those fixes and --fail-on
(planned 0.4.0); 0.3.0 doesn't match these numbers or the CI example.
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
did the part most tool announcements skip: I traced every reported field
through the code to see whether it really was unused.

| | PWA Studio | GraphCommerce |
|---|---:|---:|
| Operations scanned | 221 | 172 |
| Fields reported unused | 56 | 90 |
| …actually unused (checked) | 56 | 90 |
| Dead queries / fragments reported | 1 / 3 | 10 / 5 |
| …actually dead (checked) | 1 / 3 | 10 / 5 |

It took three rounds to get there. The first release was right 79% of the time
on PWA Studio and only 46% on GraphCommerce. Each wrong report pointed at a
code shape the tracer didn't follow, such as operations maps, wrapper hooks,
`@inject` fragments and `useMemo`. Fixing those took both codebases to zero
false reports while finding more real ones. Where it still can't follow the
data, it now stays silent instead of guessing.

"Unused" doesn't always mean "delete it". About half the findings come
through shared fragments that are there on purpose, so other components get
their data from the Apollo cache. The rest are plain leftovers.

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

**A shipping block the billing form never shows.** GraphCommerce's
`GetBillingAddress` selects the cart's full `shipping_addresses` block through
the shared `CartBillingAddress` fragment. The billing form reads only the
billing address.

None of these are bugs, and nothing crashes. They're the slow drift that
makes every query a little heavier than the screen needs.

## Where it gets things wrong

It's a static tracer, so it can only report what it can follow. When data
leaves for somewhere it can't see — a hook that returns `{ ...a, ...b }` read in
another file, a query promise collected for `Promise.all`, a Redux store — it
treats the data as used and says nothing. That means it misses some real
overfetch (the results write-up lists every one the hand check found), but it
doesn't tell you to delete fields your app needs.

It also flags fields that are unused but deliberate, like cache-filling
fragments. Treat the output as a list to review, not a list to delete.

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
