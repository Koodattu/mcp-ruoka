import * as z from "zod/v4";
import type { GrocerySearchResult } from "../grocery-types.ts";
import { logger } from "../logger.ts";
import type { Store } from "../types.ts";
import { requestJson } from "./request.ts";
import { parseSProduct } from "./s-product.ts";

export { getProduct } from "./s-product.ts";

import { getContext } from "./session.ts";

const ORIGIN = "https://www.s-kaupat.fi";
const API_URL = "https://api.s-kaupat.fi/";

const ExtensionsParamSchema = z.object({
	persistedQuery: z.object({
		sha256Hash: z.string(),
	}),
});

const hashCache = new Map<string, string>();
const pendingHashes = new Map<string, Promise<string>>();

async function discoverHash(operationName: string): Promise<string> {
	const page = await (await getContext()).newPage();
	try {
		const request = page.waitForRequest(
			(r) => {
				const url = new URL(r.url());
				return (
					url.origin === "https://api.s-kaupat.fi" &&
					url.searchParams.get("operationName") === operationName &&
					r.method() !== "OPTIONS"
				);
			},
			{ timeout: 30_000 },
		);
		// Navigation errors must not leave an unhandled request-wait rejection.
		request.catch(() => {});
		if (operationName === "RemoteStoreSearch") {
			await page.goto(`${ORIGIN}/myymalat/prisma`, { waitUntil: "domcontentloaded" });
			await page.waitForLoadState("load");
			await page.locator("button", { hasText: "Näytä lisää" }).dispatchEvent("click");
		} else {
			await page.goto(`${ORIGIN}/hakutulokset?queryString=maito`, {
				waitUntil: "domcontentloaded",
			});
		}
		const url = new URL((await request).url());
		const ext = ExtensionsParamSchema.parse(
			JSON.parse(url.searchParams.get("extensions") ?? "null"),
		);
		const hash = ext.persistedQuery.sha256Hash;
		hashCache.set(operationName, hash);
		return hash;
	} finally {
		await page.close();
	}
}

async function getHash(operationName: string): Promise<string> {
	const existing = hashCache.get(operationName);
	if (existing) return existing;
	let pending = pendingHashes.get(operationName);
	if (!pending) {
		pending = discoverHash(operationName).finally(() => pendingHashes.delete(operationName));
		pendingHashes.set(operationName, pending);
	}
	return pending;
}

export async function warmup(): Promise<void> {
	await getHash("RemoteFilteredProducts");
}

const SearchResponseSchema = z.object({
	data: z.object({
		store: z.object({
			id: z.string(),
			products: z.object({
				total: z.number(),
				productListItems: z.array(z.object({ product: z.unknown() })),
			}),
		}),
	}),
});

const PersistedQueryNotFoundSchema = z.object({
	errors: z.array(
		z.object({
			extensions: z.object({
				code: z.literal("PERSISTED_QUERY_NOT_FOUND"),
			}),
		}),
	),
});

async function fetchProducts(
	query: string,
	storeId: string,
	limit: number,
	hash: string,
	offset: number,
): Promise<unknown> {
	const url = new URL(API_URL);
	url.searchParams.set("operationName", "RemoteFilteredProducts");
	url.searchParams.set(
		"variables",
		JSON.stringify({ queryString: query, storeId, from: offset, limit }),
	);
	url.searchParams.set(
		"extensions",
		JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
	);

	return requestJson(url, ORIGIN);
}

