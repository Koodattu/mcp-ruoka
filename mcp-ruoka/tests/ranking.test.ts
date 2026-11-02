import assert from "node:assert/strict";
import test from "node:test";
import { CACHE_MS, offerExpiry } from "../src/cache-policy.ts";
import type { GroceryProduct } from "../src/grocery-types.ts";
import { ObservationStore } from "../src/observations.ts";
import { packageSize } from "../src/package-size.ts";
import { type RankingClient, runRanking } from "../src/ranking.ts";
import { product } from "./helpers.ts";

const stores = [
	{ chain: "s-kaupat" as const, storeId: "1", name: "Prisma" },
	{ chain: "k-ruoka" as const, storeId: "N1", name: "Citymarket" },
] as const;
const base = {
	queries: ["proteiinipatukka"],
	productKind: "protein_bar" as const,
	stores: [...stores],
	sort: [
		{ metric: "proteinPerItem" as const, direction: "desc" as const },
		{ metric: "price" as const, direction: "asc" as const },
	],
};
function bar(i: number, chain: "s-kaupat" | "k-ruoka" = "s-kaupat") {
	const id = String(10000000 + i),
		price = i === 9 && chain === "k-ruoka" ? 1.2 : 2;
	const p = product({
		id,
		gtins: [id],
		name: `Protein bar ${i} 50 g`,
		chain,
		storeId: chain === "k-ruoka" ? "N1" : "1",
		price,
		pricePerKg: price * 20,
	});
	p.pricing.unitPrice = { amount: price * 20, unit: "kg" };
	p.source.url = `https://example.test/${chain}/${id}`;
	p.nutrition = [
		{
			basis: "100 g",
			preparation: null,
			values: [
				{ name: "protein", value: `${i === 9 ? 50 : 20} g` },
				{ name: "energyKcal", value: "300 kcal" },
			],
		},
	];
	p.ingredients = "milk protein";
	return p;
}
function harness(db: ObservationStore, count = 10) {
	const calls = {
		searches: [] as Array<{ refresh: boolean; offset: number; storeId: string }>,
		labels: 0,
	};
	const client: RankingClient = {
		search: async (args) => {
			calls.searches.push(args);
			const products = Array.from({ length: count }, (_, i) => bar(i, args.chain)).slice(
				args.offset,
				args.offset + 5,
			);
			return {
				chain: args.chain,
				storeId: args.storeId,
				query: args.query,
				products,
				totalCount: count,
				offset: args.offset,
				nextOffset: args.offset + 5 < count ? args.offset + 5 : null,
				coverage: "store-catalog",
				warnings: [],
			};
		},
		cachedLabel: async (p) => db.readLabel(p),
		label: async (p) => {
			calls.labels++;
			db.record([p], "detail");
			return p;
		},
	};
	return { client, calls };
}
test("page-two winner is found across all products, cheapest store chosen, only selected metrics returned, labels reused", async () => {
	const db = await ObservationStore.open(":memory:");
	try {
		const { client, calls } = harness(db);
		const result = await runRanking(
			{
				...base,
				fields: ["kcalPerItem"],
				constraints: [{ metric: "price", max: 2 }],
				freshness: "current_prices",
				limit: 3,
			},
			client,
		);
		assert.equal(result.status, "ranked");
		assert.equal(result.coverage.complete, true);
		assert.equal(result.coverage.listings, 20);
		assert.equal(result.coverage.distinctProducts, 10);
		assert.equal(result.products[0]?.id, "10000009");
		assert.equal(result.products[0]?.store.chain, "k-ruoka");
		assert.deepEqual(result.products[0]?.metrics, {
			kcalPerItem: 150,
			proteinPerItem: 25,
			price: 1.2,
		});
		const winner = result.products[0];
		assert.ok(winner);
		assert.equal("ingredients" in winner, false);
		assert.equal("nutrition" in winner, false);
		assert.equal(calls.searches.length, 8);
		assert.ok(calls.searches.every((c) => c.refresh));
		assert.equal(calls.labels, 10);
		const again = await runRanking(base, client);
		assert.equal(again.products[0]?.id, "10000009");
		assert.equal(calls.labels, 10);
		assert.equal(again.coverage.labelsReused, 10);
	} finally {
		db.close();
	}
});
test("price-only sorting skips labels; hard purchase cap prunes without truncating the search", async () => {
	const db = await ObservationStore.open(":memory:");
	try {
		const { client, calls } = harness(db);
		const result = await runRanking(
			{ ...base, sort: [{ metric: "price", direction: "asc" }], fields: ["sizeG"] },
			client,
		);
		assert.equal(result.products[0]?.id, "10000009");
		assert.equal(calls.labels, 0);
		assert.deepEqual(result.products[0]?.metrics, { sizeG: 50, price: 1.2 });
		await runRanking({ ...base, constraints: [{ metric: "price", max: 1.5 }] }, client);
		assert.equal(calls.labels, 1);
	} finally {
		db.close();
	}
});
test("missing labels, weak results, repeated pagination and budget exhaustion cannot produce a definitive winner", async () => {
	const db = await ObservationStore.open(":memory:");
	try {
		const { client } = harness(db);
		const missing = { ...client, label: async (p: GroceryProduct) => ({ ...p, nutrition: [] }) };
		assert.equal((await runRanking(base, missing)).coverage.complete, false);
		const weak: RankingClient = {
			...client,
			search: async (a, b) => ({ ...(await client.search(a, b)), hasGoodResults: false }),
		};
		assert.equal((await runRanking(base, weak)).status, "incomplete");
		const repeated: RankingClient = {
			...client,
			search: async (a, b) => ({ ...(await client.search(a, b)), nextOffset: a.offset }),
		};
		assert.equal((await runRanking(base, repeated)).status, "incomplete");
		assert.equal(
			(await runRanking(base, { ...client, cachedLabel: async () => null }, { maxLabels: 2 }))
				.status,
			"incomplete",
		);
		await assert.rejects(
			runRanking(base, client, { signal: AbortSignal.abort(new Error("stopped")) }),
			/stopped/,
		);
	} finally {
		db.close();
	}
});
test("tradeoffs keep incomparable choices, remove dominated bars and never invent an overall winner", async () => {
	const db = await ObservationStore.open(":memory:");
	try {
		const { client } = harness(db, 3);
		client.search = async (args) => {
			const products = [bar(0), bar(1), bar(2)];
			const cheap = products[0],
				strong = products[1];
			assert.ok(cheap && strong);
			cheap.price = 1;
			strong.nutrition = [
				{ basis: "100 g", preparation: null, values: [{ name: "protein", value: "40 g" }] },
			];
			return {
				chain: args.chain,
				storeId: args.storeId,
				query: args.query,
				products,
				totalCount: 3,
				offset: 0,
				nextOffset: null,
				coverage: "store-catalog",
				warnings: [],
			};
		};
		const r = await runRanking(
			{
				...base,
				stores: [stores[0]],
				mode: "tradeoffs",
				sort: [
					{ metric: "price", direction: "asc" },
					{ metric: "proteinPerItem", direction: "desc" },
				],
			},
			client,
		);
		assert.equal(r.status, "choose_priority");
		assert.deepEqual(
			r.products.map((p) => p.id),
			["10000000", "10000001"],
		);
		assert.equal(r.leaders?.length, 2);
	} finally {
		db.close();
	}
});
test("labels outlive offers, retain their timestamp, and expire after 30 days", async () => {
	const db = await ObservationStore.open(":memory:");
	try {
		const p = bar(0),
			now = Date.now();
		p.source.fetchedAt = new Date(now - 86400_000).toISOString();
		db.record([p], "detail");
		assert.equal(db.readProduct(p.chain, p.storeId, p.id, now), null);
		assert.equal(db.readLabel(p, now)?.source.fetchedAt, p.source.fetchedAt);
		assert.equal(db.readLabel(p, now + CACHE_MS.labels), null);
	} finally {
		db.close();
	}
});
test("package normalization distinguishes per-item and total mass and rejects ambiguous quantities", () => {
	assert.deepEqual(packageSize("Protein bar 12 x 55 g")?.totalG, 660);
	assert.equal(packageSize("Protein bar 12x55g 660g")?.itemG, 55);
	assert.equal(packageSize("Protein bar 4 kpl 200 g")?.itemG, 50);
	assert.equal(packageSize("Jogurtti 1,5 kg")?.totalG, 1500);
	assert.equal(packageSize("Protein bar 50g / 60g"), null);
	assert.equal(packageSize("Protein drink 330ml"), null);
	assert.equal(packageSize("Protein multipack 500g"), null);
});

