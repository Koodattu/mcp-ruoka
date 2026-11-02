import * as z from "zod/v4";
import * as kRuoka from "./browser/k-ruoka.ts";
import * as lidl from "./browser/lidl.ts";
import * as sKaupat from "./browser/s-kaupat.ts";
import { memoizedLookup } from "./cache.ts";
import { CACHE_MS, offerExpiry } from "./cache-policy.ts";
import { CompareInputSchema, type ComparisonInput, runComparison } from "./comparison.ts";
import { locateNearby, matchesCity, NearbyInputSchema } from "./geography.ts";
import {
	applyPriceValidity,
	GroceryChainSchema,
	type GroceryProduct,
	type GrocerySearchResult,
} from "./grocery-types.ts";
import { observeProvider } from "./health.ts";
import { getLidlStores } from "./lidl-discovery.ts";
import { getManufacturerLabel } from "./manufacturer.ts";
import { assessNutrition, type NutritionAssessment } from "./nutrition.ts";
import { getObservationStore } from "./observations.ts";
import { getPreferences, type PreferencesSchema } from "./preferences.ts";
import { GroceryProductSchema, GrocerySearchSchema } from "./product-schema.ts";
import type { Store } from "./types.ts";

export { closeBrowser } from "./browser/session.ts";
export { CompareInputSchema } from "./comparison.ts";
export { NearbyInputSchema } from "./geography.ts";
export type { GroceryProduct, GrocerySearchResult } from "./grocery-types.ts";
export { getProviderHealth } from "./health.ts";
export { getPriceHistory, HistoryInputSchema } from "./observations.ts";
export { getPreferences, PreferencesSchema, setPreferences } from "./preferences.ts";

const StoreInput = { chain: GroceryChainSchema, storeId: z.string().trim().min(1).optional() };
export const SearchInputSchema = z
	.object({
		...StoreInput,
		query: z.string().trim().min(1).max(200),
		limit: z.number().int().min(1).max(50).default(10),
		offset: z.number().int().min(0).max(10000).default(0),
		refresh: z.boolean().default(false),
	})
	.strict();
export const ProductInputSchema = z
	.object({
		...StoreInput,
		id: z.string().regex(/^\d{1,14}$/),
		refresh: z.boolean().default(false),
	})
	.strict();
export const StoresInputSchema = z
	.object({ chain: GroceryChainSchema.optional(), city: z.string().trim().min(1).optional() })
	.strict();

export function resolveStore(
	chain: z.infer<typeof GroceryChainSchema>,
	supplied?: string,
	env: NodeJS.ProcessEnv = process.env,
	defaults: Partial<Record<"k-ruoka" | "s-kaupat", string>> = {},
): string | null {
	if (chain === "lidl") {
		if (supplied)
			throw new Error(
				"Lidl store-specific prices and availability are not supported. Omit storeId for published catalog data.",
			);
		return null;
	}
	const id =
		supplied ??
		env[chain === "k-ruoka" ? "K_RUOKA_STORE_ID" : "S_KAUPAT_STORE_ID"] ??
		defaults[chain];
	if (!id)
		throw new Error(
			`Choose a store for ${chain} using get_stores, then pass storeId or configure its default environment variable.`,
		);
	if (!(chain === "k-ruoka" ? /^[A-Z]\d+$/ : /^\d+$/).test(id))
		throw new Error(`Invalid store ID for ${chain}`);
	return id;
}

// Only deduplicate in-flight work here; SQLite owns expiry across process restarts.
const searchCache = memoizedLookup<GrocerySearchResult>(0);
const productCache = memoizedLookup<GroceryProduct>(0);
const storeCache = memoizedLookup<Store[]>(60 * 60_000, 30);
const StoreListSchema = z.array(
	z.object({
		id: z.string(),
		name: z.string(),
		location: z.string(),
		chain: GroceryChainSchema,
		postalCode: z.string().nullable().optional(),
		address: z.string().nullable().optional(),
		coordinates: z.object({ latitude: z.number(), longitude: z.number() }).nullable().optional(),
		website: z.string().nullable().optional(),
	}),
);

