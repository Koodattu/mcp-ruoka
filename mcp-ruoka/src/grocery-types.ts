import * as z from "zod/v4";
import type { Product } from "./types.ts";

export const GroceryChainSchema = z.enum(["k-ruoka", "s-kaupat", "lidl"]);
export type GroceryChain = z.infer<typeof GroceryChainSchema>;

export interface GroceryProduct extends Product {
	labelSource?: { url: string; fetchedAt: string };
	categoryPath?: string | null;
	chain: GroceryChain;
	storeId: string | null;
	gtins: string[];
	pricePerKg: number | null;
	pricing: {
		currency: "EUR";
		unitPrice: { amount: number; unit: string } | null;
		regularPrice: number | null;
		publishedPrice: number | null;
		campaignPrice: number | null;
		deposit: number | null;
		approximate: boolean | null;
		scope: "store" | "published";
		validFrom: string | null;
		validUntil: string | null;
		conditions: string[];
		promotions: Array<{
			price: number;
			quantity: number;
			unitPrice: { amount: number; unit: string } | null;
			requiresMembership: boolean | null;
			validFrom: string | null;
			validUntil: string | null;
			inStore: boolean | null;
			kind: "single" | "multipack";
			conditions: string[];
		}>;
	};
	// Retailer catalog flags are not a real-time count of items on a shelf.
	availability: { inStore: boolean | null; online: boolean | null; stock: "unknown" };
	ingredients: string | null;
	description: string | null;
	claims: string[];
	allergens: Array<{ name: string; containment: string }>;
	nutrition: Array<{
		basis: string | null;
		preparation: string | null;
		values: Array<{ name: string; value: string }>;
	}>;
	origin: string | null;
	storage: string | null;
	labelText: string | null;
	location: { aisle: string | null; floor: number | null } | null;
	source: { url: string; fetchedAt: string };
	warnings: string[];
}

export interface GrocerySearchResult {
	hasGoodResults?: boolean | null;
	chain: GroceryChain;
	storeId: string | null;
	query: string;
	products: GroceryProduct[];
	totalCount: number;
	offset: number;
	nextOffset: number | null;
	coverage: "store-catalog" | "partial-published-catalog";
	warnings: string[];
}

// Cache lifetime must not extend an offer's own validity window.
export function applyPriceValidity(product: GroceryProduct, now = Date.now()): GroceryProduct {
	const { validFrom, validUntil } = product.pricing;
	if (
		(validFrom && !(Date.parse(validFrom) <= now)) ||
		(validUntil && !(Date.parse(validUntil) >= now))
	) {
		product.price = null;
		product.unitPrice = null;
		product.pricePerKg = null;
		product.pricing.unitPrice = null;
		product.pricing.campaignPrice = null;
	}
	return product;
}

export function unitPrice(amount: number | null | undefined, unit: string | null | undefined) {
	if (amount == null || !unit) return null;
	const normalized = { KGM: "kg", LTR: "l", PCE: "piece" }[unit] ?? unit.toLowerCase();
	return { amount, unit: normalized };
}

export function productDefaults(chain: GroceryChain, storeId: string | null, url: string) {
	return {
		chain,
		storeId,
		gtins: [],
		pricePerKg: null,
		pricing: {
			currency: "EUR" as const,
			unitPrice: null,
			regularPrice: null,
			publishedPrice: null,
			campaignPrice: null,
			deposit: null,
			approximate: null,
			scope: storeId ? ("store" as const) : ("published" as const),
			validFrom: null,
			validUntil: null,
			conditions: [],
			promotions: [],
		},
		availability: { inStore: null, online: null, stock: "unknown" as const },
		ingredients: null,
		description: null,
		claims: [],
		allergens: [],
		nutrition: [],
		origin: null,
		storage: null,
		labelText: null,
		location: null,
		source: { url, fetchedAt: new Date().toISOString() },
		warnings: [],
	};
}
