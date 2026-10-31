import assert from "node:assert/strict";
import test from "node:test";
import { type ComparisonClient, runComparison, selectPrice } from "../src/comparison.ts";
import { resolveComparisonInput, SearchInputSchema } from "../src/groceries.ts";
import type { GroceryProduct } from "../src/grocery-types.ts";
import { product } from "./helpers.ts";

function clientFor(products: GroceryProduct[], pageSize = 50): ComparisonClient {
	return {
		async search(input) {
			SearchInputSchema.parse(input);
			const matching = products.filter(
				(p) => p.chain === input.chain && p.storeId === (input.storeId ?? null),
			);
			const end = input.offset + pageSize;
			return {
				chain: input.chain,
				storeId: input.storeId ?? null,
				query: input.query,
				products: matching.slice(input.offset, end),
				totalCount: matching.length,
				offset: input.offset,
				nextOffset: end < matching.length ? end : null,
				coverage: input.chain === "lidl" ? "partial-published-catalog" : "store-catalog",
				warnings: [],
			};
		},
		async detail(input) {
			const p = products.find(
				(p) =>
					p.id === input.id && p.chain === input.chain && p.storeId === (input.storeId ?? null),
			);
			assert.ok(p);
			return p;
		},
	};
}
const stores = [
	{ chain: "s-kaupat", storeId: "1" },
	{ chain: "k-ruoka", storeId: "N1" },
] as const;
const label = { description: "Ei lisättyä sokeria", ingredients: "MAITO, vanilja" };

test("time budget stops new detail work and reports skipped offers instead of a complete comparison", async (t) => {
	let time = 0;
	t.mock.method(Date, "now", () => time);
	const client = clientFor([product(label)]);
	const search = client.search;
	client.search = async (input) => {
		const result = await search(input);
		time = 2000;
		return result;
	};
	const result = await runComparison(
		{ queries: ["vanilja"], includeLidl: false, maxDurationSeconds: 1 },
		[stores[0]],
		client,
	);
	assert.equal(result.coverage.timeBudget.stoppedForTimeBudget, true);
	assert.equal(result.coverage.detailsAttempted, 0);
	assert.equal(result.coverage.detailsSkipped, 1);
	assert.equal(result.coverage.completeForRequestedSearches, false);
});

test("explicit manufacturer evidence fills missing nutrients, while mismatched GTINs cannot affect ranking", async () => {
	const p = product();
	const client = clientFor([p]);
	const reference = { gtin: p.gtins[0] ?? "", url: "https://www.arla.fi/tuotteet/test/" };
	client.manufacturerLabel = async () => ({
		gtin: reference.gtin,
		ingredients: "MAITO",
		nutrition: [
			{ basis: "100 g", preparation: null, values: [{ name: "sugars", value: "8.2 g" }] },
		],
		source: { url: reference.url, fetchedAt: new Date().toISOString() },
	});
	const input = {
		queries: ["vanilja"],
		includeLidl: false,
		rankBy: "total_sugar_then_price" as const,
		manufacturerSources: [reference],
	};
	const enriched = await runComparison(input, [stores[0]], client);
	assert.equal(enriched.ranked[0]?.nutrition.per100g.sugars, 8.2);
	assert.equal(enriched.ranked[0]?.supplementaryLabels[0]?.source.url, reference.url);
	const fetchLabel = client.manufacturerLabel;
	client.manufacturerLabel = async (input) => ({ ...(await fetchLabel(input)), gtin: "different" });
	const rejected = await runComparison(input, [stores[0]], client);
	assert.equal(rejected.ranked.length, 0);
	assert.equal(rejected.coverage.labelEnrichmentFailures.length, 1);
	assert.equal(rejected.coverage.completeForRequestedSearches, false);
});

test("comparison paginates, deduplicates GTINs across stores, and never ranks missing added sugar as zero", async () => {
	const s = product(label);
	const k = product({ ...label, chain: "k-ruoka", storeId: "N1", price: 1.5, pricePerKg: 1.5 });
	const unknown = product({ id: "22222222", gtins: ["22222222"], pricePerKg: 0.5 });
	const irrelevant = product({ id: "33333333", name: "Mansikkajogurtti" });
	const result = await runComparison(
		{ queries: ["jogurtti", "vanilja"], includeTerms: ["vanilja"], includeLidl: false },
		stores.map((s) => ({ ...s, name: "Test store" })),
		clientFor([s, k, unknown, irrelevant], 1),
	);
	assert.equal(result.ranked.length, 1);
	assert.equal(result.ranked[0]?.offers.length, 2);
	assert.equal(result.ranked[0]?.bestPricePerKg, 1.5);
	assert.equal(result.otherCandidates[0]?.nutrition.addedSugar.status, "unknown");
	assert.equal(result.coverage.detailsAttempted, 3);
	assert.equal(result.coverage.completeForRequestedSearches, true);
	assert.equal(result.coverage.completeMarketCoverage, false);
});

