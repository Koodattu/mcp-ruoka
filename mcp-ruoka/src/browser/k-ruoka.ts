import * as z from "zod/v4";
import {
	type GroceryProduct,
	type GrocerySearchResult,
	productDefaults,
	unitPrice,
} from "../grocery-types.ts";
import type { Store } from "../types.ts";
import { RetailerHttpError, requestJson } from "./request.ts";
import { getBuildNumber, getPage, refreshOrigin } from "./session.ts";

const ORIGIN = "https://www.k-ruoka.fi";
const Localized = z.object({ fi: z.string().nullish() });
const Nutrient = z.union([z.number(), z.object({ amount: z.number().nullish() })]);
const PromotionSchema = z.object({
	price: z.number().nonnegative(),
	amount: z.number().positive().nullish(),
	discountType: z.string().nullish(),
	startDate: z.string().nullish(),
	endDate: z.string().nullish(),
	unitPrice: z.object({ value: z.number(), unit: z.string() }).nullish(),
	discountAvailability: z.object({ store: z.boolean().nullish() }).nullish(),
});
const ProductSchema = z.object({
	ean: z.string(),
	localizedName: z.object({ finnish: z.string() }),
	store: z.object({ id: z.string() }).nullish(),
	images: z.array(z.string()).nullish(),
	brand: z.object({ name: z.string() }).nullish(),
	category: z
		.object({
			path: z.string().nullish(),
			localizedName: z.object({ finnish: z.string() }).nullish(),
		})
		.nullish(),
	availability: z.object({ store: z.boolean().nullish(), web: z.boolean().nullish() }).nullish(),
	mobilescan: z
		.object({
			pricing: z
				.object({
					discount: PromotionSchema.nullish(),
					batch: PromotionSchema.nullish(),
					normal: z
						.object({
							price: z.number(),
							isApproximate: z.boolean().nullish(),
							unitPrice: z.object({ value: z.number(), unit: z.string() }).nullish(),
						})
						.nullish(),
				})
				.nullish(),
		})
		.nullish(),
	productAttributes: z
		.object({
			urlSlug: z.string().nullish(),
			description: Localized.nullish(),
			productContents: Localized.nullish(),
			origin: z.object({ countryOfOriginI18n: Localized.nullish() }).nullish(),
			instructions: z.object({ storageAndUse: Localized.nullish() }).nullish(),
			localizedAllergens: z
				.object({
					contains: z.object({ fi: z.array(z.string()).nullish() }).nullish(),
					mayContain: z.object({ fi: z.array(z.string()).nullish() }).nullish(),
				})
				.nullish(),
			nutritionalContents: z
				.array(
					z.object({
						basis: Localized.nullish(),
						preparationState: Localized.nullish(),
						nutrients: z.record(z.string(), Nutrient).nullish(),
						secondaryNutrients: z
							.array(z.object({ name: Localized, amount: z.number(), unit: z.string() }))
							.nullish(),
					}),
				)
				.nullish(),
		})
		.nullish(),
});

export function parseKProduct(raw: unknown, storeId: string, now = Date.now()): GroceryProduct {
	const p = ProductSchema.parse(raw);
	if (!p.store || p.store.id !== storeId)
		throw new Error("K-Ruoka returned a product for a different or missing store");
	const a = p.productAttributes;
	const price = p.mobilescan?.pricing?.normal;
	const comparison = unitPrice(price?.unitPrice?.value, price?.unitPrice?.unit);
	const result: GroceryProduct = {
		...productDefaults("k-ruoka", storeId, `${ORIGIN}/kauppa/tuote/${a?.urlSlug ?? p.ean}`),
		id: p.ean,
		gtins: [p.ean],
		name: p.localizedName.finnish,
		price: price?.price ?? null,
		unitPrice: comparison ? `${comparison.amount} EUR/${comparison.unit}` : null,
		pricePerKg: comparison?.unit === "kg" ? comparison.amount : null,
		imageUrl: p.images?.[0] ?? null,
		brand: p.brand?.name ?? null,
		category: p.category?.localizedName?.finnish ?? null,
		categoryPath: p.category?.path ?? null,
		availability: {
			inStore: p.availability?.store ?? null,
			online: p.availability?.web ?? null,
			stock: "unknown",
		},
		ingredients: a?.productContents?.fi ?? null,
		description: a?.description?.fi ?? null,
		allergens: [
			...(a?.localizedAllergens?.contains?.fi ?? []).map((name) => ({
				name,
				containment: "CONTAINS",
			})),
			...(a?.localizedAllergens?.mayContain?.fi ?? []).map((name) => ({
				name,
				containment: "MAY_CONTAIN",
			})),
		],
		nutrition: (a?.nutritionalContents ?? []).map((table) => ({
			basis: table.basis?.fi ?? null,
			preparation: table.preparationState?.fi ?? null,
			values: [
				...Object.entries(table.nutrients ?? {}).flatMap(([name, nutrient]) => {
					const amount = typeof nutrient === "number" ? nutrient : nutrient.amount;
					const unit = name === "energyKj" ? "kJ" : name === "energyKcal" ? "kcal" : "g";
					return amount == null ? [] : [{ name, value: `${amount} ${unit}` }];
				}),
				...(table.secondaryNutrients ?? []).map((n) => ({
					name: n.name.fi ?? "unknown",
					value: `${n.amount} ${n.unit}`,
				})),
			],
		})),
		origin: a?.origin?.countryOfOriginI18n?.fi ?? null,
		storage: a?.instructions?.storageAndUse?.fi ?? null,
	};
	result.pricing.unitPrice = comparison;
	result.pricing.regularPrice = price?.price ?? null;
	result.pricing.approximate = price?.isApproximate ?? null;
	for (const [kind, promo] of [
		["single", p.mobilescan?.pricing?.discount],
		["multipack", p.mobilescan?.pricing?.batch],
	] as const) {
		if (!promo) continue;
		const membership =
			promo.discountType === "PLUSSA" ? true : promo.discountType === "STANDARD" ? false : null;
		result.pricing.promotions.push({
			price: promo.price,
			quantity: promo.amount ?? (kind === "single" ? 1 : 0),
			unitPrice: unitPrice(promo.unitPrice?.value, promo.unitPrice?.unit),
			requiresMembership: membership,
			validFrom: promo.startDate ?? null,
			validUntil: promo.endDate ?? null,
			inStore: promo.discountAvailability?.store ?? null,
			kind,
			conditions: [
				promo.discountType ?? "Unknown discount eligibility",
				...(kind === "multipack" ? [`Requires ${promo.amount ?? "unknown"} items`] : []),
			],
		});
		const active =
			promo.startDate &&
			promo.endDate &&
			Date.parse(promo.startDate) <= now &&
			Date.parse(promo.endDate) >= now;
		if (
			kind === "single" &&
			membership === false &&
			active &&
			promo.discountAvailability?.store === true &&
			(promo.amount ?? 1) === 1
		) {
			const comparison = unitPrice(promo.unitPrice?.value, promo.unitPrice?.unit);
			result.price = promo.price;
			result.unitPrice = comparison ? `${comparison.amount} EUR/${comparison.unit}` : null;
			result.pricePerKg = comparison?.unit === "kg" ? comparison.amount : null;
			result.pricing.unitPrice = comparison;
			result.pricing.campaignPrice = promo.price;
			result.pricing.validFrom = promo.startDate ?? null;
			result.pricing.validUntil = promo.endDate ?? null;
		}
	}
	if (
		result.pricing.promotions.some((p) => p.requiresMembership !== false || p.kind === "multipack")
	)
		result.warnings.push(
			"Conditional K promotions are listed separately; membership and purchase quantity must be satisfied.",
		);
	return result;
}