export async function searchProducts(
	input: z.input<typeof SearchInputSchema>,
	{ catalogOnly = false } = {},
): Promise<GrocerySearchResult> {
	const {
		chain,
		query: requestedQuery,
		storeId: supplied,
		limit,
		offset,
		refresh,
	} = SearchInputSchema.parse(input);
	const query = requestedQuery.normalize("NFC").toLocaleLowerCase("fi").replace(/\s+/g, " ").trim();
	const storeId = resolveStore(chain, supplied, process.env, getPreferences().defaultStores);
	const key = JSON.stringify(["search-v2", chain, storeId, query, limit, offset]);
	const catalogKey = JSON.stringify(["catalog-v1", chain, storeId, query, limit, offset]);
	const result = await searchCache(`${key}:${refresh}:${catalogOnly}`, async () => {
		const db = await getObservationStore();
		const cached = refresh
			? null
			: db.readCache(
					catalogOnly ? catalogKey : key,
					GrocerySearchSchema.refine(
						(r) =>
							r.chain === chain &&
							r.storeId === storeId &&
							r.query === query &&
							r.offset === offset,
					),
				);
		if (cached) return cached;
		const validated = await observeProvider(chain, async () => {
			const loaded =
				chain === "lidl"
					? await lidl.searchProducts(query, limit, offset)
					: storeId
						? await (chain === "k-ruoka" ? kRuoka : sKaupat).searchProducts(
								query,
								storeId,
								limit,
								offset,
							)
						: null;
			if (!loaded) throw new Error("Store required");
			return GrocerySearchSchema.parse(loaded);
		});
		db.record(validated.products, "search");
		db.writeCache(key, validated, offerExpiry(validated.products));
		db.writeCache(catalogKey, validated, Date.now() + CACHE_MS.membership);
		return validated;
	});
	result.products = result.products.map((product) => {
		if (Date.parse(product.source.fetchedAt) + CACHE_MS.offers <= Date.now()) {
			product.price = product.pricePerKg = product.pricing.unitPrice = null;
			product.unitPrice = null;
			product.availability = { inStore: null, online: null, stock: "unknown" };
			product.pricing.promotions = [];
		}
		return applyPriceValidity(product);
	});
	return result;
}

export async function getProduct(
	input: z.input<typeof ProductInputSchema>,
): Promise<GroceryProduct & { nutritionAssessment: NutritionAssessment }> {
	const { chain, id, storeId: supplied, refresh } = ProductInputSchema.parse(input);
	const storeId = resolveStore(chain, supplied, process.env, getPreferences().defaultStores);
	const key = JSON.stringify(["detail-v2", chain, storeId, id]);
	const product = await productCache(`${key}:${refresh}`, async () => {
		const db = await getObservationStore();
		const cached = refresh
			? null
			: db.readCache(
					key,
					GroceryProductSchema.refine(
						(p) => p.chain === chain && p.storeId === storeId && p.id === id,
					),
				);
		if (cached) return cached;
		const composed = refresh ? null : db.readProduct(chain, storeId, id);
		if (composed) return composed;
		const validated = await observeProvider(chain, async () => {
			const loaded =
				chain === "lidl"
					? await lidl.getProduct(id)
					: storeId
						? await (chain === "k-ruoka" ? kRuoka : sKaupat).getProduct(id, storeId)
						: null;
			if (!loaded) throw new Error("Store required");
			return GroceryProductSchema.parse(loaded);
		});
		db.record([validated], "detail");
		db.writeCache(key, validated, offerExpiry([validated]));
		return validated;
	});
	return { ...applyPriceValidity(product), nutritionAssessment: assessNutrition(product) };
}

export async function getStores(input: z.input<typeof StoresInputSchema> = {}) {
	const { chain, city } = StoresInputSchema.parse(input);
	const chains = chain ? [chain] : (["k-ruoka", "s-kaupat", "lidl"] as const);
	const results = await Promise.allSettled(
		chains.map((c) =>
			c === "lidl"
				? getLidlStores(city)
				: storeCache(c, async () => {
						const db = await getObservationStore();
						const key = `stores-v1:${c}`;
						const cached = db.readCache(key, StoreListSchema);
						if (cached) return cached;
						const stores = StoreListSchema.parse(
							await (c === "k-ruoka" ? kRuoka : sKaupat).getStores(),
						);
						db.writeCache(key, stores, Date.now() + CACHE_MS.stores);
						return stores;
					}),
		),
	);
	const stores: Store[] = [];
	const warnings: string[] = [];
	for (const [i, result] of results.entries()) {
		if (result.status === "fulfilled") stores.push(...result.value);
		else
			warnings.push(
				`${chains[i]}: ${result.reason instanceof Error ? result.reason.message : "Store lookup failed"}`,
			);
	}
	if (warnings.length === chains.length) throw new Error(warnings.join("; "));
	if (chains.includes("s-kaupat"))
		warnings.push(
			"The S-group directory includes physical stores without a searchable online assortment. A listed store is not a guarantee of product-search coverage.",
		);
	return { stores: city ? stores.filter((store) => matchesCity(store, city)) : stores, warnings };
}

