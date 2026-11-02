import assert from "node:assert/strict";
import test from "node:test";
import { cities, resolveCity } from "../cities.mjs";
import { findGroceries, lactoseEvidence } from "../search.mjs";

const signal = () => AbortSignal.timeout(10000);
const input = {
	categoryQuery: "jogurtti",
	queries: ["proteiinijogurtti"],
	productKind: "yogurt",
	lactoseFree: true,
	rankBy: "protein",
	chain: "s-kaupat",
};
const store = { id: "123", chain: "s-kaupat", name: "Prisma Seinäjoki" };
function product(id, name, protein, extra = {}) {
	return {
		id,
		name,
		chain: store.chain,
		storeId: store.id,
		gtins: [id],
		price: 1.5,
		pricing: { unitPrice: { amount: 6, unit: "kg" }, conditions: [] },
		claims: ["Laktoositon"],
		ingredients: "Maito, jogurttihapate",
		nutritionAssessment: {
			per100g: { protein, sugars: 4 },
			sweeteners: { status: "not_detected" },
		},
		source: {
			url: `https://example.com/${id}`,
			fetchedAt: "2026-11-01T10:00:00Z",
		},
		availability: { stock: "unknown", inStore: null },
		...extra,
	};
}
function fakeMcp({
	targeted = [],
	broad = [],
	details = [],
	searchError = false,
	stores = [store],
} = {}) {
	const calls = [];
	return {
		calls,
		async call(name, args) {
			calls.push({ name, args });
			if (name === "get_stores")
				return { structuredContent: { stores, warnings: [] } };
			if (name === "search_products") {
				if (searchError)
					return {
						isError: true,
						content: [{ type: "text", text: "Provider unavailable" }],
					};
				const products = args.query === "jogurtti" ? broad : targeted;
				return {
					structuredContent: {
						chain: args.chain,
						storeId: args.storeId,
						products,
						nextOffset: null,
					},
				};
			}
			if (name === "get_product")
				return { structuredContent: details.find((p) => p.id === args.id) };
			throw new Error(`Unexpected tool: ${name}`);
		},
	};
}

test("regression: protein yogurt search checks labels even when names lack protein or lactose-free", async () => {
	const greek = product("1", "Kreikkalainen jogurtti", 8);
	const higher = product("2", "Maustamaton jogurtti", 12, {
		imageUrl: "https://images.example.com/yogurt.png",
	});
	const unverified = product("3", "Proteiinijogurtti", 20, { claims: [] });
	const quark = product("4", "Proteiinirahka laktoositon", 15);
	const mcp = fakeMcp({
		targeted: [greek, unverified, quark],
		broad: [greek, higher],
		details: [greek, higher, unverified, quark],
	});
	const result = await findGroceries(input, {
		mcp,
		city: "Seinäjoki",
		signal: signal(),
	});
	assert.equal(result.status, "matches");
	assert.deepEqual(
		result.products.map((p) => p.id),
		["2", "1"],
	);
	assert.equal(result.products[0].nutritionPer100g.protein, 12);
	assert.equal(
		result.products[0].imageUrl,
		"https://images.example.com/yogurt.png",
	);
	assert.equal(result.products[1].imageUrl, null);
	assert.equal(result.unverified[0].id, "3");
	assert.match(result.unverified[0].unmetRequirements[0], /lactose-free/);
	assert.ok(
		mcp.calls.some(
			(c) => c.name === "search_products" && c.args.query === "jogurtti",
		),
	);
	assert.ok(
		!mcp.calls.some((c) => c.name === "get_product" && c.args.id === "4"),
	);
	assert.equal(result.coverage.detailsAttempted, 3);
	assert.equal(result.coverage.completeMarketCoverage, false);
});

test("retailer nutrition marked prepared is retained with its exclusion reason", async () => {
	const tables = [
		{
			basis: "100 g",
			preparation: "Valmistettuna",
			values: [
				{ name: "protein", value: "2.7 g" },
				{ name: "carbohydratesSugar", value: "7.9 g" },
			],
		},
	];
	const warning =
		"Prepared-product nutrition was not used to rank an as-sold product.";
	const yogurt = product(
		"6408652226641",
		"Juustoportti Hyvin mango jogurtti",
		null,
		{
			nutrition: tables,
			nutritionAssessment: {
				per100g: { protein: null, sugars: null },
				warnings: [warning],
			},
		},
	);
	const result = await findGroceries(
		{ ...input, rankBy: "sugar" },
		{
			mcp: fakeMcp({ targeted: [yogurt], broad: [yogurt], details: [yogurt] }),
			city: "Seinäjoki",
			signal: signal(),
		},
	);
	assert.equal(result.status, "no_verified_matches");
	assert.deepEqual(result.unverified[0].nutritionTables, tables);
	assert.deepEqual(result.unverified[0].nutritionWarnings, [warning]);
	assert.match(
		result.unverified[0].unmetRequirements[0],
		/Label nutrition is available/,
	);
	assert.equal(result.unverified[0].nutritionPer100g.sugars, null);
});

test("unknown claims and ingredients stay unverified; no search results and rejected results are distinct", async () => {
	const missing = product("1", "Jogurtti", 8, {
		claims: [],
		ingredients: null,
	});
	const mcp = fakeMcp({
		targeted: [missing],
		broad: [missing],
		details: [missing],
	});
	const result = await findGroceries(
		{ ...input, excludeSweeteners: true },
		{ mcp, city: "Seinäjoki", signal: signal() },
	);
	assert.equal(result.status, "no_verified_matches");
	assert.equal(result.unverified[0].unmetRequirements.length, 2);
	assert.equal(result.coverage.detailsAttempted, 1);
	const empty = await findGroceries(input, {
		mcp: fakeMcp(),
		city: "Seinäjoki",
		signal: signal(),
	});
	assert.equal(empty.status, "no_search_results");
	const failed = await findGroceries(input, {
		mcp: fakeMcp({ searchError: true }),
		city: "Seinäjoki",
		signal: signal(),
	});
	assert.equal(failed.status, "provider_failure");
	assert.equal(failed.failures.length, 1);
});

