# Results on public codebases

`graphql-overfetch` run on two public Magento storefront codebases, with every
finding checked against the source code. These numbers back the launch article
in [post.md](post.md).

Two builds are compared:

- **0.3.0**: the published release.
- **next**: the current `main`, after fixing the false-positive patterns the
  0.3.0 check turned up (listed at the end).

## How the findings were checked

Each reported field, dead query and dead fragment was traced by hand through
the code that runs it, across files: hooks, talons, page props and child
components. Each was then marked **real** (nothing reads it) or **wrong**
(something does; the location is recorded). The tracing was done with AI code
agents reading the repositories, and the key claims were spot-checked
manually. When a finding couldn't be settled it was marked uncertain; none
ended up there.

"Real" means no code reads the field. It doesn't always mean it should be
removed. Some selections exist to fill the Apollo cache for other components
through shared fragments; those are called out below.

## How to reproduce

```bash
git clone https://github.com/magento/pwa-studio.git              # 856c1438750f5695ea7edd7edb089e9deabb7306
git clone https://github.com/graphcommerce-org/graphcommerce.git # c613fdc539145699ff685dd59e5c98da1d19f763

npx graphql-overfetch@0.3.0 <repo> --json --ignore \
  '**/__tests__/**' '**/__mocks__/**' '**/__fixtures__/**' '**/__stories__/**' \
  '**/*.test.*' '**/*.spec.*' '**/*.stories.*' '**/upward-spec/suite/**'
```

For the "next" numbers, run `node dist/cli.js` from a build of `main` with the
same arguments. Raw output: [raw/](raw/) (`*-0.3.0.json` and `*-next.json`).
Each scan takes 1–3 seconds.

## Summary

| | PWA Studio 0.3.0 | PWA Studio next | GraphCommerce 0.3.0 | GraphCommerce next |
|---|---:|---:|---:|---:|
| Overfetched fields reported | 23 | 56 | 92 | 90 |
| …real | 15 | **56** | 31 | **90** |
| Overfetch precision* | 79% | **100%** | 46% | **100%** |
| Dead queries reported (real) | 6 (1) | 1 (1) | 12 (10) | 10 (10) |
| Dead fragments reported (real) | 3 (3) | 3 (3) | 91 (5 deletable) | 5 (5) |
| Unrequested reads (real) | — | 0 | — | 1 (1) |

\* 0.3.0 precision leaves out `id`/`uid`/`__typename`, which 0.3.0 reported
and "next" no longer does.

"next" finds **more** real overfetch with **no** false reports. It sees more
code: wrapper hooks, operations maps, `@inject` fragments, `useMemo`,
awaited promises and `for…of` loops. It also stops guessing where it can't
follow the data.

## PWA Studio (next)

**Overfetch: 56 fields in 11 queries, all real.**

- 28 of them (`GetCartDetails`, 19, and `getSelectedAndAvailableShippingMethods`,
  9) come through shared fragments such as `PriceSummaryFragment` and
  `ShippingInformationFragment`. The code comments say these are there on
  purpose so sibling components get their data from the cache. Real, but
  intentional.
- The rest are plain leftovers:
  - **`GetStoreConfigForLiveSearchPLP`**
    (`packages/extensions/venia-pwa-live-search/src/queries/liveSearchPlpConfigs.gql.js`)
    fetches `ls_service_api_key`, `base_currency_code` and
    `ls_autocomplete_limit`, and nothing reads them. The only read of the API
    key is commented out in `useLiveSearchPLPConfig.js:52`, and the next line
    hard-codes `apiKey: ''`. `GetStoreConfigForLiveSearchPopover` has 5 more
    unread `ls_*` settings.
  - **`getProductsByUrlKey`** (`packages/pagebuilder/lib/ContentTypes/Products/products.js`)
    requests `total_count` and the whole `filters { … }` block, but the widget
    only renders `data.products.items`. Filters make Magento compute
    aggregations.
  - **`GetCustomerCartAddress`** (`addressBook.gql.js`) reads only the first
    shipping address's street and name, but selects 7 more address fields via
    `ShippingInformationFragment`.
  - Smaller: `GetRobotsConfig.customInstructions`, `MiniCartQuery`'s
    `subtotal_including_tax`, `getItemCount.total_quantity`, the
    `page_info` in `GetWishlistItemsForLocalField`, and
    `GetFilterInputsForModal`'s `inputFields.type.name`.

**Dead code:** `GetCart` in `venia-product-recommendations` is never imported.
`WishlistFragment` (CE and EE) and `AddressBookFragment` are never spread.
`@magento/peregrine` exports them, so third-party code could still import
them.