test("fresh offers compose with older labels without changing the label timestamp, and size changes invalidate labels", async () => {
	const db = await ObservationStore.open(":memory:");
	try {
		const old = bar(0);
		old.source.fetchedAt = new Date(Date.now() - 86400_000).toISOString();
		db.record([old], "detail");
		const fresh = bar(0);
		fresh.price = 1.1;
		fresh.nutrition = [];
		db.record([fresh], "search");
		const combined = db.readProduct("s-kaupat", "1", old.id);
		assert.equal(combined?.price, 1.1);
		assert.equal(combined?.source.fetchedAt, fresh.source.fetchedAt);
		assert.equal(combined?.labelSource?.fetchedAt, old.source.fetchedAt);
		assert.ok(combined?.nutrition.length);
		assert.equal(db.readLabel({ ...fresh, name: "Protein bar 60 g" }), null);
	} finally {
		db.close();
	}
});

test("bounded batches reuse prefetched labels and preserve a global label without inventing a local offer", async () => {
	const db = await ObservationStore.open(":memory:");
	try {
		const { client } = harness(db, 10);
		const sizes: number[] = [];
		client.labels = async (products) => {
			sizes.push(products.length);
			db.record(products, "detail");
			return { products, failures: [] };
		};
		const r = await runRanking(base, client);
		assert.deepEqual(sizes, [8, 2]);
		assert.equal(r.coverage.labelsFetched, 10);
		assert.equal(r.coverage.labelRequests, 2);
		assert.equal(r.coverage.complete, true);
	} finally {
		db.close();
	}
	const db2 = await ObservationStore.open(":memory:");
	try {
		const p = bar(9, "k-ruoka");
		p.nutrition = p.nutrition.map((t) => ({ ...t, preparation: "Valmistettuna" }));
		const client: RankingClient = {
			search: async (args) => ({
				chain: args.chain,
				storeId: args.storeId,
				query: args.query,
				products: args.chain === "k-ruoka" ? [p] : [],
				totalCount: args.chain === "k-ruoka" ? 1 : 0,
				offset: 0,
				nextOffset: null,
				coverage: "store-catalog",
				warnings: [],
			}),
			cachedLabel: async (p) => db2.readLabel(p),
			label: async (p) => (p.chain === "s-kaupat" ? { ...bar(9), price: null } : p),
		};
		const r = await runRanking(base, client);
		assert.equal(r.coverage.complete, true);
		assert.equal(r.products[0]?.store.chain, "k-ruoka");
		assert.equal(r.products[0]?.metrics.price, 1.2);
		assert.equal(r.products[0]?.otherOffers.length, 0);
	} finally {
		db2.close();
	}
});

