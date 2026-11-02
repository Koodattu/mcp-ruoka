import assert from "node:assert/strict";
import test from "node:test";
import {
	compareGroceries,
	discoverGroceries,
	inspectGroceries,
} from "../workflow.mjs";

const signal = () => new AbortController().signal;
const store = {
	id: "N192",
	name: "K-Citymarket Seinäjoki Ideapark",
	chain: "k-ruoka",
};
const candidates = [
	{ id: "1", name: "Pirkka kanan munia", category: "munat" },
	{
		id: "2",
		name: "Pirkka kanan fileepihvi maustamaton",
		category: "broileri/fileet-pihvit",
	},
	{
		id: "3",
		name: "Pirkka kanan ohutleike maustamaton",
		category: "broileri/fileet-pihvit",
	},
];
test("comparison passes explicit metrics and limits to the MCP, forwards progress and reports directory failure", async () => {
	const events = [],
		calls = [];
	const mcp = {
		call: async (name, args, _signal, onprogress) => {
			calls.push({ name, args });
			if (name === "get_stores") {
				if (args.chain === "s-kaupat") throw new Error("Directory unavailable");
				return { structuredContent: { stores: [store] } };
			}
			assert.equal(name, "rank_products");
			onprogress({ message: "Checking labels · 90/115" });
			return {
				structuredContent: {
					status: "ranked",
					winnerId: "1",
					products: [],
					coverage: { complete: true },
					warnings: [],
				},
			};
		},
	};
	const r = await compareGroceries(
		{
			queries: ["proteiinipatukka"],
			productKind: "protein_bar",
			sort: [{ metric: "proteinPerItem", direction: "desc" }],
			constraints: [{ metric: "price", max: 2 }],
			fields: ["kcalPerItem"],
		},
		{ mcp, city: "Seinäjoki", signal: signal(), emit: (e) => events.push(e) },
	);
	assert.equal(r.status, "incomplete");
	assert.equal(r.coverage.complete, false);
	assert.equal(r.winnerId, null);
	assert.match(r.limitation, /directory failed/);
	const input = calls.find((c) => c.name === "rank_products").args;
	assert.deepEqual(input.fields, ["kcalPerItem"]);
	assert.deepEqual(input.constraints, [{ metric: "price", max: 2 }]);
	assert.equal(input.stores[0].storeId, "N192");
	assert.ok(events.some((e) => e.text.includes("90/115")));
});
test("discovery preserves the long candidate list, weak-match warning and pagination without fetching details", async () => {
	const calls = [];
	const mcp = {
		call: async (name, args) => {
			calls.push({ name, args });
			if (name === "get_stores")
				return { structuredContent: { stores: [store] } };
			assert.equal(name, "discover_products");
			return {
				structuredContent: {
					chain: store.chain,
					storeId: store.id,
					products: candidates,
					totalCount: 80,
					nextOffset: 50,
					hasGoodResults: false,
					warnings: ["Weak search"],
					cache: { hits: 1, misses: 0 },
				},
			};
		},
	};
	const result = await discoverGroceries(
		{ query: "pirkka kana", chain: "k-ruoka" },
		{ mcp, city: "Seinäjoki", signal: signal() },
	);
	assert.deepEqual(
		result.products.map((p) => p.id),
		["1", "2", "3"],
	);
	assert.equal(result.searches[0].hasGoodResults, false);
	assert.equal(result.searches[0].nextOffset, 50);
	assert.equal(calls.length, 2);
	assert.equal(result.cache.hits, 1);
});
test("inspection only loads the selected IDs and retains nutrition, availability and partial failures", async () => {
	let refs;
	const mcp = {
		call: async (name, args) => {
			if (name === "get_stores")
				return { structuredContent: { stores: [store] } };
			assert.equal(name, "get_products");
			refs = args.products;
			return {
				structuredContent: {
					products: [
						{
							...candidates[1],
							chain: "k-ruoka",
							storeId: "N192",
							imageUrl: "https://example.com/image",
							availability: { inStore: false, online: false, stock: "unknown" },
							nutrition: [
								{
									basis: "100 g",
									preparation: null,
									values: [{ name: "protein", value: "22 g" }],
								},
							],
							nutritionAssessment: { per100g: { protein: 22 } },
							source: {
								url: "https://example.com/2",
								fetchedAt: "2026-11-02T10:00:00Z",
							},
						},
					],
					failures: [{ id: "3", error: "Temporarily unavailable" }],
					cache: { hits: 1, misses: 1 },
				},
			};
		},
	};
	const result = await inspectGroceries(
		{
			products: [
				{ chain: "k-ruoka", storeId: "N192", id: "2" },
				{ chain: "k-ruoka", storeId: "N192", id: "3" },
			],
		},
		{ mcp, signal: signal() },
	);
	assert.deepEqual(
		refs.map((p) => p.id),
		["2", "3"],
	);
	assert.equal(result.products[0].store.name, store.name);
	assert.equal(result.products[0].nutritionPer100g.protein, 22);
	assert.equal(result.products[0].availability.inStore, false);
	assert.equal("unmetRequirements" in result.products[0], false);
	assert.equal(result.failures[0].id, "3");
});
test("discovery handles missing location and cancellation without contacting retailers", async () => {
	const mcp = {
		call() {
			assert.fail("No calls expected");
		},
	};
	assert.equal(
		(await discoverGroceries({ query: "kana" }, { mcp, signal: signal() }))
			.status,
		"needs_location",
	);
	const controller = new AbortController();
	controller.abort(new Error("Stopped"));
	await assert.rejects(
		discoverGroceries(
			{ query: "kana" },
			{ mcp, city: "Seinäjoki", signal: controller.signal },
		),
		/Stopped/,
	);
});