export async function searchProducts(
	query: string,
	storeId: string,
	limit: number,
	offset = 0,
): Promise<GrocerySearchResult> {
	logger.info({ query, storeId, limit }, "S-Kaupat product search");

	let hash = await getHash("RemoteFilteredProducts");
	let raw = await fetchProducts(query, storeId, limit, hash, offset);

	if (PersistedQueryNotFoundSchema.safeParse(raw).success) {
		logger.warn("Persisted query hash expired, re-extracting");
		hashCache.clear();
		hash = await getHash("RemoteFilteredProducts");
		raw = await fetchProducts(query, storeId, limit, hash, offset);
	}

	let parsed: z.infer<typeof SearchResponseSchema>;
	try {
		parsed = SearchResponseSchema.parse(raw);
	} catch (err) {
		logger.error({ err }, "Failed to parse S-Kaupat search response");
		throw err;
	}

	const { total, productListItems } = parsed.data.store.products;
	if (parsed.data.store.id !== storeId) throw new Error("S-Kaupat search returned the wrong store");
	const products = productListItems.map((item) => parseSProduct(item.product, storeId));

	if (products.length === 0) {
		logger.info({ query, storeId, total }, "S-Kaupat returned 0 products");
	}

	logger.info({ query, resultCount: products.length, total }, "S-Kaupat search completed");

	return {
		products,
		totalCount: parsed.data.store.products.total,
		query,
		storeId,
		chain: "s-kaupat",
		offset,
		nextOffset:
			products.length && offset + products.length < total ? offset + products.length : null,
		coverage: "store-catalog",
		warnings:
			total === 0
				? [
						"No published products matched. Some listed S stores have no searchable online assortment; this does not establish physical stock.",
					]
				: [],
	};
}

const StoreSearchStoreSchema = z.object({
	id: z.string(),
	name: z.string(),
	slug: z.string().nullish(),
	location: z.object({
		address: z.object({
			postcode: z.string().nullish(),
			street: z.object({ default: z.string() }).nullish(),
			postcodeName: z.object({
				default: z.string(),
			}),
		}),
	}),
});

const StoreSearchResponseSchema = z.object({
	data: z.object({
		searchStores: z.object({
			totalCount: z.number(),
			cursor: z.string().nullable(),
			stores: z.array(StoreSearchStoreSchema),
		}),
	}),
});

async function fetchStoreSearchPage(
	query: string | null,
	cursor: string | null,
	hash: string,
): Promise<z.infer<typeof StoreSearchResponseSchema>> {
	const url = new URL(API_URL);
	url.searchParams.set("operationName", "RemoteStoreSearch");
	url.searchParams.set("variables", JSON.stringify({ query, brand: null, cursor }));
	url.searchParams.set(
		"extensions",
		JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
	);

	const raw = await requestJson(url, ORIGIN);

	if (PersistedQueryNotFoundSchema.safeParse(raw).success) {
		throw new Error("PERSISTED_QUERY_NOT_FOUND");
	}

	return StoreSearchResponseSchema.parse(raw);
}

const MAX_STORE_PAGES = 200;

async function fetchAllStoresWithHash(query: string | null, hash: string): Promise<Store[]> {
	const stores: Store[] = [];
	let cursor: string | null = null;
	let pages = 0;

	do {
		const parsed = await fetchStoreSearchPage(query, cursor, hash);
		const result = parsed.data.searchStores;

		for (const s of result.stores) {
			stores.push({
				id: s.id,
				name: s.name,
				chain: "s-kaupat",
				location: s.location.address.postcodeName.default,
				postalCode: s.location.address.postcode ?? null,
				address: s.location.address.street?.default ?? null,
				website: s.slug ? `${ORIGIN}/myymala/${s.slug}/${s.id}` : null,
			});
		}

		cursor = result.cursor;
		pages++;
	} while (cursor && pages < MAX_STORE_PAGES);

	if (cursor) throw new Error("S-Kaupat store pagination exceeded its safety limit");
	return stores;
}

async function fetchAllStores(query: string | null): Promise<Store[]> {
	let hash = await getHash("RemoteStoreSearch");

	try {
		return await fetchAllStoresWithHash(query, hash);
	} catch (err) {
		if (err instanceof Error && err.message === "PERSISTED_QUERY_NOT_FOUND") {
			logger.warn("Store search hash expired, re-extracting");
			hashCache.clear();
			hash = await getHash("RemoteStoreSearch");
			return fetchAllStoresWithHash(query, hash);
		}
		throw err;
	}
}

export async function getStores(city?: string): Promise<Store[]> {
	const stores = await fetchAllStores(city ?? null);
	// The site's query also matches delivery areas; the tool's city filter means store location.
	return city
		? stores.filter((store) => store.location.toLowerCase().includes(city.toLowerCase()))
		: stores;
}
