# Finnish groceries for agents

A local TypeScript library, JSON CLI and MCP adapter for Finnish grocery searches. K-Ruoka and S-Kaupat support a selected store; Lidl exposes a partial published catalog. Alko is excluded from the agent tools.

The core is [src/groceries.ts](src/groceries.ts). MCP is one interface to it, so a future service can reuse the same retailer adapters without depending on MCP or another fork at runtime.

## Local setup

Use **Node 24** for the CLI and MCP stdio. Bun remains the dependency manager. The tested Windows setup starts Playwright correctly under Node; the equivalent Bun browser launch hung, so browser calls under Bun on Windows fail with an actionable error.

```powershell
bun install --frozen-lockfile
bunx playwright install chromium
node src/cli.ts capabilities
node src/cli.ts stores --chain k-ruoka --city Helsinki
node src/cli.ts stores --chain s-kaupat --city Helsinki
```

Select stores from those results. K-Ruoka includes K-Market, K-Supermarket and K-Citymarket; S-Kaupat includes Prisma, S-market and other S-banner stores. K stores are no longer excluded merely because they lack an online checkout. S-group directory membership does not guarantee an online assortment: S-market Itälahdenkatu and Tesoma passed live product/detail checks, while Hakaniemi and Sokos Helsinki returned no milk results. Prefer stores whose official page advertises online shopping, and treat zero matches as an online-catalog result rather than physical stock information.

```powershell
# Example store IDs; replace them with your own choices.
node src/cli.ts search --chain k-ruoka --store N106 --query maito --limit 5
node src/cli.ts product --chain k-ruoka --store N106 --id 6410405082657
node src/cli.ts search --chain s-kaupat --store 513971200 --query maito --limit 5
node src/cli.ts product --chain s-kaupat --store 513971200 --id 6415712506032
node src/cli.ts search --chain lidl --query juustokierre
node src/cli.ts product --chain lidl --id 10008395
```

For defaults, copy `.env.example` to `.env` and set `K_RUOKA_STORE_ID` and `S_KAUPAT_STORE_ID`. Then use `bun run cli -- search --chain s-kaupat --query maito`, or `node --env-file-if-exists=.env src/cli.ts ...`. An explicit `--store` / `storeId` overrides the default. No store is selected silently.

CLI output is JSON on stdout; failures go to stderr with exit code 1. Search accepts `--offset` and returns `nextOffset`. For details, use the returned `id`: an EAN for K/S, a retailer product ID for Lidl. Lidl may publish multiple GTINs for one product page; these are kept in `gtins` rather than treating the page ID as an EAN.

## MCP

```powershell
bun run stdio
```

Example MCP client configuration for this checkout:

```json
{
  "mcpServers": {
    "ruoka": {
      "command": "node",
      "args": [
        "--env-file-if-exists=E:/Projektit/mcp-ruoka/.env",
        "E:/Projektit/mcp-ruoka/src/index.ts",
        "--stdio"
      ]
    }
  }
}
```

Tools: `get_capabilities`, `get_stores`, `get_nearby_stores`, `discover_products`, `get_products`, `get_product_availability`, `search_products`, `get_product`, `compare_products`, `get_preferences`, `set_preferences`, `get_price_history`, `get_manufacturer_label`, `discover_manufacturer_label`, `get_lidl_leaflets`, `get_provider_health`. Successful tools return both JSON text and MCP `structuredContent`. Errors set `isError`. Store lookup and comparison can return partial results with explicit failure reports; always inspect their coverage and warnings.

For model-driven selection, use `discover_products` with the same inputs as `search_products`, then `get_products` with up to eight `{ chain, storeId, id }` references. Discovery retains category paths, weak-match signals, price/availability summaries and pagination without fetching labels. Batch inspection deduplicates references, returns partial failures, and reuses cached details. Both report SQLite cache hits/misses; `get_provider_health` additionally reports live provider loads and cache counters.

K/S directories persist for 24 hours. Search queries normalize Unicode, case and whitespace and cache for five minutes; product details cache for five minutes. `get_product` and batch items support `refresh: true`. Label data remains historical in SQLite but is not silently substituted into a fresh store offer.

`get_product_availability` accepts `{ chain: "k-ruoka", storeId, id, nearby?: boolean, refresh?: boolean }`. It refreshes the selected store's listing and optionally queries K-Ruoka's nearby-alternatives endpoint, caching the result for one minute. Unavailable stores return a null purchase price even when the retailer response contains a price. Nearby lists exclude the reference store and retain the supplied radius; an omitted store is not proof of unavailability. These are listing flags, not physical shelf quantities.

