import * as z from "zod/v4";
import { PointSchema } from "./geography.ts";
import type { GroceryProduct, GrocerySearchResult } from "./grocery-types.ts";
import { assessNutrition, mergeNutrition, type NutritionAssessment } from "./nutrition.ts";
import { StoreSelectionSchema } from "./preferences.ts";

export const CompareInputSchema = z
	.object({
		queries: z.array(z.string().trim().min(1).max(100)).min(1).max(5),
		includeTerms: z.array(z.string().trim().min(1)).max(10).default([]),
		excludeTerms: z.array(z.string().trim().min(1)).max(20).default([]),
		stores: z.array(StoreSelectionSchema).min(1).max(20).optional(),
		postalCode: z
			.string()
			.regex(/^\d{5}$/)
			.optional(),
		coordinates: PointSchema.optional(),
		radiusKm: z.number().positive().max(100).optional(),
		maxStores: z.number().int().min(1).max(20).default(6),
		includeLidl: z.boolean().default(true),
		rankBy: z
			.enum(["no_added_sugar_then_price", "total_sugar_then_price", "price_per_kg"])
			.default("no_added_sugar_then_price"),
		excludeSweeteners: z.boolean().default(false),
		includeLoyaltyPrices: z.boolean().default(false),
		allowMultipacks: z.boolean().default(false),
		maxSugarGPer100g: z.number().nonnegative().max(100).optional(),
		maxPagesPerQuery: z.number().int().min(1).max(20).default(10),
		maxDetailRequests: z.number().int().min(1).max(300).default(120),
		limit: z.number().int().min(1).max(50).default(10),
	})
	.strict()
	.refine((p) => !(p.postalCode && p.coordinates), "Choose postalCode or coordinates")
	.refine(
		(p) => !(p.stores && (p.postalCode || p.coordinates)),
		"Choose explicit stores or a nearby location",
	);
export type ComparisonInput = z.input<typeof CompareInputSchema>;
type Selection = z.infer<typeof StoreSelectionSchema>;
export interface ComparisonClient {
	search(input: {
		chain: "k-ruoka" | "s-kaupat" | "lidl";
		storeId?: string;
		query: string;
		limit: number;
		offset: number;
	}): Promise<GrocerySearchResult>;
	detail(input: {
		chain: "k-ruoka" | "s-kaupat" | "lidl";
		storeId?: string;
		id: string;
	}): Promise<GroceryProduct>;
}
interface SearchCoverage {
	chain: string;
	storeId: string | null;
	storeName: string | null;
	query: string;
	status: "complete" | "truncated" | "failed";
	total: number | null;
	scanned: number;
	matched: number;
	nextOffset: number | null;
	error: string | null;
}
export interface ComparedProduct {
	key: string;
	id: string;
	name: string;
	gtins: string[];
	ingredients: string | null;
	nutrition: NutritionAssessment;
	source: GroceryProduct["source"];
	labelSources: GroceryProduct["source"][];
	offers: Array<{
		chain: string;
		storeId: string | null;
		storeName: string | null;
		price: number | null;
		pricePerKg: number | null;
		purchaseQuantity: number;
		selectedConditions: string[];
		source: GroceryProduct["source"];
		pricing: GroceryProduct["pricing"];
		availability: GroceryProduct["availability"];
	}>;
	bestPricePerKg: number | null;
	exclusions: string[];
}
const normalize = (text: string) =>
	text
		.toLocaleLowerCase("fi")
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "");
export function matchesProduct(product: GroceryProduct, include: string[], exclude: string[]) {
	const text = normalize(`${product.name} ${product.brand ?? ""}`);
	return (
		include.every((term) => text.includes(normalize(term))) &&
		!exclude.some((term) => text.includes(normalize(term)))
	);
}

