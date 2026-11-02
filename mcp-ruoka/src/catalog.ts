import * as z from "zod/v4";
import { getNearbyAvailability } from "./browser/k-ruoka.ts";
import {
	getProduct,
	getStores,
	ProductInputSchema,
	type SearchInputSchema,
	searchProducts,
} from "./groceries.ts";
import type { GroceryProduct, GrocerySearchResult } from "./grocery-types.ts";
import { getObservationStore } from "./observations.ts";

export function compactCandidates(result: GrocerySearchResult) {
	return {
		...result,
		products: result.products.map((p) => ({
			id: p.id,
			chain: p.chain,
			storeId: p.storeId,
			name: p.name,
			category: p.categoryPath ?? p.category,
			brand: p.brand,
			price: p.price,
			unitPrice: p.pricing.unitPrice,
			availability: p.availability,
			checkedAt: p.source.fetchedAt,
		})),
	};
}

export async function discoverProducts(input: z.input<typeof SearchInputSchema>) {
	const db = await getObservationStore();
	const before = db.cacheStats();
	const result = compactCandidates(await searchProducts(input));
	const after = db.cacheStats();
	return {
		...result,
		cache: { hits: after.hits - before.hits, misses: after.misses - before.misses },
	};
}

export const ProductsInputSchema = z
	.object({ products: z.array(ProductInputSchema).min(1).max(8) })
	.strict();
export async function getProducts(input: z.input<typeof ProductsInputSchema>, load = getProduct) {
	const { products: requested } = ProductsInputSchema.parse(input);
	const products = [],
		failures = [];
	const seen = new Set<string>();
	const db = await getObservationStore(),
		before = db.cacheStats();
	for (const item of requested) {
		const key = JSON.stringify([item.chain, item.storeId, item.id]);
		if (seen.has(key)) continue;
		seen.add(key);
		try {
			products.push(await load(item));
		} catch (error) {
			failures.push({
				...item,
				error: error instanceof Error ? error.message : "Product lookup failed",
			});
		}
	}
	const after = db.cacheStats();
	return {
		products,
		failures,
		cache: { hits: after.hits - before.hits, misses: after.misses - before.misses },
	};
}

export const AvailabilityInputSchema = z
	.object({
		chain: z.literal("k-ruoka"),
		id: z.string().regex(/^\d{1,14}$/),
		storeId: z.string().regex(/^N\d+$/),
		nearby: z.boolean().default(false),
		refresh: z.boolean().default(false),
	})
	.strict();
export function availabilityOffer(product: GroceryProduct, storeName: string) {
	return {
		id: product.id,
		name: product.name,
		store: { id: product.storeId, name: storeName, chain: product.chain },
		availability: product.availability,
		checkedAt: product.source.fetchedAt,
		source: product.source,
		price: product.availability.inStore === false ? null : product.price,
	};
}
const AvailabilityResultSchema = z.object({
	product: z.object({
		id: z.string(),
		name: z.string(),
		store: z.object({ id: z.string().nullable(), name: z.string(), chain: z.string() }),
		availability: z.object({
			inStore: z.boolean().nullable(),
			online: z.boolean().nullable(),
			stock: z.literal("unknown"),
		}),
		checkedAt: z.string(),
		source: z.object({ url: z.string(), fetchedAt: z.string() }),
		price: z.number().nullable(),
	}),
	nearby: z
		.object({
			distanceLimitInKm: z.number(),
			nearestDistance: z.number().nullable(),
			storesWithAvailability: z.array(
				z.object({ id: z.string(), name: z.string(), location: z.string() }),
			),
		})
		.nullable(),
	warning: z.string(),
});
export async function getProductAvailability(input: z.input<typeof AvailabilityInputSchema>) {
	const args = AvailabilityInputSchema.parse(input),
		db = await getObservationStore();
	const key = JSON.stringify(["availability-v1", args.id, args.storeId, args.nearby]);
	const cached = args.refresh ? null : db.readCache(key, AvailabilityResultSchema);
	if (cached) return { ...cached, cache: { hits: 1, misses: 0 } };
	const p = await getProduct({
		chain: args.chain,
		id: args.id,
		storeId: args.storeId,
		refresh: true,
	});
	const directory = await getStores({ chain: "k-ruoka" });
	const result = {
		product: availabilityOffer(
			p,
			directory.stores.find((s) => s.id === args.storeId)?.name ?? args.storeId,
		),
		nearby: args.nearby ? await getNearbyAvailability(args.id, args.storeId) : null,
		warning:
			"Retailer availability flags, not a shelf count. Nearby alternatives exclude the reference store and are limited to the reported radius; omission alone is not proof of unavailability.",
	};
	db.writeCache(key, result, Date.now() + 60_000);
	return { ...result, cache: { hits: 0, misses: 1 } };
}
