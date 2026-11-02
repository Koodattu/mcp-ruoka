import * as z from "zod/v4";

export const MetricSchema = z.enum([
	"price",
	"itemPrice",
	"pricePerKg",
	"sizeG",
	"proteinPer100g",
	"kcalPer100g",
	"sugarPer100g",
	"proteinPerItem",
	"kcalPerItem",
	"pricePer20gProtein",
	"proteinPer100kcal",
]);
export type Metric = z.infer<typeof MetricSchema>;
export const RankingCriteriaSchema = z
	.object({
		queries: z.array(z.string().trim().min(1).max(100)).min(1).max(3),
		productKind: z.enum(["protein_bar", "yogurt", "other"]),
		includeTerms: z.array(z.string().trim().min(1)).max(8).default([]),
		excludeTerms: z.array(z.string().trim().min(1)).max(12).default([]),
		lactoseFree: z.boolean().default(false),
		excludeSweeteners: z.boolean().default(false),
		allowMultipacks: z.boolean().default(false),
		includeLoyaltyPrices: z.boolean().default(false),
		mode: z.enum(["ordered", "tradeoffs"]).default("ordered"),
		sort: z
			.array(z.object({ metric: MetricSchema, direction: z.enum(["asc", "desc"]) }).strict())
			.min(1)
			.max(3),
		constraints: z
			.array(
				z
					.object({
						metric: MetricSchema,
						min: z.number().nonnegative().optional(),
						max: z.number().nonnegative().optional(),
					})
					.strict()
					.refine(
						(v) =>
							(v.min != null || v.max != null) &&
							!(v.min != null && v.max != null && v.min > v.max),
						"Provide a valid min/max bound",
					),
			)
			.max(8)
			.default([]),
		fields: z.array(MetricSchema).max(11).default(["price"]),
		freshness: z.enum(["cached", "current_prices"]).default("cached"),
		limit: z.number().int().min(1).max(30).default(5),
		offset: z.number().int().min(0).max(1000).default(0),
	})
	.strict();
export const RankingStoreSchema = z
	.object({
		chain: z.enum(["k-ruoka", "s-kaupat"]),
		storeId: z.string().min(1),
		name: z.string().optional(),
	})
	.strict();
export const RankProductsSchema = RankingCriteriaSchema.extend({
	stores: z.array(RankingStoreSchema).min(1).max(4),
});
export type RankingCriteria = z.infer<typeof RankingCriteriaSchema>;