test("numeric comparisons broaden even with several initial matches; yogurt drinks stay separate", async () => {
	const expensive = [
		product("1", "Jogurtti A", 5),
		product("2", "Jogurtti B", 5),
		product("3", "Jogurtti C", 5),
	];
	const cheap = product("4", "Jogurtti D", 8, {
		pricing: { unitPrice: { amount: 2, unit: "kg" } },
	});
	const drink = product("5", "Proteiinijogurttijuoma", 20);
	const mcp = fakeMcp({
		targeted: [...expensive, drink],
		broad: [cheap],
		details: [...expensive, cheap, drink],
	});
	const result = await findGroceries(
		{ ...input, rankBy: "price" },
		{ mcp, city: "Seinäjoki", signal: signal() },
	);
	assert.equal(result.products[0].id, "4");
	assert.equal(result.coverage.searches.length, 2);
	assert.ok(
		!mcp.calls.some((c) => c.name === "get_product" && c.args.id === "5"),
	);
});

test("explicit city overrides selection, store names resolve internally, and missing city asks for location", async () => {
	const mcp = fakeMcp();
	await findGroceries(
		{ ...input, city: "Helsingfors", storeName: "Prisma" },
		{ mcp, city: "Seinäjoki", signal: signal() },
	);
	assert.deepEqual(mcp.calls[0].args, { chain: "s-kaupat", city: "Helsinki" });
	const noCity = fakeMcp();
	const result = await findGroceries(input, {
		mcp: noCity,
		city: null,
		signal: signal(),
	});
	assert.equal(result.status, "needs_location");
	assert.equal(noCity.calls.length, 0);
	await assert.rejects(
		findGroceries(
			{ ...input, city: "invented city 123" },
			{ mcp, signal: signal() },
		),
		/City not found/,
	);
});

test("dietary words cannot become mandatory name filters", async () => {
	await assert.rejects(
		findGroceries(
			{ ...input, nameTerms: ["laktoositon", "proteiin"] },
			{ mcp: fakeMcp(), city: "Seinäjoki", signal: signal() },
		),
		/cannot be nameTerms/,
	);
});

test("lactose-free requires explicit evidence, not low lactose or missing allergens", () => {
	assert.equal(lactoseEvidence({ name: "Vähälaktoosinen jogurtti" }), null);
	assert.equal(lactoseEvidence({ name: "Jogurtti", allergens: [] }), null);
	assert.equal(lactoseEvidence({ name: "Ei ole laktoositon jogurtti" }), null);
	assert.equal(
		lactoseEvidence({
			name: "Lactose-free yogurt",
			description: "Not lactose-free",
		}),
		null,
	);
	assert.equal(
		lactoseEvidence({ name: "Jogurtti", claims: ["Laktoositon"] }),
		"Laktoositon",
	);
});

test("numeric price ranking uses litres for liquids and never orders mixed units as equivalent", async () => {
	const a = product("1", "Kaurajuoma A", 1, {
		pricing: { unitPrice: { amount: 2, unit: "l" } },
	});
	const b = product("2", "Kaurajuoma B", 1, {
		pricing: { unitPrice: { amount: 1, unit: "l" } },
	});
	const mcp = fakeMcp({ targeted: [a, b], details: [a, b] });
	const result = await findGroceries(
		{ categoryQuery: "kaurajuoma", rankBy: "price", chain: "s-kaupat" },
		{ mcp, city: "Seinäjoki", signal: signal() },
	);
	assert.deepEqual(
		result.products.map((p) => p.id),
		["2", "1"],
	);
	b.pricing.unitPrice.unit = "kg";
	const mixed = await findGroceries(
		{ categoryQuery: "kaurajuoma", rankBy: "price", chain: "s-kaupat" },
		{ mcp, city: "Seinäjoki", signal: signal() },
	);
	assert.match(mixed.ranking, /no overall ranking/);
});

test("detail requests are bounded and cancelled requests stop immediately", async () => {
	const items = Array.from({ length: 15 }, (_, i) =>
		product(String(i), "Jogurtti", i),
	);
	const mcp = fakeMcp({ targeted: items, broad: items, details: items });
	const result = await findGroceries(input, {
		mcp,
		city: "Seinäjoki",
		signal: signal(),
		maxDetails: 4,
	});
	assert.equal(mcp.calls.filter((c) => c.name === "get_product").length, 4);
	assert.equal(result.coverage.budgetReached, true);
	const controller = new AbortController();
	controller.abort(new Error("Stopped"));
	await assert.rejects(
		findGroceries(input, { mcp, city: "Seinäjoki", signal: controller.signal }),
		/Stopped/,
	);
});

test("city suggestions use existing municipality names and resolve local/Swedish aliases", () => {
	assert.ok(cities.includes("Seinäjoki"));
	assert.equal(resolveCity("seinajoki"), "Seinäjoki");
	assert.equal(resolveCity("Helsingfors"), "Helsinki");
	assert.equal(resolveCity("Hyllykallio"), "Seinäjoki");
	assert.throws(() => resolveCity(""));
});