test("saved comparison location and radius survive omitted CLI fields; explicit selections take precedence", () => {
	const saved = { postalCode: "60100", radiusKm: 8 };
	const input = {
		queries: ["vanilja"],
		postalCode: undefined,
		coordinates: undefined,
		radiusKm: undefined,
	};
	assert.equal(resolveComparisonInput(input, saved).postalCode, "60100");
	assert.equal(resolveComparisonInput(input, saved).radiusKm, 8);
	assert.equal(
		resolveComparisonInput({ ...input, postalCode: "60510", radiusKm: 20 }, saved).postalCode,
		"60510",
	);
	const explicit = resolveComparisonInput({ queries: ["vanilja"], stores: [...stores] }, saved);
	assert.equal(explicit.postalCode, undefined);
	assert.equal(explicit.stores?.length, 2);
});

test("comparison reports pagination limits, detail limits and provider failures without claiming completeness", async () => {
	const products = [
		product(label),
		product({ ...label, id: "22222222", gtins: ["22222222"] }),
		product({ ...label, chain: "k-ruoka", storeId: "N1" }),
	];
	const limited = await runComparison(
		{ queries: ["vanilja"], includeLidl: false, maxPagesPerQuery: 1, maxDetailRequests: 1 },
		[...stores],
		clientFor(products, 1),
	);
	assert.equal(limited.coverage.searches[0]?.status, "truncated");
	assert.equal(limited.coverage.detailsSkipped, 1);
	assert.equal(limited.coverage.completeForRequestedSearches, false);
	const failing = clientFor(products);
	failing.detail = async () => {
		throw new Error("Unavailable");
	};
	const result = await runComparison(
		{ queries: ["vanilja"], includeLidl: false },
		[stores[0]],
		failing,
	);
	assert.equal(result.coverage.detailFailures.length, 2);
	assert.equal(result.ranked.length, 0);
	assert.equal(result.coverage.completeForRequestedSearches, false);
});

test("comparison rejects a search item from the wrong store", async () => {
	const client = clientFor([product()]);
	const search = client.search;
	client.search = async (input) => ({
		...(await search(input)),
		products: [product({ storeId: "2" })],
	});
	const result = await runComparison(
		{ queries: ["vanilja"], includeLidl: false },
		[stores[0]],
		client,
	);
	assert.equal(result.coverage.searches[0]?.status, "failed");
	assert.equal(result.coverage.detailsAttempted, 0);
});

test("total sugar ordering is explicit; cheaper Lidl published offers cannot establish a local winner", async () => {
	const lower = product({
		ingredients: "MAITO, sokeri",
		pricePerKg: 4,
		nutrition: [
			{ basis: "100 g", preparation: null, values: [{ name: "sokereita", value: "4 g" }] },
		],
	});
	const higher = product({
		...lower,
		id: "22222222",
		gtins: ["22222222"],
		pricePerKg: 2,
		nutrition: [
			{ basis: "100 g", preparation: null, values: [{ name: "sokereita", value: "9 g" }] },
		],
	});
	const lidl = product({ ...lower, chain: "lidl", storeId: null, pricePerKg: 0.5 });
	const result = await runComparison(
		{ queries: ["vanilja"], rankBy: "total_sugar_then_price" },
		[stores[0]],
		clientFor([higher, lower, lidl]),
	);
	assert.equal(result.ranked[0]?.id, lower.id);
	assert.equal(result.ranked[0]?.bestPricePerKg, 4);
	assert.equal(result.ranked[0]?.nutrition.addedSugar.gramsPer100g, null);
});

test("loyalty and multipack prices require both opt-ins, known eligibility and valid dates", () => {
	const p = product();
	p.pricing.promotions = [
		{
			price: 4,
			quantity: 4,
			unitPrice: { amount: 1, unit: "kg" },
			requiresMembership: true,
			validFrom: "2026-01-01T00:00:00Z",
			validUntil: "2026-12-31T23:59:59Z",
			inStore: true,
			kind: "multipack",
			conditions: ["PLUSSA", "Requires 4 items"],
		},
	];
	const now = Date.parse("2026-10-31T12:00:00Z");
	for (const options of [
		{ includeLoyaltyPrices: false, allowMultipacks: false },
		{ includeLoyaltyPrices: true, allowMultipacks: false },
		{ includeLoyaltyPrices: false, allowMultipacks: true },
	])
		assert.equal(selectPrice(p, options, now).pricePerKg, 2);
	assert.equal(
		selectPrice(p, { includeLoyaltyPrices: true, allowMultipacks: true }, now).purchaseQuantity,
		4,
	);
	assert.equal(
		selectPrice(p, { includeLoyaltyPrices: true, allowMultipacks: true }, Date.parse("2027-01-01"))
			.pricePerKg,
		2,
	);
});