test("price cache expires at a promotion boundary instead of extending it for six hours", () => {
	const p = bar(1),
		now = Date.now();
	p.pricing.validUntil = new Date(now + 60000).toISOString();
	assert.equal(offerExpiry([p], now), now + 60000);
});

test("a repeated bounded comparison makes progress past cached products instead of stopping at the same prefix", async () => {
	const db = await ObservationStore.open(":memory:");
	try {
		const { client } = harness(db, 10);
		const first = await runRanking(base, client, { maxLabels: 2 });
		const second = await runRanking(base, client, { maxLabels: 2 });
		assert.equal(first.coverage.labelAttempts, 2);
		assert.equal(second.coverage.labelAttempts, 2);
		assert.ok(second.coverage.unresolved < first.coverage.unresolved);
		assert.ok(second.coverage.labelsReused >= 2);
	} finally {
		db.close();
	}
});

test("historical offers cannot resurrect a price across a promotion boundary", async () => {
	const db = await ObservationStore.open(":memory:");
	try {
		const p = bar(1),
			now = Date.now();
		p.source.fetchedAt = new Date(now - 60000).toISOString();
		p.pricing.validUntil = new Date(now - 1000).toISOString();
		db.record([p], "detail");
		assert.equal(db.readProduct(p.chain, p.storeId, p.id, now), null);
		assert.ok(db.readLabel(p, now));
		p.pricing.validUntil = null;
		p.pricing.promotions = [
			{
				price: 1,
				quantity: 1,
				kind: "single",
				requiresMembership: false,
				inStore: true,
				unitPrice: null,
				conditions: [],
				validFrom: new Date(now - 1000).toISOString(),
				validUntil: null,
			},
		];
		assert.equal(offerExpiry([p], now), now - 1000);
	} finally {
		db.close();
	}
});