async function api(path: string, method = "GET", body?: string): Promise<unknown> {
	for (let attempt = 0; attempt < 2; attempt++) {
		await getPage();
		try {
			return await requestJson(new URL(path, ORIGIN), ORIGIN, {
				browser: true,
				method,
				body,
				headers: {
					"x-k-build-number": getBuildNumber(),
					accept: "application/json",
					...(body ? { "Content-Type": "application/json" } : {}),
				},
			});
		} catch (error) {
			if (!(error instanceof RetailerHttpError) || error.status !== 409 || attempt > 0) throw error;
			await refreshOrigin(ORIGIN);
		}
	}
	throw new Error("K-Ruoka version refresh failed");
}

export async function searchProducts(
	query: string,
	storeId: string,
	limit: number,
	offset = 0,
): Promise<GrocerySearchResult> {
	const params = new URLSearchParams({
		offset: String(offset),
		language: "fi",
		storeId,
		limit: String(limit),
		discountFilter: "false",
		isTrOffer: "false",
	});
	const raw = await api(`/kr-api/v2/product-search/${encodeURIComponent(query)}?${params}`, "POST");
	const data = z
		.object({
			result: z.array(z.object({ product: z.unknown() })),
			totalHits: z.number(),
			storeId: z.string(),
			hasGoodResults: z.boolean().optional(),
		})
		.parse(raw);
	if (data.storeId !== storeId) throw new Error("K-Ruoka search returned the wrong store");
	const products = data.result.map((item) => parseKProduct(item.product, storeId));
	return {
		products,
		hasGoodResults: data.hasGoodResults ?? null,
		totalCount: data.totalHits,
		query,
		storeId,
		chain: "k-ruoka",
		offset,
		nextOffset:
			products.length && offset + products.length < data.totalHits
				? offset + products.length
				: null,
		coverage: "store-catalog",
		warnings:
			data.hasGoodResults === false
				? [
						"Retailer reported weak search matches. Inspect candidate categories or try a broader synonym; results are not exact matches.",
					]
				: [],
	};
}

export async function getProduct(id: string, storeId: string): Promise<GroceryProduct> {
	const raw = await api(
		`/kr-api/v4/products/${encodeURIComponent(id)}?storeId=${encodeURIComponent(storeId)}`,
	);
	const data = z.object({ product: z.unknown() }).parse(raw);
	const product = parseKProduct(data.product, storeId);
	if (product.id !== id) throw new Error("K-Ruoka returned the wrong product");
	return product;
}

export async function getStores(city?: string): Promise<Store[]> {
	const data = z
		.object({
			results: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					location: z.string(),
					slug: z.string().optional(),
					geo: z.object({ latitude: z.number(), longitude: z.number() }).nullish(),
				}),
			),
		})
		.parse(await api("/kr-api/stores"));
	return data.results
		.filter((s) => !city || s.location.toLowerCase().includes(city.toLowerCase()))
		.map((s) => ({
			id: s.id,
			name: s.name,
			location: s.location,
			coordinates: s.geo ?? null,
			website: s.slug ? `${ORIGIN}/kauppa/${s.slug}` : null,
			chain: "k-ruoka",
		}));
}

export async function getNearbyAvailability(id: string, storeId: string) {
	return z
		.object({
			distanceLimitInKm: z.number(),
			nearestDistance: z.number().nullable(),
			storesWithAvailability: z.array(
				z.object({ id: z.string(), name: z.string(), location: z.string() }),
			),
		})
		.parse(
			await api(
				`/kr-api/v2/products/${encodeURIComponent(id)}/availability`,
				"POST",
				JSON.stringify({ storeId }),
			),
		);
}
