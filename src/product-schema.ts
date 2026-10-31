import * as z from "zod/v4";
import {
	GroceryChainSchema,
	type GroceryProduct,
	type GrocerySearchResult,
} from "./grocery-types.ts";

const Amount = z.number().nonnegative().nullable();
const UnitPrice = z.object({ amount: z.number().nonnegative(), unit: z.string() }).nullable();
export const GroceryProductSchema = z.object({
	chain: GroceryChainSchema,
	storeId: z.string().nullable(),
	id: z.string(),
	gtins: z.array(z.string()),
	name: z.string(),
	price: Amount,
	pricePerKg: Amount,
	unitPrice: z.string().nullable(),
	imageUrl: z.string().nullable(),
	brand: z.string().nullable(),
	category: z.string().nullable(),
	pricing: z.object({
		currency: z.literal("EUR"),
		unitPrice: UnitPrice,
		regularPrice: Amount,
		publishedPrice: Amount,
		campaignPrice: Amount,
		deposit: Amount,
		approximate: z.boolean().nullable(),
		scope: z.enum(["store", "published"]),
		validFrom: z.string().nullable(),
		validUntil: z.string().nullable(),
		conditions: z.array(z.string()),
		promotions: z.array(
			z.object({
				price: z.number().nonnegative(),
				quantity: z.number().nonnegative(),
				unitPrice: UnitPrice,
				requiresMembership: z.boolean().nullable(),
				validFrom: z.string().nullable(),
				validUntil: z.string().nullable(),
				inStore: z.boolean().nullable(),
				kind: z.enum(["single", "multipack"]),
				conditions: z.array(z.string()),
			}),
		),
	}),
	availability: z.object({
		inStore: z.boolean().nullable(),
		online: z.boolean().nullable(),
		stock: z.literal("unknown"),
	}),
	ingredients: z.string().nullable(),
	description: z.string().nullable(),
	claims: z.array(z.string()),
	allergens: z.array(z.object({ name: z.string(), containment: z.string() })),
	nutrition: z.array(
		z.object({
			basis: z.string().nullable(),
			preparation: z.string().nullable(),
			values: z.array(z.object({ name: z.string(), value: z.string() })),
		}),
	),
	origin: z.string().nullable(),
	storage: z.string().nullable(),
	labelText: z.string().nullable(),
	location: z.object({ aisle: z.string().nullable(), floor: z.number().nullable() }).nullable(),
	source: z.object({ url: z.string(), fetchedAt: z.iso.datetime() }),
	warnings: z.array(z.string()),
}) satisfies z.ZodType<GroceryProduct>;
export const GrocerySearchSchema: z.ZodType<GrocerySearchResult> = z.object({
	chain: GroceryChainSchema,
	storeId: z.string().nullable(),
	query: z.string(),
	products: z.array(GroceryProductSchema),
	totalCount: z.number().int().nonnegative(),
	offset: z.number().int().nonnegative(),
	nextOffset: z.number().int().nonnegative().nullable(),
	coverage: z.enum(["store-catalog", "partial-published-catalog"]),
	warnings: z.array(z.string()),
});
