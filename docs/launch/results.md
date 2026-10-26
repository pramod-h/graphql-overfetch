# Results on public codebases

Scans of two public Magento storefront codebases with `graphql-overfetch@0.3.0`,
followed by a hand check of the findings against the source code. These
numbers back the launch article in [post.md](post.md).

## How to reproduce

```bash
git clone https://github.com/magento/pwa-studio.git          # 856c1438750f5695ea7edd7edb089e9deabb7306
git clone https://github.com/graphcommerce-org/graphcommerce.git  # c613fdc539145699ff685dd59e5c98da1d19f763

npx graphql-overfetch@0.3.0 <repo> --json --ignore \
  '**/__tests__/**' '**/__mocks__/**' '**/__fixtures__/**' '**/__stories__/**' \
  '**/*.test.*' '**/*.spec.*' '**/*.stories.*' '**/upward-spec/suite/**'
```

Raw output: [raw/pwa-studio.json](raw/pwa-studio.json),
[raw/graphcommerce.json](raw/graphcommerce.json). Each scan took 2–6 seconds on
an Apple Silicon laptop.

## Scan summary

| | PWA Studio | GraphCommerce |
|---|---:|---:|
| Source files scanned | 1,565 | 1,781 |
| Operations | 221 | 172 |
| Fragments | 46 | 247 |
| Components using GraphQL | 124 | 363 |
| Overfetching queries reported | 7 | 19 |
| Fields reported unused | 23 | 92 |
| Dead queries reported | 6 | 12 |
| Dead fragments reported | 3 | 91 |
| Duplicate query groups reported | 33 | 21 |

## PWA Studio: hand-checked

Every overfetch, dead-query and dead-fragment finding was traced through the
code, following talons into Venia components across files.

**Overfetch (23 fields in 7 queries):**

| Verdict | Fields |
|---|---:|
| Correct: never read anywhere | 15 |
| Wrong: actually read | 4 |
| `id` the project requires anyway | 4 |

- **Precision: 15 of 19 (79%)**, leaving out the `id` fields. Counting them as
  wrong, it's 15 of 23 (65%).
- 5 of the 7 queries are correct. The other 2 (`getSearchAvailableSortMethods`
  and `getSummaryData`) are wholly or mostly wrong, for the same reason
  (false-positive pattern 1 below).
- About the `id` fields: Venia's Apollo cache doesn't strictly need `id` on
  `Cart`, `Customer` or `StoreConfig`, because its cache settings give those
  types their own keys. But the repo's lint rule
  `@graphql-eslint/require-id-when-available` is set to `error`, so removing
  them would fail lint. They aren't actionable.

**Dead queries (6):** 1 correct, 5 wrong.
- `GetCart` in `venia-product-recommendations` is never imported. (The package
  publishes `/lib`, so code outside the repo could in theory import it.)
- The 4 `pwa-buildpack/lib/queries/*.graphql` files are wrong: they're read as
  strings at build time (pattern 3).
- `AddItemToCart` is wrong: it's run through `operations.ADD_ITEM` (pattern 2).
- The tool also **missed** one: `venia-ui/lib/components/Header/currencySwitcher.gql.js`
  is imported nowhere, but a live copy elsewhere has the same operation name.

**Dead fragments (3):** all 3 correct. `WishlistFragment` (in both its CE and
EE versions) and `AddressBookFragment` are defined but never imported or
spread. `@magento/peregrine` does export them, so a third-party extension
could still import them.

**Duplicates (5 of 33 groups sampled):**
- 3 are real and could be shared, e.g. `SignOutFromModal` and `SignOutFromMenu`.
- 1 is an intentional Commerce/Enterprise edition pair, only one of which
  ships in a build.
- 1 isn't a real duplicate. The 94%-similar group runs different mutations.

**Best examples:**
1. **`GetStoreConfigForLiveSearchPLP`**
   (`packages/extensions/venia-pwa-live-search/src/queries/liveSearchPlpConfigs.gql.js`)
   fetches `ls_service_api_key`, `base_currency_code` and
   `ls_autocomplete_limit`. None of them is read. The only read of the API key
   is commented out in `useLiveSearchPLPConfig.js:52`, and the next line
   hard-codes `apiKey: ''`. The search-results page hook does the same.
2. **`getProductsByUrlKey`** (`packages/pagebuilder/lib/ContentTypes/Products/products.js`)
   requests `total_count` and the whole `filters { … }` layered-navigation
   block, but the component only uses `data.products.items`. Filters make
   Magento compute aggregations, so the server does real work for nothing.