**Duplicates:** 24 groups. Of 8 sampled, 7 are real. Examples: 11 identical
`createEmptyCart` mutations, four identical
`GetStoreConfigFor{Breadcrumbs,CategoryList,CategoryTree,MegaMenu}` queries,
and `checkUserIsAuthed` ×3. The 8th was a set of `{ id __typename }`
edition stubs, which "next" no longer reports.

## GraphCommerce (next)

**Overfetch: 90 fields in 13 queries, all real.**

- 57 of them are low-value. Either they're injected into cart fragments that
  exist to refresh the cache after cart mutations (`CartAdded`, 27; the
  pickup `sku` fields, 4), or the query runs `cache-only` and never hits the
  network (`CartItemSummary`, 26).
- The most actionable:
  - **`GetBillingAddress`** (`packages/magento-cart/graphql/queries/GetBillingAddress.graphql`)
    selects the whole `shipping_addresses` block through the
    `CartBillingAddress` fragment. The billing form never reads it.
  - **`UseAdyenPaymentMethods`**: the checkout query requests merchant and
    brand configuration (`brand`, `brands`, `merchantId`, `merchantName`,
    `details { … }`) that the package never reads. "next" no longer reports
    this, because the hook returns `{ ...methodConf, ...config }` and the
    tool now treats a spread as using everything (see "What it still
    misses").
  - **`InlineAccount`**, 9 address fields, and **`GetCartTotals`**'s
    `subtotal_with_discount_excluding_tax`, from the shared `CartPrices`
    fragment.
  - **`CategorySearch`** fetches `algolia_indexName` and `algolia_queryID`,
    injected by the Algolia package, but the category search hook never reads
    them.

**Dead code:** 10 dead queries, all real. Four of them are re-exported from
package `index.ts` files, so code outside the repo may use them. There are 5
dead fragments, all real: `CustomerAddressEdit`, `ProductPageQueryFragment`,
`OrderComments`, `ProductWishlistChip` and storyblok `Feature`. In 0.3.0, 72 of
the 91 reported dead fragments were actually used through `@inject`.

**Unrequested reads:** 1, and it's harmless. A recursive `add()` reads
`children` one level deeper than `CategoryPathFragment` selects, behind an
`if (cat?.children)` guard.

## What it still misses

"next" stays silent rather than guess when data leaves the code it can
follow. The hand check found these real findings it no longer reports:

- **A hook returning a spread object** (`{ ...methodConf, ...config }`), read
  in other files: GraphCommerce's Adyen hook, 13 fields.
- **Query promises collected for `Promise.all`**, or returned from a helper:
  GraphCommerce `ProductStaticPaths` (2) and `AttributesForm` (2).
- **Items copied into an array and returned** (PWA Studio's wishlist): 1
  field.
- **Documents that are defined but never actually run**, when their
  operations map is imported (PWA Studio's `creditCard.gql.js` copy of
  `getBillingAddress`). These are neither reported as overfetch nor as dead.
- **Cache keys** are skipped by field name, not per type, so a `code` field is
  skipped everywhere once any type uses `keyFields: ['code']`.

## False-positive patterns fixed since 0.3.0

Each fix has a test built from the real case.

1. A result returned as `return { selectedPaymentMethod }` wasn't treated as
   passed on.
2. Documents run through `operations.X`, or by an operations-map key, weren't
   recognised. Keys are now resolved through the map the calling file imports.
3. `.graphql` files read with `fs.readFileSync` at build time looked dead.
4. `id`, `uid`, `__typename`, `typePolicies` `keyFields` and
   `readField('x')` fields were reported as overfetch.
5. Callbacks declared elsewhere (`items.forEach(add)`), `useMemo` returns,
   `for…of` loops and `...rest` destructuring weren't followed.
6. Reads inside inline predicates were already handled. Reads hidden by a
   React dependency array were wrongly counted as "used".
7. A result assigned onto another object (`cat.children = …`), or stored as a
   promise and awaited later, wasn't followed.
8. Inline `gql` passed straight to `client.query` didn't count as executed.
9. Custom wrapper hooks named like generated hooks
   (`useCartQuery(CartItemSummaryDocument)`) were attributed to the wrong
   operation.
10. GraphCommerce's `@inject(into: [...])` fragment injection wasn't modelled.
11. Fragments used only as generated TypeScript types were reported dead,
    including names that already end in `Fragment`.
12. Duplicates compared response keys only. They now compare real field
    names, arguments and variables. Mutations and `@client` documents are
    never near-duplicates.
13. Same-named constants and fragments in different files were mixed up.
    Imports, including `tsconfig` path aliases, now decide which one is used.
    Per-edition fragment files are merged.
14. A variable shadowed by an inner one of the same name was attributed to
    the query.