export async function getNearbyStores(input: z.input<typeof NearbyInputSchema>) {
	const options = NearbyInputSchema.parse(input);
	const chains = [...new Set(options.chains)];
	const results = await Promise.allSettled(chains.map((chain) => getStores({ chain })));
	const stores: Store[] = [];
	const warnings: string[] = [];
	for (const [i, result] of results.entries()) {
		if (result.status === "fulfilled") {
			stores.push(...result.value.stores);
			warnings.push(...result.value.warnings);
		} else
			warnings.push(
				`${chains[i]} directory failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
			);
	}
	if (results.every((r) => r.status === "rejected")) throw new Error(warnings.join("; "));
	const nearby = locateNearby(stores, options);
	return {
		...nearby,
		warnings: [...nearby.warnings, ...warnings],
		directoryComplete: results.every((r) => r.status === "fulfilled"),
	};
}

export function resolveComparisonInput(
	input: ComparisonInput,
	preferences: z.infer<typeof PreferencesSchema>,
) {
	const location =
		input.postalCode || input.coordinates || input.stores
			? {}
			: preferences.preferredStores?.length
				? { stores: preferences.preferredStores }
				: { postalCode: preferences.postalCode, coordinates: preferences.coordinates };
	return CompareInputSchema.parse({
		...location,
		...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
		radiusKm: input.radiusKm ?? preferences.radiusKm ?? 15,
	});
}

export async function compareProducts(input: ComparisonInput) {
	const startedAt = Date.now();
	const options = resolveComparisonInput(input, getPreferences());
	let stores: Array<{ chain: "k-ruoka" | "s-kaupat"; storeId: string; name?: string }> =
		options.stores ?? [];
	let discovery: Awaited<ReturnType<typeof getNearbyStores>> | null = null;
	if (!stores.length) {
		if (!options.postalCode && !options.coordinates)
			throw new Error(
				"Choose stores, provide a postalCode/coordinates, or save preferences before comparing products.",
			);
		discovery = await getNearbyStores({
			chains: ["k-ruoka", "s-kaupat"],
			postalCode: options.postalCode,
			coordinates: options.coordinates,
			radiusKm: options.radiusKm,
			limit: options.maxStores,
		});
		stores = discovery.stores.flatMap((s) =>
			s.chain === "k-ruoka" || s.chain === "s-kaupat"
				? [{ chain: s.chain, storeId: s.id, name: s.name }]
				: [],
		);
	}
	if (!stores.length) throw new Error("No supported stores located within the requested radius");
	stores = [...new Map(stores.map((s) => [`${s.chain}:${s.storeId}`, s])).values()];
	const storeWarnings: string[] = [];
	if (stores.some((s) => !s.name)) {
		for (const chain of new Set(stores.map((s) => s.chain))) {
			try {
				const directory = await getStores({ chain });
				stores = stores.map((s) =>
					s.chain === chain
						? { ...s, name: directory.stores.find((entry) => entry.id === s.storeId)?.name }
						: s,
				);
			} catch {
				storeWarnings.push(`${chain} store names could not be resolved; store IDs are retained.`);
			}
		}
	}
	const result = await runComparison(
		options,
		stores,
		{
			search: searchProducts,
			detail: getProduct,
			manufacturerLabel: getManufacturerLabel,
		},
		startedAt,
	);
	return {
		...result,
		selectedStores: stores,
		discovery,
		warnings: [
			...result.warnings,
			...storeWarnings,
			...(discovery?.warnings ?? []),
			...(discovery?.truncated
				? [
						"Nearby-store selection was limited; increase maxStores or explicitly select the stores to compare.",
					]
				: []),
		],
	};
}

export function getCapabilities() {
	const defaults = getPreferences().defaultStores;
	return {
		chains: [
			{
				chain: "k-ruoka",
				defaultStore: process.env.K_RUOKA_STORE_ID ?? defaults?.["k-ruoka"] ?? null,
				storeSelection: true,
				nutrition: "structured",
				prices: "store prices and dated promotions; loyalty and multipack conditions retained",
				availability: "catalog flags, not shelf stock",
			},
			{
				chain: "s-kaupat",
				defaultStore: process.env.S_KAUPAT_STORE_ID ?? defaults?.["s-kaupat"] ?? null,
				storeSelection: true,
				nutrition: "structured",
				prices: "store prices",
				availability: "unknown",
			},
			{
				chain: "lidl",
				storeDiscovery: true,
				leaflets:
					"Published page search, PDF links and offer-region metadata; no structured leaflet prices or verified local stock",
				defaultStore: null,
				storeSelection: false,
				nutrition: "label text when published; supported bilingual bakery tables normalized",
				prices: "partial published prices with regional/date conditions",
				availability: "unknown",
			},
		],
		cacheSeconds: {
			search: CACHE_MS.offers / 1000,
			product: CACHE_MS.offers / 1000,
			labels: CACHE_MS.labels / 1000,
			membership: CACHE_MS.membership / 1000,
			stores: CACHE_MS.stores / 1000,
			availability: CACHE_MS.availability / 1000,
			lidlIndex: 3600,
		},
		persistentObservations:
			"SQLite search/detail cache, historical store-price observations and label versions. Historical prices are only returned through get_price_history; expired prices never become live fallbacks.",
		manufacturerEnrichment:
			"Arla/Valio Finland nutrition and ingredients with exact GTIN verification. discover_manufacturer_label searches official sitemaps within a candidate budget, including Valio package variants. Labels cached up to 24 hours; discovered URLs can be supplied to compare_products.",
		providerHealth:
			"Live search/detail loads in this process, excluding cache hits; available through get_provider_health.",
		nearbyStores:
			"Postal code or coordinates; municipality aliases supported; S-store distances use postal reference points when exact coordinates are absent.",
		comparison:
			"Paged multi-store search, GTIN grouping, nutrition evidence and bounded detail collection with explicit coverage reporting.",
		pricePerKg: "Only supplied for kilogram unit prices; litre prices are not converted to mass.",
	};
}