`get_stores` now returns `{ stores, warnings }`. Search has pagination and coverage metadata, and products have additional structured fields. Existing clients that assumed the original array-only store response need updating.

## Nearby stores and product comparisons

```powershell
node src/cli.ts nearby --postal-code 60100 --radius 15
node src/cli.ts stores --city Seinäjoki
node src/cli.ts compare --input examples/vanilla-seinajoki.json
```

The postal lookup includes municipality aliases: Prisma Seinäjoki is found even though its postal locality is Hyllykallio. K/Lidl store coordinates are used when supplied. S stores currently fall back to their postal-area reference points. Distances are straight-line estimates; the response labels both origin and store precision. A postal-area point is not a home address, so radius boundaries are approximate. Use coordinates for a more accurate starting point. See [postal data provenance and regeneration](data/README.md).

Nearby discovery includes Lidl by default; `chains` can restrict the lookup. Lidl IDs such as `FI00173` identify locations and offer regions for leaflet lookup, **not** selected-store product search. Its first nationwide refresh reads the public city directories with two concurrent loads (about 29 seconds in the live check); pages are cached for 24 hours. Provide `city` to `get_stores` for a smaller lookup. A directory/schema failure is reported through warnings rather than silently claiming complete coverage.

The example compares K-Citymarket Ideapark, S-market Kivistö and Prisma Seinäjoki, and checks Lidl's partial published catalog. It searches `vanilja` with `productKind: "yogurt"` and `vanillaOnly: true`. Product-kind matching distinguishes yogurt (including recognized plant alternatives), quark/rahka and pudding; yogurt excludes quark blends and frozen yogurt. The vanilla filter excludes recognized fruit/chocolate/other blends, including lingonberry–vanilla. Matching uses product-name vocabulary in Finnish, Swedish and English and is not an exhaustive classifier. Query translation is not automatic; supply additional `queries` and `includeTerms`/`excludeTerms` where needed.

`compare_products` accepts explicit `stores`, or `postalCode`/`coordinates` with `radiusKm`. Nearby comparison defaults to the nearest **6 K/S stores**, with an explicit warning when others are omitted; increase `maxStores` (up to 20), or select stores from `get_nearby_stores`. It follows pagination, retrieves labels, groups matching single GTINs across stores and returns offers with store names, prices, conditions and source timestamps. Multi-GTIN Lidl pages are not assumed to identify one exact product.

Ranking options:

- `no_added_sugar_then_price` (default): products with a supported no-added-sugar claim, ordered by local €/kg. An ingredient list without detected sugar is not sufficient to establish that claim. Conflicting evidence is excluded.
- `total_sugar_then_price`: known total sugar per 100 g, then local €/kg. This includes naturally occurring sugar and is **not** an added-sugar ranking.
- `price_per_kg`: cheapest known local €/kg, subject to any supplied filters.

`maxSugarGPer100g` filters total sugar. `excludeSweeteners` excludes detected sweeteners and products with missing ingredients. Exact added-sugar grams remain unknown; the tool does not subtract estimated lactose. Per-100-ml and prepared-product nutrition are not silently used as per-100-g as-sold values. Conflicting retailer labels remain unknown.

K loyalty and multipack offers retain their eligibility, dates, price, unit price and purchase quantity. Comparison uses them only with `includeLoyaltyPrices` and/or `allowMultipacks` enabled, and only when eligibility and validity are known. Offers' `price` can therefore be a bundle total; inspect `purchaseQuantity` and `selectedConditions`.

Always inspect `coverage`: page/detail budgets, failed providers and skipped details are explicit. Defaults are 10 pages per store/query, 120 detail requests and a 120-second work budget (`maxDurationSeconds`, up to 600). The time budget includes store discovery time but is enforced between product/label requests; an in-flight request finishes or reaches its own timeout, so this is not a hard cancellation deadline. Details are interleaved across stores. `completeForRequestedSearches` means the requested search results were processed, not that every local product was found. `completeMarketCoverage` is always false. Lidl published prices cannot win a local-store price ranking because local availability is unverified.

## Manufacturer label enrichment

The agent can call `discover_manufacturer_label` with `{ "manufacturer": "valio", "name": "Valiojogurtti vanilja laktoositon 200 g", "gtin": "6408430002665" }` to search the official manufacturer sitemap. Supports Arla and Valio; checks at most `maxCandidates` pages (default 5, maximum 10). Valio package links are followed within the same budget. Name similarity only selects candidates: a label is returned only after exact EAN verification. Misses retain attempted URLs/errors and do not prove absence.

