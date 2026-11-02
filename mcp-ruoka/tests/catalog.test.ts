import assert from "node:assert/strict";
import test from "node:test";
import { availabilityOffer, compactCandidates, getProducts } from "../src/catalog.ts";
import { getProduct, getStores, searchProducts } from "../src/groceries.ts";
import { assessNutrition } from "../src/nutrition.ts";
import { getObservationStore } from "../src/observations.ts";
import { product } from "./helpers.ts";

process.env.RUOKA_DB_PATH = ":memory:";

test("compact discovery keeps weak search/category/pagination but omits labels and photos", () => {
	const p = product({
		categoryPath: "broileri/fileet",
		ingredients: "Secret long label",
		imageUrl: "https://example.com/photo",
	});
	const result = compactCandidates({
		chain: "s-kaupat",
		storeId: "1",
		query: "kana",
		products: [p],
		hasGoodResults: false,
		totalCount: 80,
		offset: 0,
		nextOffset: 50,
		coverage: "store-catalog",
		warnings: ["Weak search"],
	});
	assert.equal(result.hasGoodResults, false);
	assert.equal(result.nextOffset, 50);
	assert.equal(result.products[0]?.category, "broileri/fileet");
	assert.equal(JSON.stringify(result).includes("Secret long label"), false);
	assert.equal(JSON.stringify(result).includes("https://example.com/photo"), false);
});
test("batch details deduplicate references and preserve successful products on partial failure", async () => {
	const ids: string[] = [];
	const result = await getProducts(
		{
			products: [
				{ chain: "s-kaupat", storeId: "1", id: "1" },
				{ chain: "s-kaupat", storeId: "1", id: "1" },
				{ chain: "s-kaupat", storeId: "1", id: "2" },
			],
		},
		async (input) => {
			ids.push(input.id);
			if (input.id === "2") throw new Error("offline");
			const p = product({ id: input.id });
			return { ...p, nutritionAssessment: assessNutrition(p) };
		},
	);
	assert.deepEqual(ids, ["1", "2"]);
	assert.equal(result.products.length, 1);
	assert.equal(result.failures[0]?.id, "2");
});
test("unavailable store cannot advertise a purchasable price even when the API supplies one", () => {
	const p = product({
		price: 40.5,
		availability: { inStore: false, online: false, stock: "unknown" },
	});
	assert.equal(availabilityOffer(p, "Päivölä").price, null);
	assert.equal(availabilityOffer(p, "Päivölä").availability.inStore, false);
});
test("persistent directory, normalized discovery and detail caches avoid retailer loads", async () => {
	const db = await getObservationStore();
	db.writeCache(
		"stores-v1:k-ruoka",
		[
			{
				id: "N192",
				name: "K-Citymarket Seinäjoki Ideapark",
				location: "Seinäjoki",
				chain: "k-ruoka",
			},
		],
		Date.now() + 86400000,
	);
	assert.equal((await getStores({ chain: "k-ruoka", city: "Seinäjoki" })).stores[0]?.id, "N192");
	const p = product({ id: "123", storeId: "N192", chain: "k-ruoka" });
	db.writeCache(JSON.stringify(["detail-v2", "k-ruoka", "N192", "123"]), p, Date.now() + 300000);
	assert.equal((await getProduct({ chain: "k-ruoka", storeId: "N192", id: "123" })).id, "123");
	db.writeCache(
		JSON.stringify(["search-v2", "k-ruoka", "N192", "kana filee", 50, 0]),
		{
			chain: "k-ruoka",
			storeId: "N192",
			query: "kana filee",
			products: [p],
			totalCount: 1,
			offset: 0,
			nextOffset: null,
			coverage: "store-catalog",
			warnings: [],
		},
		Date.now() + 300000,
	);
	assert.equal(
		(
			await searchProducts({
				chain: "k-ruoka",
				storeId: "N192",
				query: " KANA   filee ",
				limit: 50,
			})
		).products[0]?.id,
		"123",
	);
	assert.ok(db.cacheStats().hits >= 3);
});