export function selectPrice(
	product: GroceryProduct,
	options: { includeLoyaltyPrices: boolean; allowMultipacks: boolean },
	now = Date.now(),
) {
	let selected = {
		price: product.price,
		pricePerKg: product.pricePerKg,
		purchaseQuantity: 1,
		selectedConditions: product.pricing.conditions,
	};
	for (const promo of product.pricing.promotions) {
		if (promo.inStore !== true || promo.quantity <= 0 || promo.unitPrice?.unit !== "kg") continue;
		if (
			promo.requiresMembership == null ||
			(promo.requiresMembership && !options.includeLoyaltyPrices)
		)
			continue;
		if (promo.kind === "multipack" && !options.allowMultipacks) continue;
		if (
			!promo.validFrom ||
			!promo.validUntil ||
			!(Date.parse(promo.validFrom) <= now && Date.parse(promo.validUntil) >= now)
		)
			continue;
		if (selected.pricePerKg == null || promo.unitPrice.amount < selected.pricePerKg)
			selected = {
				price: promo.price,
				pricePerKg: promo.unitPrice.amount,
				purchaseQuantity: promo.quantity,
				selectedConditions: promo.conditions,
			};
	}
	return selected;
}

export async function runComparison(
	input: ComparisonInput,
	selections: Array<Selection & { name?: string }>,
	client: ComparisonClient,
) {
	const options = CompareInputSchema.parse(input);
	const targets: Array<{
		chain: "k-ruoka" | "s-kaupat" | "lidl";
		storeId?: string;
		name?: string;
	}> = [...selections];
	if (options.includeLidl) targets.push({ chain: "lidl" });
	const coverage: SearchCoverage[] = [];
	const candidateQueues: GroceryProduct[][] = [];
	const warnings = new Set<string>();
	for (const target of targets) {
		const candidates = new Map<string, GroceryProduct>();
		for (const query of [...new Set(options.queries)]) {
			const report: SearchCoverage = {
				chain: target.chain,
				storeId: target.storeId ?? null,
				storeName: target.name ?? null,
				query,
				status: "complete",
				total: null,
				scanned: 0,
				matched: 0,
				nextOffset: null,
				error: null,
			};
			let offset = 0;
			try {
				for (let page = 0; page < options.maxPagesPerQuery; page++) {
					const result = await client.search({
						chain: target.chain,
						storeId: target.storeId,
						query,
						limit: 50,
						offset,
					});
					if (result.chain !== target.chain || result.storeId !== (target.storeId ?? null))
						throw new Error("Search returned a different retailer or store");
					report.total = result.totalCount;
					report.scanned += result.products.length;
					for (const warning of result.warnings) warnings.add(warning);
					for (const product of result.products) {
						if (product.chain !== target.chain || product.storeId !== (target.storeId ?? null))
							throw new Error("Search product belongs to a different retailer or store");
						if (matchesProduct(product, options.includeTerms, options.excludeTerms)) {
							candidates.set(product.id, product);
							report.matched++;
						}
					}
					report.nextOffset = result.nextOffset;
					if (result.nextOffset == null) break;
					if (result.nextOffset <= offset) throw new Error("Retailer pagination did not advance");
					offset = result.nextOffset;
					if (page === options.maxPagesPerQuery - 1) report.status = "truncated";
				}
			} catch (error) {
				report.status = "failed";
				report.error = error instanceof Error ? error.message : String(error);
			}
			coverage.push(report);
		}
		candidateQueues.push([...candidates.values()]);
	}
	// Round-robin across stores prevents the first store consuming the detail budget.
	const pending: GroceryProduct[] = [];
	for (let i = 0; candidateQueues.some((q) => q.length > i); i++)
		for (const queue of candidateQueues) {
			const p = queue[i];
			if (p) pending.push(p);
		}
	const groups = new Map<string, ComparedProduct>();
	const assessments = new Map<string, NutritionAssessment[]>();
	const detailFailures: Array<{
		chain: string;
		storeId: string | null;
		id: string;
		error: string;
	}> = [];
	for (const summary of pending.slice(0, options.maxDetailRequests)) {
		try {
			const product = await client.detail({
				chain: summary.chain,
				storeId: summary.storeId ?? undefined,
				id: summary.id,
			});
			if (
				product.chain !== summary.chain ||
				product.storeId !== summary.storeId ||
				product.id !== summary.id
			)
				throw new Error("Detail returned a different product/store");
			if (!matchesProduct(product, options.includeTerms, options.excludeTerms)) continue;
			const key =
				product.gtins.length === 1 ? `gtin:${product.gtins[0]}` : `${product.chain}:${product.id}`;
			const nutrition = assessNutrition(product);
			let group = groups.get(key);
			if (!group) {
				group = {
					key,
					id: product.id,
					name: product.name,
					gtins: product.gtins,
					ingredients: product.ingredients,
					nutrition,
					source: product.source,
					labelSources: [],
					offers: [],
					bestPricePerKg: null,
					exclusions: [],
				};
				groups.set(key, group);
			}
			const labels = assessments.get(key) ?? [];
			labels.push(nutrition);
			assessments.set(key, labels);
			group.labelSources.push(product.source);
			const storeName =
				selections.find((s) => s.chain === product.chain && s.storeId === product.storeId)?.name ??
				null;
			group.offers.push({
				chain: product.chain,
				storeId: product.storeId,
				storeName,
				...selectPrice(product, options),
				pricing: product.pricing,
				availability: product.availability,
				source: product.source,
			});
			for (const warning of product.warnings) warnings.add(warning);
		} catch (error) {
			detailFailures.push({
				chain: summary.chain,
				storeId: summary.storeId,
				id: summary.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	for (const group of groups.values()) {
		group.nutrition = mergeNutrition(assessments.get(group.key) ?? [group.nutrition]);
		const offers = group.offers.filter(
			(o) =>
				o.storeId != null &&
				o.pricing.scope === "store" &&
				o.price != null &&
				o.pricePerKg != null &&
				o.availability.inStore !== false,
		);
		group.bestPricePerKg = offers.length
			? Math.min(...offers.map((o) => o.pricePerKg ?? Infinity))
			: null;
		if (group.bestPricePerKg == null)
			group.exclusions.push("No comparable local store price per kg.");
		if (
			options.rankBy === "no_added_sugar_then_price" &&
			group.nutrition.addedSugar.status !== "claimed_none"
		)
			group.exclusions.push(
				"No verified no-added-sugar claim; exact added-sugar amount is unknown.",
			);
		if (
			(options.rankBy === "total_sugar_then_price" || options.maxSugarGPer100g != null) &&
			group.nutrition.per100g.sugars == null
		)
			group.exclusions.push("Comparable total sugar per 100 g is unknown.");
		if (
			options.maxSugarGPer100g != null &&
			(group.nutrition.per100g.sugars ?? Infinity) > options.maxSugarGPer100g
		)
			group.exclusions.push("Exceeds total-sugar limit or sugar is unknown.");
		if (options.excludeSweeteners && group.nutrition.sweeteners.status !== "not_detected")
			group.exclusions.push("Sweeteners are detected or ingredients are missing.");
	}
	const ranked = [...groups.values()]
		.filter((g) => !g.exclusions.length)
		.sort((a, b) => {
			if (options.rankBy === "total_sugar_then_price") {
				const sugar =
					(a.nutrition.per100g.sugars ?? Infinity) - (b.nutrition.per100g.sugars ?? Infinity);
				if (sugar) return sugar;
			}
			return (
				(a.bestPricePerKg ?? Infinity) - (b.bestPricePerKg ?? Infinity) ||
				a.key.localeCompare(b.key)
			);
		});
	const complete =
		coverage.every((c) => c.status === "complete") &&
		detailFailures.length === 0 &&
		pending.length <= options.maxDetailRequests;
	return {
		rankBy: options.rankBy,
		rankingExplanation:
			options.rankBy === "no_added_sugar_then_price"
				? "Products with a supported no-added-sugar claim, ordered by lowest observed local EUR/kg. Unknown added-sugar quantities are not ranked as zero."
				: options.rankBy === "total_sugar_then_price"
					? "Lowest known total sugar per 100 g, then lowest observed local EUR/kg. This is not an added-sugar ranking."
					: "Lowest observed local EUR/kg among products satisfying the filters.",
		ranked: ranked.slice(0, options.limit),
		otherCandidates: [...groups.values()]
			.filter((g) => g.exclusions.length)
			.slice(0, options.limit),
		matchedProductGroups: groups.size,
		eligibleProductGroups: ranked.length,
		coverage: {
			searches: coverage,
			candidateOffers: pending.length,
			detailsAttempted: Math.min(pending.length, options.maxDetailRequests),
			detailsSkipped: Math.max(0, pending.length - options.maxDetailRequests),
			detailFailures,
			completeForRequestedSearches: complete,
			completeMarketCoverage: false,
			resultLimitApplied:
				ranked.length > options.limit || groups.size - ranked.length > options.limit,
		},
		warnings: [
			...warnings,
			"Results cover the requested queries and selected stores only. Shelf stock is unknown. Published Lidl offers do not establish local availability and cannot win a local-price ranking.",
		],
	};
}
