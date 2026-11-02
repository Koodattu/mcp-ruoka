import assert from "node:assert/strict";
import { closeBrowser, getProduct, getStores, searchProducts } from "../src/groceries.ts";

// Explicit opt-in live check. Prices and product availability are intentionally not asserted.
try {
	for (const chain of ["k-ruoka", "s-kaupat"] as const) {
		const result = await searchProducts({ chain, query: "maito", limit: 2 });
		assert.ok(result.products.length, `${chain}: no milk search results`);
		const first = result.products[0];
		assert.ok(first);
		const product = await getProduct({ chain, id: first.id });
		assert.equal(product.storeId, result.storeId);
		assert.equal(product.id, first.id);
		const stores = await getStores({ chain, city: "Helsinki" });
		assert.ok(stores.stores.length, `${chain}: no Helsinki stores`);
		assert.ok(
			stores.stores.every((store) => store.location.toLowerCase().includes("helsinki")),
			`${chain}: city filter included a store outside Helsinki`,
		);
		process.stdout.write(
			`${JSON.stringify({ chain, searchCount: result.totalCount, product: product.id, nutritionTables: product.nutrition.length, stores: stores.stores.length })}\n`,
		);
	}
	const search = await searchProducts({ chain: "lidl", query: "juustokierre" });
	assert.ok(search.products.length, "Lidl bakery search returned no results");
	const first = search.products[0];
	assert.ok(first);
	const product = await getProduct({ chain: "lidl", id: first.id });
	assert.equal(product.storeId, null);
	assert.equal(product.availability.stock, "unknown");
	assert.ok(product.labelText, "Lidl bakery label missing");
	process.stdout.write(
		`${JSON.stringify({ chain: "lidl", product: product.id, labelCharacters: product.labelText.length })}\n`,
	);
} finally {
	await closeBrowser();
}