3. **`GetRobotsConfig`** (`packages/venia-ui/lib/components/RobotsMeta/robotsMeta.gql.js`)
   fetches `customInstructions`, but the component reads only `defaultRobots`,
   and the field appears nowhere else in the repo.

## GraphCommerce: hand-checked

Every overfetch and dead-query finding was traced, along with all 91 dead
fragments. GraphCommerce's cache settings
(`packages/magento-graphql/typePolicies.ts`) key products and categories by
`uid` and `StoreConfig` by `store_code`. Apollo also adds `__typename` to every
query, so removing it from a document saves nothing.

**Overfetch (92 fields in 19 queries):**

| Verdict | Fields |
|---|---:|
| Correct: never read anywhere | 31 |
| Wrong: actually read | 37 |
| `__typename` or a cache key (`uid`, `id`, `store_code`) | 24 |

- **Precision: 31 of 68 (46%)**, leaving out the cache fields. Counting them as
  wrong, it's 31 of 92 (34%).
- Both queries reported as "100% unused" (`GetCategoryStaticPaths` and
  `CategorySiblings`) are wrong.
- The wrong reports come mostly from data flowing through `getStaticProps`
  page props, callbacks declared elsewhere, and promises awaited later
  (patterns 5–10 below).

**Dead queries (12):** 10 correct, 2 wrong.
- `getSchema` and `Environments` are wrong: they're inline `gql` passed
  straight to `client.query`. `Environments` is even reported as both dead and
  overfetching.
- 4 of the 10 correct ones are exported from package `index.ts` files, so code
  outside the repo may still use them.

**Dead fragments (91):** mostly wrong, because of GraphCommerce's fragment
injection.
- GraphCommerce's code generation adds any fragment marked
  `@inject(into: ["Target"])` into the target fragment. So those fragments are
  never spread in the source, yet they end up in every operation that uses the
  target.
- The tool doesn't model this:

  | Group | Fragments |
  |---|---:|
  | Carry `@inject` | 50 |
  | Only spread inside injected fragments | 22 |
  | Never spread anywhere | 19 |

- **Precision: 19 of 91 (21%).** Of those 19, 14 are still imported as
  generated TypeScript types, so only **5 could actually be deleted**:
  `CustomerAddressEdit`, `ProductPageQueryFragment`, `OrderComments`,
  `ProductWishlistChip` and storyblok `Feature`.

**Duplicates (5 groups sampled):** 3 real, 2 not.
- Real: `HygraphAllPages` / `HygraphStaticPaths`, `CartEmail` / `GetCartEmail`,
  and `SignUp` / `SignUpConfirm` (already marked `@deprecated`).
- Not real: different mutations behind the same alias (`compareList:`), and
  payment mutations that differ only in their inputs.

**Best examples:**
1. **`UseAdyenPaymentMethods`** (`packages/magento-payment-adyen/hooks/UseAdyenPaymentMethods.graphql`).
   This checkout query fetches 14 fields nothing reads, e.g.
   `paymentMethods.brand`, `brands`, `configuration { merchantId merchantName }`,
   `details { … }` and `paymentMethodsExtraDetails.configuration.amount`. The
   package only reads `type`, `name`, `icon` and `issuers`.
2. **`StoreConfig`** (`packages/magento-store/graphql/fragments/StoreConfigFragment.graphql`),
   a global query that runs on essentially every page. `list_per_page` and
   `secure_base_link_url` aren't used anywhere in the TypeScript code, and
   `availableStores` is only read from a different query.
3. **`AttributesForm`** requests `errors { message type }`, and
   **`PagesStaticPaths`** requests `metaRobots`. The code that uses them reads
   only `items` and `url` respectively.

## Verdict

At 0.3.0, the tool is **useful on PWA Studio-style code and noisy on
GraphCommerce-style code.**

| | PWA Studio | GraphCommerce |
|---|---:|---:|
| Overfetch precision (excluding cache fields) | 79% | 46% |
| Dead-query precision | 17% (1/6) | 83% (10/12) |
| Dead-fragment precision | 100% (3/3) | 21% (19/91) |

The real findings are good. Each repo has unused checkout and config fields,
and PWA Studio fetches an API key that the code no longer uses. But
publishing these numbers as they stand would advertise a 46% hit rate.