Call `get_manufacturer_label` with the discovered Arla/Valio URL and GTIN, or supply `manufacturerSources: [{ gtin, url }]` to `compare_products`. The example includes the official Arla Aamu+ AB vanilla 175 g page for EAN `6413300024074`, whose comparable nutrition was missing from the retailer result. Comparisons do not automatically initiate manufacturer discovery.

Parsers require supported per-100-g nutrition tables. Results retain source URL/time, are cached for up to 24 hours, and appear as `supplementaryLabels` in comparisons. Conflicting nutrition remains unknown. Manufacturer data does not supply store prices or stock and does not overwrite retailer observations. Manufacturers beyond Arla/Valio and unsupported label layouts remain future work.

```powershell
node src/cli.ts manufacturer --id 6413300024074 --url https://www.arla.fi/tuotteet/aamuplus/ab-vaniljajogurtti-laktoositon-175g-686853/
node src/cli.ts discover-manufacturer --input examples/valio-label.json
```

## Persistent observations and price history

Successful searches and details now save local observations in `.ruoka-data/observations.sqlite` (ignored by Git and Docker). `RUOKA_DB_PATH` can select another path. SQLite uses the runtime's built-in module: `node:sqlite` on Node 24 and `bun:sqlite` on Bun; no new dependency is required. Node 24.4 emits its experimental SQLite notice on stderr.

Search/detail caches survive process restarts without resetting expiry or observation timestamps. Expired entries are refreshed; a provider failure never silently returns an old price. Cached payloads are validated against their schema and requested product/store. Invalid cached payloads are treated as misses. Historical observations are kept separately from the disposable cache, and label versions are deduplicated separately from store offers. Retailer detail endpoints still return combined price/label payloads; independent retailer-label refresh is not implemented.

```powershell
node src/cli.ts history --chain k-ruoka --store N192 --id 6413300024074
node src/cli.ts history --chain s-kaupat --id 6413300024074 --since 2026-10-31T00:00:00Z --limit 50
```

History is only what this installation observed, newest first, with source timestamps, conditions and an explicit historical flag. Omit the store to inspect all observed stores within that chain. Search and detail observations may overlap; limits are reported. History is never interpreted as current shelf stock. There is no automatic history deletion or scheduled collection, so storage grows with use. Preserve the database when moving the service; close the process before copying its SQLite files.

## Saved local preferences

Use `get_preferences` and `set_preferences` through MCP, or save a JSON input file and run `node src/cli.ts configure --input PATH`. Example:

```json
{
  "postalCode": "60100",
  "radiusKm": 15,
  "preferredStores": [
    { "chain": "k-ruoka", "storeId": "N192" },
    { "chain": "s-kaupat", "storeId": "516242633" }
  ],
  "defaultStores": { "k-ruoka": "N192", "s-kaupat": "516242633" }
}
```

Preferences are stored atomically in this project's ignored `.ruoka-preferences.json`. Saving replaces the entire document; omitted fields are cleared. No home location has been preconfigured. Explicit comparison selections override saved preferred stores, which override the saved home location. Explicit search/detail store IDs override environment defaults, which override saved `defaultStores`. Single-store defaults and multi-store preferences are separate.

## Library

```typescript
import { searchProducts, getProduct, closeBrowser } from "./src/groceries.ts";

try {
  const result = await searchProducts({
    chain: "s-kaupat", storeId: "513971200", query: "kaurajuoma", limit: 5,
  });
  const first = result.products[0];
  if (first) {
    const details = await getProduct({
      chain: result.chain, storeId: result.storeId ?? undefined, id: first.id,
    });
    // Use details.pricing, details.nutrition, details.ingredients, etc.
  }
} finally {
  await closeBrowser();
}
```

Keep the process alive for repeated requests. It reuses one browser context and separate retailer pages. Run one process per browser profile; use a different `BROWSER_DATA_DIR` for another instance. Library consumers own shutdown through `closeBrowser()`.

## Data and coverage

