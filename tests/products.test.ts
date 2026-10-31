import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as z from "zod/v4";
import { parseKProduct } from "../src/browser/k-ruoka.ts";
import { decodeLidlProduct, parseLidlProduct } from "../src/browser/lidl.ts";
import { parseSProduct } from "../src/browser/s-product.ts";
import { resolveStore, SearchInputSchema } from "../src/groceries.ts";
import { applyPriceValidity } from "../src/grocery-types.ts";

function fixture(name: string) {
	return z
		.record(z.string(), z.unknown())
		.parse(JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), "utf8")));
}
const k = fixture("k-milk");
const s = fixture("s-milk");
const lidl = fixture("lidl-quark");

test("K milk retains store, nutrition basis, allergen and litre price", () => {
	const product = parseKProduct(k, "N106");
	assert.equal(product.price, 0.99);
	assert.deepEqual(product.pricing.unitPrice, { amount: 0.99, unit: "l" });
	assert.equal(product.pricePerKg, null);
	assert.equal(product.nutrition[0]?.basis, "100 g");
	assert.ok(
		product.nutrition[0]?.values.some((v) => v.name === "energyKcal" && v.value === "47 kcal"),
	);
	assert.ok(product.allergens.some((a) => a.name === "Maito"));
	assert.equal(product.availability.stock, "unknown");
});

test("missing K price is unknown and a wrong/missing store is rejected", () => {
	const product = parseKProduct({ ...k, mobilescan: null, availability: null }, "N106");
	assert.equal(product.price, null);
	assert.equal(product.availability.inStore, null);
	assert.throws(() => parseKProduct(k, "K144"), /different or missing store/);
	assert.throws(() => parseKProduct({ ...k, store: undefined }, "N106"), /missing store/);
	assert.throws(() => parseKProduct({}, "N106"));
});

test("kg comparison is numeric and never inferred from a litre", () => {
	const product = parseKProduct(
		{
			...k,
			mobilescan: { pricing: { normal: { price: 2, unitPrice: { value: 4, unit: "kg" } } } },
		},
		"N106",
	);
	assert.equal(product.pricePerKg, 4);
});

test("K standard promotions change current price only while active; loyalty batches remain conditional", () => {
	const promotion = {
		price: 1.5,
		unitPrice: { value: 3, unit: "kg" },
		discountType: "STANDARD",
		startDate: "2026-10-01T00:00:00Z",
		endDate: "2026-10-31T21:59:59Z",
		discountAvailability: { store: true },
	};
	const raw = {
		...k,
		mobilescan: {
			pricing: {
				normal: { price: 2, unitPrice: { value: 4, unit: "kg" } },
				discount: promotion,
				batch: {
					...promotion,
					price: 4,
					amount: 4,
					discountType: "PLUSSA",
					unitPrice: { value: 2, unit: "kg" },
				},
			},
		},
	};
	const active = parseKProduct(raw, "N106", Date.parse("2026-10-31T12:00:00Z"));
	assert.equal(active.price, 1.5);
	assert.equal(active.pricing.regularPrice, 2);
	assert.equal(active.pricePerKg, 3);
	assert.equal(active.pricing.promotions[1]?.quantity, 4);
	assert.equal(active.pricing.promotions[1]?.requiresMembership, true);
	assert.equal(parseKProduct(raw, "N106", Date.parse("2026-11-01")).price, 2);
	applyPriceValidity(active, Date.parse("2026-11-01"));
	assert.equal(active.price, null);
});

test("S milk preserves decimal-comma and zero nutrition values with their basis", () => {
	const product = parseSProduct(s, "513971200");
	assert.equal(product.price, 0.85);
	assert.deepEqual(product.pricing.unitPrice, { amount: 0.85, unit: "l" });
	assert.equal(product.pricePerKg, null);
	assert.equal(product.nutrition[0]?.basis, "100 g");
	assert.ok(product.nutrition[0]?.values.some((v) => v.value === "0 g"));
	assert.ok(product.nutrition[0]?.values.some((v) => v.value === "3,4 g"));
	assert.equal(product.location?.aisle, "1001");
	assert.equal(product.availability.inStore, null);
});

test("S global fallback cannot leak store price or aisle", () => {
	const product = parseSProduct({ ...s, isGlobalFallback: true }, "513971200");
	assert.equal(product.price, null);
	assert.equal(product.pricing.unitPrice, null);
	assert.equal(product.location, null);
	assert.ok(product.ingredients);
	assert.throws(() => parseSProduct(s, "123"), /different store/);
});

test("Lidl published price respects store offer start, expiry and region", () => {
	const upcoming = parseLidlProduct(lidl, Date.parse("2026-10-31T12:00:00Z"));
	assert.equal(upcoming.price, null);
	assert.equal(upcoming.pricing.publishedPrice, 1.99);
	assert.equal(upcoming.pricePerKg, null);
	const active = parseLidlProduct(lidl, Date.parse("2026-11-02T12:00:00Z"));
	assert.equal(active.price, 1.99);
	assert.equal(active.pricePerKg, 3.98);
	assert.ok(active.pricing.conditions.some((c) => c.includes("Järvenpää")));
	assert.equal(active.availability.inStore, null);
	assert.equal(parseLidlProduct(lidl, Date.parse("2026-11-05T12:00:00Z")).price, null);
});

test("conditional Lidl multipack totals are not single-product prices", () => {
	const product = parseLidlProduct(
		{ ...lidl, multipack: true },
		Date.parse("2026-11-02T12:00:00Z"),
	);
	assert.equal(product.price, null);
	assert.equal(product.pricePerKg, null);
	assert.equal(product.pricing.publishedPrice, 1.99);
});

test("a cache cannot extend an offer beyond its published expiry", () => {
	const product = parseLidlProduct(lidl, Date.parse("2026-11-02T12:00:00Z"));
	assert.equal(product.price, 1.99);
	applyPriceValidity(product, Date.parse("2026-11-05T12:00:00Z"));
	assert.equal(product.price, null);
	assert.equal(product.pricePerKg, null);
	assert.equal(product.pricing.unitPrice, null);
	assert.equal(product.pricing.publishedPrice, 1.99);
});

test("Lidl decoder handles references and rejects a malformed product subtree", () => {
	assert.deepEqual(
		decodeLidlProduct([{ productId: 1, canonicalPath: 2, variants: 3 }, 42, "/p/test/p42", []]),
		{ productId: 42, canonicalPath: "/p/test/p42", variants: [] },
	);
	assert.throws(
		() => decodeLidlProduct([{ productId: 1, canonicalPath: 99, variants: 2 }, 42, []]),
		/Invalid Lidl data reference/,
	);
});

test("explicit stores override defaults; stores never silently default to another retailer", () => {
	const env = { K_RUOKA_STORE_ID: "N106", S_KAUPAT_STORE_ID: "513971200" };
	assert.equal(resolveStore("k-ruoka", "K144", env), "K144");
	assert.equal(resolveStore("s-kaupat", undefined, env), "513971200");
	assert.throws(() => resolveStore("k-ruoka", undefined, {}), /Choose a store/);
	assert.throws(() => resolveStore("s-kaupat", "N106", env), /Invalid store/);
	assert.throws(() => resolveStore("lidl", "1", env), /not supported/);
	assert.equal(resolveStore("lidl", undefined, env), null);
	assert.equal(SearchInputSchema.parse({ chain: "lidl", query: " maito " }).limit, 10);
	assert.throws(() => SearchInputSchema.parse({ chain: "lidl", query: "maito", offset: -1 }));
});