The patterns below explain most of the wrong reports, and several are small
fixes. **Recommendation:** fix patterns 1, 2, 4, 9 and 10 first, re-run this
exact procedure, and publish the article with the new numbers.

## False-positive patterns (candidate bugs)

1. **A subtree returned with a shorthand property isn't treated as passed on.**
   `const selectedPaymentMethod = data.cart.selected_payment_method; return { selectedPaymentMethod }`
   (PWA Studio `peregrine/lib/talons/CheckoutPage/PaymentInformation/useSummary.js:36-43`).
   `WHOLE_OBJECT_PARENTS` in `src/analyzers/component-map.ts` has
   `PropertyAssignment` but not `ShorthandPropertyAssignment`. So the subtree
   counts as accessed, and every field under it is reported unused. This
   caused all 4 wrong overfetch fields in PWA Studio.
2. **Documents run through `operations.X`, or exported as `{ X }`, are missed.**
   `export default { ADD_ITEM }` plus `useMutation(operations.ADD_ITEM)`
   (`peregrine/lib/talons/Gallery/useAddToCartButton.js:77`).
   `collectReferencedNames` only collects plain identifier arguments and
   `PropertyAssignment` values. So the query is reported dead and never gets
   overfetch analysis.
3. **`.graphql` files read as strings aren't linked to the code that runs
   them.** PWA Studio's build reads queries with `fs.readFileSync`
   (`pwa-buildpack/lib/queries/index.js:12-30`). Anonymous operations have no
   name to match on.
4. **`id`, `uid` and `__typename` are reported as unused.** Apollo's cache,
   and lint rules like `require-id-when-available`, need them even when no
   component reads them. Seen in both repos and in the demo app: 24 of
   GraphCommerce's 92 fields.
5. **Callbacks declared elsewhere and passed to array methods aren't
   followed.** `const add = (cat) => { … cat.url_path … }; items.forEach(add)`
   (GraphCommerce `packages/magento-category/queries/getCategoryStaticPaths.ts:22-25`).
6. **Reads inside inline predicates are missed.**
   `.find((extra) => extra?.type === brandCode)`
   (`packages/magento-payment-adyen/hooks/useAdyenPaymentMethod.ts:10`).
7. **A result assigned onto another object's property isn't followed.**
   `cat.children = res.data?.categories?.items`
   (`packages/magento-category/utils/appendSiblingsAsChildren.ts:21`).
8. **A query promise stored and awaited later isn't followed.**
   `const query = client.query(...)` then `await query`
   (`packages/magento-product/components/ProductStaticPaths/getProductStaticPaths.ts:23-29`).
   The same applies to `...(await products)?.data` returned as page props.
9. **Inline `gql` passed straight to `client.query({ query: gql\`…\` })`
   doesn't count as executed** (`packages/hygraph-cli/src/readSchema.ts:6-8`).
   So the query is reported as both dead and overfetching.
10. **GraphCommerce's `@inject(into: [...])` fragment injection isn't
    modelled**, so the injected fragments and everything they spread look
    dead (`packages/magento-product-simple/ProductListItemSimple.graphql:1`).
11. **Fragments used only as generated TypeScript types are reported dead.**
    Deleting them would break compilation (`ProductPageName.graphql`, imported
    by `ProductPageName.tsx`).
12. **Duplicates compare the alias instead of the real root field**
    (`AddProductsToCompareList` vs `RemoveProductsFromCompareList`, both
    aliased `compareList:`).
13. **Duplicates ignore arguments and input values**, so mutations that
    differ only in their inputs get grouped together.
14. **Inline `useQuery(Doc).data?.x` chains without a `data` variable**, and
    page props passed down to components typed with generated `*Fragment`
    types, are partly missed (`GlobalHead.tsx:13-16`,
    `ProductListLayoutDefault.tsx:34`).

Related misses (false negatives):
- Overfetch matching for documents in an operations map only works when the
  map key equals the operation name. `getCategoriesAvailableSortMethods` went
  unanalysed because its key is `getCategoryAvailableSortMethodsQuery`.
- Liveness is decided by operation name, so a dead copy is hidden by a live
  query with the same name elsewhere (`getCurrencyData` in PWA Studio).
- A field read nowhere can still count as used: `enumValues.description` in
  GraphCommerce's `ContentStages` query
  (`packages/hygraph-ui/plugins/HygraphPreviewModeToolbar.tsx:22-25`).
