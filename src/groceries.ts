import * as z from "zod/v4";
import * as kRuoka from "./browser/k-ruoka.ts";
import * as lidl from "./browser/lidl.ts";
import * as sKaupat from "./browser/s-kaupat.ts";
import { memoizedLookup } from "./cache.ts";
import { CompareInputSchema, type ComparisonInput, runComparison } from "./comparison.ts";
import { locateNearby, matchesCity, NearbyInputSchema } from "./geography.ts";
import {
	applyPriceValidity,
	GroceryChainSchema,
	type GroceryProduct,
	type GrocerySearchResult,
} from "./grocery-types.ts";
import { assessNutrition, type NutritionAssessment } from "./nutrition.ts";
import { getPreferences, type PreferencesSchema } from "./preferences.ts";
import type { Store } from "./types.ts";

export { closeBrowser } from "./browser/session.ts";
export { CompareInputSchema } from "./comparison.ts";
export { NearbyInputSchema } from "./geography.ts";
export type { GroceryProduct, GrocerySearchResult } from "./grocery-types.ts";
export { getPreferences, PreferencesSchema, setPreferences } from "./preferences.ts";

const StoreInput = { chain: GroceryChainSchema, storeId: z.string().trim().min(1).optional() };
export const SearchInputSchema = z
	.object({
		...StoreInput,
		query: z.string().trim().min(1).max(200),
		limit: z.number().int().min(1).max(50).default(10),
		offset: z.number().int().min(0).max(10000).default(0),
	})
	.strict();
export const ProductInputSchema = z
	.object({ ...StoreInput, id: z.string().regex(/^\d{1,14}$/) })
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

const searchCache = memoizedLookup<GrocerySearchResult>(60_000);
const productCache = memoizedLookup<GroceryProduct>(5 * 60_000);
const storeCache = memoizedLookup<Store[]>(60 * 60_000, 30);

export async function searchProducts(
	input: z.input<typeof SearchInputSchema>,
): Promise<GrocerySearchResult> {
	const { chain, query, storeId: supplied, limit, offset } = SearchInputSchema.parse(input);
	const storeId = resolveStore(chain, supplied, process.env, getPreferences().defaultStores);
	const result = await searchCache(JSON.stringify([chain, storeId, query, limit, offset]), () => {
		if (chain === "lidl") return lidl.searchProducts(query, limit, offset);
		if (!storeId) throw new Error("Store required");
		return (chain === "k-ruoka" ? kRuoka : sKaupat).searchProducts(query, storeId, limit, offset);
	});
	result.products = result.products.map((product) => applyPriceValidity(product));
	return result;
}

export async function getProduct(
	input: z.input<typeof ProductInputSchema>,
): Promise<GroceryProduct & { nutritionAssessment: NutritionAssessment }> {
	const { chain, id, storeId: supplied } = ProductInputSchema.parse(input);
	const storeId = resolveStore(chain, supplied, process.env, getPreferences().defaultStores);
	const product = await productCache(JSON.stringify([chain, storeId, id]), () => {
		if (chain === "lidl") return lidl.getProduct(id);
		if (!storeId) throw new Error("Store required");
		return (chain === "k-ruoka" ? kRuoka : sKaupat).getProduct(id, storeId);
	});
	return { ...applyPriceValidity(product), nutritionAssessment: assessNutrition(product) };
}

export async function getStores(input: z.input<typeof StoresInputSchema> = {}) {
	const { chain, city } = StoresInputSchema.parse(input);
	if (chain === "lidl")
		throw new Error("Lidl store selection is not supported by the published catalog adapter.");
	const chains = chain ? [chain] : (["k-ruoka", "s-kaupat"] as const);
	const results = await Promise.allSettled(
		chains.map((c) => storeCache(c, () => (c === "k-ruoka" ? kRuoka : sKaupat).getStores())),
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
	const result = await runComparison(options, stores, {
		search: searchProducts,
		detail: getProduct,
	});
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
				defaultStore: null,
				storeSelection: false,
				nutrition: "label text when published; supported bilingual bakery tables normalized",
				prices: "partial published prices with regional/date conditions",
				availability: "unknown",
			},
		],
		cacheSeconds: { search: 60, product: 300, stores: 3600, lidlIndex: 3600 },
		nearbyStores:
			"Postal code or coordinates; municipality aliases supported; S-store distances use postal reference points when exact coordinates are absent.",
		comparison:
			"Paged multi-store search, GTIN grouping, nutrition evidence and bounded detail collection with explicit coverage reporting.",
		pricePerKg: "Only supplied for kilogram unit prices; litre prices are not converted to mass.",
	};
}