| Data | K-Ruoka | S-Kaupat | Lidl |
|---|---|---|---|
| Store selection | Yes | Yes | Unsupported |
| Nearby locations | Coordinates when supplied | Postal reference points | Exact coordinates and offer region |
| Leaflets | Not implemented | Not implemented | Published page text, dates, PDF/image links; regional coverage incomplete |
| Product search | Store catalog | Store catalog | Published search catalog + product sitemap |
| Price | Normal/current price and conditional promotions | Current, regular and campaign fields when returned | Some published prices; dates and regions retained |
| Unit price | Numeric amount + unit | Numeric amount + normalized unit | Parsed when an unambiguous kg/l price is published |
| Ingredients/allergens | Structured details | Structured details | Original label text when published |
| Nutrition | Label tables, basis and preparation | Label tables with original basis/values | Original label text; supported bilingual bakery tables parsed |
| Availability | Retailer store/web catalog flags | Unknown | Unknown |

- `pricePerKg` is populated only for a kilogram comparison price. A litre price is never converted to kilograms without product density.
- `availability.stock` is always `unknown`. Catalog flags, a price, or Lidl's online `OutOfStock` markup do not establish local shelf stock.
- Nutrition retains the original basis (`100 g`, `100 ml`, serving, etc.), preparation and label values. Missing data is not zero and an empty allergen list is not a free-from claim. Search summaries need a separate detail call for the full label.
- Every product includes a source URL and `fetchedAt`. Null means unavailable/unknown from this response. Retailer payload/schema failures are errors.
- K single-item standard offers update the current price while valid; loyalty and multipack offers are separate in `pricing.promotions`. S global fallback products retain label facts but suppress store price and aisle. The selected store is validated against K/S response IDs.
- Lidl's top-level `price` is suppressed for detected upcoming/expired or multipack offers. `pricing.publishedPrice` retains the advertised amount; check validity dates and conditions. Prices without published dates remain published quotations, not confirmed checkout prices.

## Lidl findings

Verified on 2026-10-31 against Lidl's own website:

