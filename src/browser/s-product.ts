import * as z from "zod/v4";
import { type GroceryProduct, productDefaults, unitPrice } from "../grocery-types.ts";
import { requestJson } from "./request.ts";

const ProductSchema = z.object({
	ean: z.string(),
	storeId: z.string(),
	name: z.string(),
	slug: z.string().nullish(),
	isGlobalFallback: z.boolean().nullish(),
	brandName: z.string().nullish(),
	countryOfOrigin: z.string().nullish(),
	ingredientStatement: z.string().nullish(),
	description: z.string().nullish(),
	allergens: z
		.array(z.object({ allergenTypeText: z.string(), levelOfContainmentCode: z.string() }))
		.nullish(),
	pricing: z
		.object({
			currentPrice: z.number().nullish(),
			regularPrice: z.number().nullish(),
			comparisonPrice: z.number().nullish(),
			comparisonUnit: z.string().nullish(),
			campaignPrice: z.number().nullish(),
			depositPrice: z.number().nullish(),
			isApproximatePrice: z.boolean().nullish(),
			campaignPriceValidUntil: z.string().nullish(),
		})
		.nullish(),
	productDetails: z
		.object({
			nutrients: z
				.array(
					z.object({
						referenceQuantity: z.string().nullish(),
						nutrients: z
							.array(z.object({ name: z.string(), value: z.string().nullish() }))
							.nullish(),
					}),
				)
				.nullish(),
			storageGuideForConsumer: z.string().nullish(),
			productImages: z
				.object({ mainImage: z.object({ urlTemplate: z.string() }).nullish() })
				.nullish(),
		})
		.nullish(),
	location: z.object({ aisle: z.string().nullish(), floor: z.number().nullish() }).nullish(),
	hierarchyPath: z.array(z.object({ name: z.string() })).nullish(),
});

export function parseSProduct(raw: unknown, storeId: string): GroceryProduct {
	const p = ProductSchema.parse(raw);
	if (p.storeId !== storeId) throw new Error("S-Kaupat returned a product for a different store");
	const pricing = p.isGlobalFallback ? null : p.pricing;
	const comparison = unitPrice(pricing?.comparisonPrice, pricing?.comparisonUnit);
	const result: GroceryProduct = {
		...productDefaults(
			"s-kaupat",
			storeId,
			`https://www.s-kaupat.fi/tuote/${p.slug ?? "tuote"}/${p.ean}`,
		),
		id: p.ean,
		gtins: [p.ean],
		name: p.name,
		brand: p.brandName ?? null,
		category: p.hierarchyPath?.[0]?.name ?? null,
		price: pricing?.currentPrice ?? null,
		unitPrice: comparison ? `${comparison.amount} EUR/${comparison.unit}` : null,
		pricePerKg: comparison?.unit === "kg" ? comparison.amount : null,
		imageUrl:
			p.productDetails?.productImages?.mainImage?.urlTemplate
				.replace("{MODIFIERS}", "w_200,h_200")
				.replace("{EXTENSION}", "png") ?? null,
		ingredients: p.ingredientStatement ?? null,
		description: p.description ?? null,
		allergens: (p.allergens ?? []).map((a) => ({
			name: a.allergenTypeText,
			containment: a.levelOfContainmentCode,
		})),
		nutrition: (p.productDetails?.nutrients ?? []).map((n) => ({
			basis: n.referenceQuantity ?? null,
			preparation: null,
			values: (n.nutrients ?? []).flatMap((v) =>
				v.value == null ? [] : [{ name: v.name, value: v.value }],
			),
		})),
		origin: p.countryOfOrigin ?? null,
		storage: p.productDetails?.storageGuideForConsumer ?? null,
		location:
			!p.isGlobalFallback && p.location
				? { aisle: p.location.aisle ?? null, floor: p.location.floor ?? null }
				: null,
	};
	result.pricing = {
		...result.pricing,
		unitPrice: comparison,
		regularPrice: pricing?.regularPrice ?? null,
		campaignPrice: pricing?.campaignPrice ?? null,
		deposit: pricing?.depositPrice ?? null,
		approximate: pricing?.isApproximatePrice ?? null,
		validUntil: pricing?.campaignPriceValidUntil ?? null,
	};
	result.warnings.push("S-Kaupat does not provide a verified shelf-stock count in this response.");
	if (p.isGlobalFallback)
		result.warnings.push("Global product fallback: store price and aisle suppressed.");
	return result;
}

// Adapted from Jameshooper/mcp-ruoka's s-kaupat-api.ts: a plain GET field query
// avoids the changing persisted-query hash for product details. See README attribution.
export async function getProduct(ean: string, storeId: string): Promise<GroceryProduct> {
	if (!/^\d+$/.test(ean) || !/^\d+$/.test(storeId))
		throw new Error("Invalid S-Kaupat product or store ID");
	const url = new URL("https://api.s-kaupat.fi/");
	url.searchParams.set(
		"query",
		`{ product(id: "${ean}", storeId: "${storeId}", fallbackToGlobal: true, includeAgeLimitedByAlcohol: true) {
		ean storeId name slug brandName countryOfOrigin ingredientStatement description isGlobalFallback
		allergens { allergenTypeText levelOfContainmentCode }
		pricing { currentPrice regularPrice comparisonPrice comparisonUnit campaignPrice depositPrice isApproximatePrice campaignPriceValidUntil }
		productDetails { nutrients { referenceQuantity nutrients { name value } } storageGuideForConsumer productImages { mainImage { urlTemplate } } }
		location { aisle floor } hierarchyPath { name }
	} }`,
	);
	const raw = await requestJson(url, "https://www.s-kaupat.fi");
	const data = z.object({ data: z.object({ product: z.unknown() }) }).parse(raw);
	if (data.data.product == null) throw new Error("S-Kaupat product not found");
	const product = parseSProduct(data.data.product, storeId);
	if (product.id !== ean) throw new Error("S-Kaupat returned the wrong product");
	return product;
}