test("an ambiguous multipack cannot win a single-bar price comparison", async () => {
	const db = await ObservationStore.open(":memory:");
	try {
		const { client } = harness(db, 1),
			search = client.search;
		client.search = async (args, options) => {
			const result = await search(args, options);
			result.products = result.products.map((p) => ({ ...p, name: "Protein bar multipack 500g" }));
			return result;
		};
		const r = await runRanking({ ...base, sort: [{ metric: "price", direction: "asc" }] }, client);
		assert.equal(r.coverage.complete, false);
		assert.equal(r.winnerId, null);
		assert.equal(r.coverage.labelRequests, 0);
		assert.equal(r.coverage.unresolved, 1);
	} finally {
		db.close();
	}
});

test("general protein-bar searches include both retailer synonyms and deduplicate their results", async () => {
	const db = await ObservationStore.open(":memory:");
	try {
		const { client } = harness(db, 2),
			search = client.search;
		const queries: string[] = [];
		client.search = async (args, options) => {
			queries.push(args.query);
			const result = await search(args, options);
			if (args.query === "protein bar") {
				result.products = [bar(0, args.chain), bar(9, args.chain)];
				result.totalCount = 2;
			}
			return result;
		};
		const r = await runRanking(base, client);
		assert.equal(r.winnerId, "10000009");
		assert.equal(r.coverage.distinctProducts, 3);
		assert.equal(r.coverage.labelRequests, 3);
		assert.deepEqual([...new Set(queries)], ["proteiinipatukka", "protein bar"]);
		queries.length = 0;
		await runRanking({ ...base, queries: ["Barebells"] }, client);
		assert.deepEqual([...new Set(queries)], ["barebells"]);
	} finally {
		db.close();
	}
});

test("spoonable yogurt comparison excludes drinkable yogurt before fetching labels", async () => {
	const db = await ObservationStore.open(":memory:");
	try {
		const { client, calls } = harness(db, 2),
			search = client.search;
		client.search = async (args, options) => {
			const result = await search(args, options);
			result.products = result.products.map((p, i) => ({
				...p,
				name: i ? "Juotava jogurtti 200 g" : "Kreikkalainen jogurtti 200 g",
			}));
			return result;
		};
		const r = await runRanking({ ...base, queries: ["jogurtti"], productKind: "yogurt" }, client);
		assert.equal(r.coverage.distinctProducts, 1);
		assert.equal(r.coverage.excludedListings, 2);
		assert.equal(calls.labels, 1);
		assert.equal(r.winnerId, "10000000");
	} finally {
		db.close();
	}
});