- The [food page](https://www.lidl.fi/c/ruoka-ja-juoma/s10068374) uses `/q/api/search`. The API paginates and caps page size below its advertised maximum. Its search index is not the full store assortment.
- The [product sitemap](https://www.lidl.fi/p/export/FI/fi/product_sitemap.xml.gz) includes additional permanent bakery labels. Search combines these with the published product index and matches names/brands/URL text. Sitemap-only matches have unknown prices and may include non-food items; retrieve details to verify them.
- [Juustokierre](https://www.lidl.fi/p/juustokierre/p10008395) publishes ingredients and a bilingual nutrition label but no price. The adapter returns the label as `labelText` without inventing a price or allergen interpretation.
- [Proteiinirahka XXL](https://www.lidl.fi/p/proteiinirahka-xxl/p11005419) publishes a price, a kg price, several GTINs, regional data and an offer start date. The offer tested was upcoming on the research date, so its advertised amount is retained separately from current price.
- The [official store directory](https://www.lidl.fi/s/fi-FI/myymaelaet/) publishes indexed JSON with store IDs, addresses, coordinates and offer regions. Both Seinäjoki stores resolve to region `6`, named `Laukaa`. The country index can lag store openings; city records take precedence when they contain additional stores.
- [Offer leaflets](https://www.lidl.fi/c/tarjouslehdet/s10019134) use the public `endpoints.leaflets.schwarz/v4/flyer` endpoint. `get_lidl_leaflets` discovers current published links and returns page matches, dates, PDF/image URLs and original fetch timestamps. Optional `storeId` sends its verified offer region. The tested national leaflets returned region `0` even when requesting `6`; `matchesRequestedRegion` is therefore false, not assumed true.
- Finnish leaflets tested here contain page keywords/descriptions but **zero structured product records**. Text flattens layout and loses price decimal separators, so the adapter does not derive prices or join products by name. Publication dates and offer dates are separate; individual page offers may have narrower validity. Regional-only leaflets may be absent from the national index.

```powershell
node src/cli.ts stores --chain lidl --city Seinäjoki
node src/cli.ts nearby --chain lidl --postal-code 60100
node src/cli.ts leaflets --store FI00173 --city Seinäjoki --query jogurtti
```

Supported Finnish/Swedish bakery nutrition tables populate structured nutrition as well as retaining the raw label. Other formats remain unknown. Remaining Lidl work includes complete regional leaflet discovery, reliable extraction of leaflet-only prices and additional label formats. There is no verified complete national price/stock API in this implementation.

## Reliability and verification

Implemented: bounded HTTP/browser timeouts, serialized retailer JSON requests, bounded retries for transient HTTP/network failures, S browser fallback after a direct 403, runtime discovery of S persisted-query hashes, K build discovery and one refresh after a version rejection, bounded TTL caches with in-flight deduplication, and response validation. Retry-After is respected; a server cooldown over 30 seconds returns an error instead of retrying early or holding the queue indefinitely. Browser launch failures never delete the persistent profile.

Cache lifetimes: searches and details 5 minutes, K/S store directories 24 hours in SQLite (with a 1-hour memory cache), Lidl index 1 hour, and explicit K availability checks 1 minute. Offer validity is rechecked when returning cached prices. Cached responses preserve their original observation timestamp; failures are not cached and stale values are not substituted for failed refreshes. Lidl index prices may therefore be up to an hour old. These are internal website endpoints and can change or block automation.

```powershell
bun run typecheck
bun run test

# Opt-in network/browser smoke test; configure K/S default stores first.
bun run smoke

# Isolated browser page/context recovery, using a local HTTP server.
node scripts/smoke-recovery.ts

# Three cycles, fresh detail loads and a forced context-close recovery.
node scripts/soak-groceries.ts --cycles 3 --interval-seconds 60

# Approximately 24 hours: 49 cycles at 30-minute intervals.
node scripts/soak-groceries.ts --cycles 49 --interval-seconds 1800 --run-id my-24h-run
```

The soak runner uses its own `.cache/soak/<run-id>/` browser profile and SQLite database. It checks K-Citymarket Ideapark, S-market Kivistö and Lidl bakery search/detail, verifies fresh detail timestamps, tests cached search reads, and recreates the browser context every third cycle. It records each success/failure and Node memory usage in `checks.jsonl`, with progress in `status.json`. Memory figures exclude Chromium child processes. Failures remain recorded even if later cycles recover. Reusing a run ID is rejected. Create an empty `STOP` file inside the run directory for graceful shutdown (polled between requests and every five seconds while waiting). Keep the machine awake and inspect the final status; starting a run is not a successful endurance result.

Offline tests cover recorded public product fixtures, store isolation, missing values, unit handling, Lidl offer validity, cache expiry/deduplication, HTTP failures/retries and the actual Node MCP stdio protocol. Fixtures were captured on 2026-10-31 and contain product data only. Live checks have exercised K-Market and K-Citymarket, two Prismas and two S-markets, store-specific detail prices, result pagination, all 1,047 S-group directory entries, city filtering, plus Lidl search, prices and bakery labels.

Nearby discovery and a live three-store Seinäjoki comparison were also verified. The latest vanilla-only example scanned 730 K/S search results, processed all 31 matching offers, and enriched the exact-EAN Arla label without detail/enrichment failures. Lidl's partial published search yielded no matching yogurt. Cached product retrieval in a new process worked without launching a browser and retained its original observation timestamp. Offline tests additionally cover postal aliases, distance precision, preferences, paginated comparisons, GTIN grouping, label conflicts, promotion eligibility, SQLite reopening/expiry, manufacturer EAN validation, provider recovery and work budgets.

`get_provider_health` reports live search/detail loads since the process started: successes, failures, consecutive failures, latency, last error and in-flight operations. It excludes cache hits, store-directory calls and manufacturer enrichment. Use it within the persistent MCP process; `node src/cli.ts health` starts a new process and therefore has no prior provider history. Local recovery checks verify replacement of closed pages and browser contexts. Transport tests cover dropped connections, HTTP retries and cooldown recovery.

This is a working local foundation, not a completed unattended-hosting validation. A local endurance runner is implemented; a completed long-duration result, recovery after a real anti-bot challenge and a hosted Linux soak test remain. The inherited Bun HTTP/OAuth server is retained; HTTP mode is not supported under Node yet and was not validated for deployment in this work. Before container deployment, packaging must include the `data/` directory and persistence must be configured. Local caches, observations and preferences are excluded from the Docker build context. No hosting or authentication changes are required for local stdio use.

## Upstream work and attribution

Based on [p18a/mcp-ruoka](https://github.com/p18a/mcp-ruoka). The inspected [Jameshooper fork at e03055a9](https://github.com/Jameshooper/mcp-ruoka/tree/e03055a9) was 55 commits ahead of the shared base. Its Home Assistant, recipe and meal-planning features are outside this project's scope.

The plain GET S-Kaupat product-field query was adapted from that fork's `src/browser/s-kaupat-api.ts`. Its nutrition/allergen/location work informed the combined detail adapter; its `memoizedLookup` informed the local bounded cache. The implementation lives here and has no runtime dependency on the fork. The original plugin manifest declares MIT; original attribution is retained.

This project is unofficial and not affiliated with the retailers.
