import { createRequire } from "node:module";
import { resolve } from "node:path";
import { matchesCriteria, normalizeText } from "../mcp-ruoka/src/matching.ts";
import { resolveCity } from "./cities.mjs";
import { config } from "./config.mjs";

const require = createRequire(resolve(config.mcpDir, "package.json"));
const z = require("zod/v4");
const SearchInput = z
	.object({
		city: z
			.string()
			.trim()
			.min(1)
			.max(100)
			.optional()
			.describe(
				"Only supply a city explicitly requested in this conversation; otherwise the app supplies the selected city.",
			),
		categoryQuery: z
			.string()
			.trim()
			.min(1)
			.max(50)
			.describe(
				"Broad Finnish product category, e.g. jogurtti or kaurajuoma. No dietary, protein, price or sugar adjectives.",
			),
		queries: z
			.array(z.string().trim().min(1).max(70))
			.max(2)
			.default([])
			.describe(
				"Optional targeted short Finnish searches, e.g. proteiinijogurtti. The category query is the automatic fallback.",
			),
		productKind: z
			.enum(["yogurt", "quark", "pudding"])
			.optional()
			.describe(
				"Use yogurt for spoonable jogurtti. It excludes quark, skyr and drinks; request those separately only if the user wants alternatives. Omit productKind for a specific yogurt-drink query.",
			),
		nameTerms: z
			.array(z.string().trim().min(1).max(40))
			.max(3)
			.default([])
			.describe(
				"Only explicit flavour/brand words, e.g. vanilja. NEVER dietary or nutrition words such as laktoositon, proteiini, protein, sokeriton. Leave empty unless requested.",
			),
		lactoseFree: z
			.boolean()
			.default(false)
			.describe(
				"Require an explicit lactose-free claim in product details, not merely a name keyword during discovery.",
			),
		excludeSweeteners: z
			.boolean()
			.default(false)
			.describe(
				"Require ingredients and no detected sweeteners. Unknown ingredients do not qualify.",
			),
		rankBy: z
			.enum(["relevance", "protein", "sugar", "price"])
			.default("relevance")
			.describe(
				"protein: highest measured protein/100g; sugar: lowest measured total sugar/100g; price: unit price. Use relevance when no priority was stated. No arbitrary high-protein threshold is assumed.",
			),
		chain: z.enum(["s-kaupat", "k-ruoka"]).optional(),
		storeName: z
			.string()
			.trim()
			.min(1)
			.max(100)
			.optional()
			.describe(
				"Optional human store name/banner from the user, e.g. Prisma or S-market Kivistö. Never ask the user for store IDs.",
			),
	})
	.strict();

export const groceryTool = {
	type: "function",
	name: "find_groceries",
	strict: false,
	description:
		"Find and compare groceries in the selected city. Resolves stores internally, searches targeted then broader category terms, checks labels for dietary requirements and ranks numeric nutrition/unit prices. Returns verified matches, missing evidence, rejection counts, searched stores and source links. Use this FIRST for local product recommendations. City selection does not imply nearest stores. K/S catalogs only; Lidl has separate partial-catalog tools.",
	parameters: z.toJSONSchema(SearchInput, { io: "input" }),
};

const positiveLactose =
	/\b(?:laktoositon|laktoosittom\w*|laktosfri\w*|lactose[ -]free)\b/i;
const negativeLactose =
	/\b(?:ei\s+(?:ole\s+)?laktoositon|inte\s+laktosfri|not\s+lactose[ -]free|non[ -]lactose[ -]free)\b/i;
export function lactoseEvidence(product) {
	const texts = [
		product.name,
		product.description,
		...(product.claims ?? []),
		product.labelText,
	].filter(Boolean);
	if (texts.some((text) => negativeLactose.test(text))) return null;
	return texts.find((text) => positiveLactose.test(text)) ?? null;
}

export function unpack(result) {
	if (result.isError)
		throw new Error(
			result.content?.find((c) => c.type === "text")?.text ||
				"Grocery provider failed.",
		);
	if (result.structuredContent) return result.structuredContent;
	const text = result.content?.find((c) => c.type === "text")?.text;
	if (!text) throw new Error("Grocery tool returned no data.");
	return JSON.parse(text);
}

function candidateFits(product, input) {
	const name = normalizeText(`${product.name} ${product.brand ?? ""}`);
	if (input.productKind === "yogurt" && /skyr|juoma|drink|drick/.test(name))
		return false;
	return (
		matchesCriteria(product, input) &&
		input.nameTerms.every((term) => name.includes(normalizeText(term)))
	);
}

export function compactProduct(product, store, reasons) {
	return {
		id: product.id,
		gtins: product.gtins,
		name: product.name,
		imageUrl: product.imageUrl ?? null,
		category: product.categoryPath ?? product.category,
		store: { id: store.id, name: store.name, chain: store.chain },
		price: product.price,
		unitPrice: product.pricing?.unitPrice ?? null,
		nutritionPer100g: product.nutritionAssessment?.per100g ?? null,
		// Retain the label even when its preparation/basis prevents automatic ranking.
		nutritionTables: product.nutrition ?? [],
		nutritionWarnings: product.nutritionAssessment?.warnings ?? [],
		lactoseFreeEvidence: lactoseEvidence(product),
		sweeteners: product.nutritionAssessment?.sweeteners ?? null,
		ingredients: product.ingredients,
		claims: product.claims,
		priceConditions: product.pricing?.conditions ?? [],
		availability: product.availability,
		source: product.source,
		warnings: product.warnings ?? [],
		...(reasons === undefined ? {} : { unmetRequirements: reasons }),
	};
}

export async function findGroceries(
	args,
	{
		mcp,
		city,
		signal,
		emit = () => {},
		maxDetails = 24,
		timeBudgetMs = 90_000,
	},
) {
	const input = SearchInput.parse(args);
	if (!input.city && !city)
		return {
			status: "needs_location",
			message:
				"Ask for a city or have the user select it above the chat. Never ask for store IDs or require a postcode.",
		};
	const location = resolveCity(input.city ?? city);
	if (
		input.nameTerms.some((term) =>
			/laktoos|lactos|laktos|protein|proteiin|soker|sugar|sweetener/i.test(
				term,
			),
		)
	) {
		throw new Error(
			"Dietary/nutrition words cannot be nameTerms. Use lactoseFree, excludeSweeteners and rankBy; retain only explicit flavour or brand words.",
		);
	}
	const started = Date.now(),
		warnings = [],
		failures = [],
		searches = [],
		products = [],
		unverified = [];
	const counts = {
		scanned: 0,
		rejectedBeforeDetails: 0,
		detailsAttempted: 0,
		rejectedAfterDetails: 0,
	};
	let budgetReached = false;
	const expired = () => {
		if (
			Date.now() - started >= timeBudgetMs ||
			counts.detailsAttempted >= maxDetails
		)
			budgetReached = true;
		return budgetReached;
	};
	const call = async (name, arguments_) => {
		signal.throwIfAborted();
		const result = await mcp.call(name, arguments_, signal);
		signal.throwIfAborted();
		return unpack(result);
	};
	const selections = [];
	const chains = input.chain ? [input.chain] : ["s-kaupat", "k-ruoka"];
	for (const chain of chains) {
		emit({ type: "status", text: `Finding stores in ${location}…` });
		try {
			const data = await call("get_stores", { chain, city: location });
			warnings.push(...(data.warnings ?? []));
			const stores = data.stores.filter(
				(s) =>
					s.chain === chain &&
					(!input.storeName ||
						normalizeText(s.name).includes(normalizeText(input.storeName))),
			);
			stores.sort(
				(a, b) =>
					Number(/prisma|citymarket/i.test(b.name)) -
						Number(/prisma|citymarket/i.test(a.name)) ||
					a.name.localeCompare(b.name, "fi"),
			);
			if (stores[0]) selections.push(stores[0]);
			if (stores.length > 1)
				warnings.push(
					`Selected ${stores[0].name} from ${stores.length} matching ${chain} stores for this first pass; these are not necessarily the nearest stores.`,
				);
		} catch (error) {
			signal.throwIfAborted();
			failures.push({ chain, stage: "stores", error: error.message });
		}
	}
	if (!selections.length)
		return {
			status: failures.length ? "provider_failure" : "no_stores",
			city: location,
			stores: [],
			failures,
			message:
				"No matching searchable stores were resolved. Check the city/store name; do not invent an ID.",
		};
	const targeted = [
		...new Set(
			input.queries.filter(
				(query) => normalizeText(query) !== normalizeText(input.categoryQuery),
			),
		),
	];
	const phases = targeted.length
		? [targeted, [input.categoryQuery]]
		: [[input.categoryQuery]];
	const seen = new Set(),
		candidates = new Set(),
		failedStores = new Set();
	for (let phase = 0; phase < phases.length; phase++) {
		if (expired()) break;
		if (phase)
			emit({
				type: "status",
				text: "Broadening the search while keeping your dietary requirements…",
			});
		const queues = [];
		for (const store of selections) {
			const queue = new Map();
			if (failedStores.has(store.id)) continue;
			for (const query of phases[phase]) {
				if (expired()) break;
				emit({ type: "status", text: `Searching ${store.name}: ${query}…` });
				try {
					const data = await call("search_products", {
						chain: store.chain,
						storeId: store.id,
						query,
						limit: 50,
					});
					if (
						!Array.isArray(data.products) ||
						data.chain !== store.chain ||
						data.storeId !== store.id
					)
						throw new Error(
							"Search returned an unexpected store or result format.",
						);
					const report = {
						store: store.name,
						query,
						returned: data.products.length,
						candidates: 0,
						nextOffset: data.nextOffset ?? null,
						broadened: phase > 0,
					};
					searches.push(report);
					warnings.push(...(data.warnings ?? []));
					for (const product of data.products) {
						counts.scanned++;
						if (!candidateFits(product, input)) {
							counts.rejectedBeforeDetails++;
							continue;
						}
						report.candidates++;
						candidates.add(`${store.chain}:${store.id}:${product.id}`);
						if (!seen.has(`${store.chain}:${store.id}:${product.id}`))
							queue.set(product.id, { product, store });
					}
				} catch (error) {
					signal.throwIfAborted();
					failures.push({
						store: store.name,
						query,
						stage: "search",
						error: error.message,
					});
					failedStores.add(store.id);
					break;
				}
			}
			// Known label clues only prioritize inspection; missing clues never exclude candidates.
			queues.push(
				[...queue.values()].sort((a, b) => {
					if (input.lactoseFree) {
						const claim =
							Number(Boolean(lactoseEvidence(b.product))) -
							Number(Boolean(lactoseEvidence(a.product)));
						if (claim) return claim;
					}
					if (input.rankBy === "protein")
						return (
							Number(/protein|proteiin|profeel/i.test(b.product.name)) -
							Number(/protein|proteiin|profeel/i.test(a.product.name))
						);
					if (
						input.rankBy === "price" &&
						a.product.pricing?.unitPrice?.unit ===
							b.product.pricing?.unitPrice?.unit
					)
						return (
							(a.product.pricing?.unitPrice?.amount ?? Infinity) -
							(b.product.pricing?.unitPrice?.amount ?? Infinity)
						);
					return 0;
				}),
			);
		}
		// Reserve half the detail budget for a broader query, including price/nutrition comparisons.
		const phaseLimit =
			phases.length > 1 && phase === 0 ? Math.ceil(maxDetails / 2) : maxDetails;
		for (let index = 0; queues.some((queue) => queue.length > index); index++) {
			for (const queue of queues) {
				if (counts.detailsAttempted >= phaseLimit || expired()) break;
				const item = queue[index];
				if (!item) continue;
				const { product: summary, store } = item;
				seen.add(`${store.chain}:${store.id}:${summary.id}`);
				counts.detailsAttempted++;
				emit({
					type: "status",
					text: `Checking labels · ${store.name} · ${counts.detailsAttempted} checked…`,
				});
				try {
					const product = await call("get_product", {
						chain: store.chain,
						storeId: store.id,
						id: summary.id,
					});
					if (
						product.id !== summary.id ||
						product.chain !== store.chain ||
						product.storeId !== store.id
					)
						throw new Error(
							"Product details belong to a different product or store.",
						);
					const reasons = [];
					if (!candidateFits(product, input))
						reasons.push(
							"Product category/flavour does not match the request.",
						);
					if (input.lactoseFree && !lactoseEvidence(product))
						reasons.push("No verified lactose-free claim.");
					if (
						input.excludeSweeteners &&
						(!product.ingredients ||
							product.nutritionAssessment?.sweeteners?.status !==
								"not_detected")
					)
						reasons.push("Sweeteners detected or ingredient evidence missing.");
					const nutrient =
						input.rankBy === "protein"
							? "protein"
							: input.rankBy === "sugar"
								? "sugars"
								: null;
					if (
						nutrient &&
						product.nutritionAssessment?.per100g?.[nutrient] == null
					)
						reasons.push(
							product.nutrition?.some((table) => table.values?.length)
								? `Label nutrition is available, but ${nutrient} could not be normalized for an as-sold per-100-g comparison. See nutritionTables and nutritionWarnings.`
								: `Comparable ${nutrient} per 100 g is missing.`,
						);
					if (
						input.rankBy === "price" &&
						(product.price == null || product.pricing?.unitPrice == null)
					)
						reasons.push("Comparable current price is missing.");
					if (product.availability?.inStore === false)
						reasons.push(
							"Retailer explicitly marks this offer unavailable in store.",
						);
					const compact = compactProduct(product, store, reasons);
					if (reasons.length) {
						counts.rejectedAfterDetails++;
						unverified.push(compact);
					} else products.push(compact);
				} catch (error) {
					signal.throwIfAborted();
					failures.push({
						store: store.name,
						id: summary.id,
						stage: "details",
						error: error.message,
					});
				}
			}
			if (counts.detailsAttempted >= phaseLimit || expired()) break;
		}
		if (
			input.rankBy === "relevance" &&
			new Set(products.map((p) => (p.gtins?.length === 1 ? p.gtins[0] : p.id)))
				.size >= 3
		)
			break;
	}
	const units = new Set(products.map((p) => p.unitPrice?.unit).filter(Boolean));
	const priceDifference = (a, b) =>
		units.size === 1
			? (a.unitPrice?.amount ?? Infinity) - (b.unitPrice?.amount ?? Infinity)
			: 0;
	products.sort((a, b) => {
		if (input.rankBy === "protein")
			return (
				b.nutritionPer100g.protein - a.nutritionPer100g.protein ||
				(a.nutritionPer100g.sugars ?? Infinity) -
					(b.nutritionPer100g.sugars ?? Infinity) ||
				priceDifference(a, b)
			);
		if (input.rankBy === "sugar")
			return (
				a.nutritionPer100g.sugars - b.nutritionPer100g.sugars ||
				priceDifference(a, b)
			);
		if (input.rankBy === "price") return priceDifference(a, b);
		return 0;
	});
	if (units.size > 1)
		warnings.push(
			"Mixed unit-price bases: no overall cheapest ranking was made. Compare only within the same unit.",
		);
	// Keep a diverse shortlist while retaining every inspected store offer for each item.
	const grouped = new Map();
	for (const product of products) {
		const key =
			product.gtins?.length === 1
				? product.gtins[0]
				: `${product.store.chain}:${product.id}`;
		const group = grouped.get(key) ?? { ...product, otherOffers: [] };
		if (grouped.has(key)) group.otherOffers.push(product);
		grouped.set(key, group);
	}
	budgetReached ||= counts.detailsAttempted >= maxDetails;
	const status = products.length
		? "matches"
		: budgetReached && counts.scanned === 0
			? "incomplete"
			: counts.scanned === 0
				? failures.length
					? "provider_failure"
					: "no_search_results"
				: "no_verified_matches";
	return {
		status,
		city: location,
		criteria: input,
		stores: selections.map((s) => ({ id: s.id, name: s.name, chain: s.chain })),
		ranking:
			input.rankBy === "relevance"
				? "Candidate order; no universal best-product score."
				: input.rankBy === "protein"
					? "Highest measured protein per 100 g, then lowest total sugar, then comparable unit price. No high-protein claim or threshold is inferred."
					: input.rankBy === "sugar"
						? "Lowest measured total sugar per 100 g, then comparable unit price; not added sugar."
						: units.size > 1
							? "Prices have different units; no overall ranking."
							: "Lowest unit price among verified candidates.",
		products: [...grouped.values()].slice(0, 6),
		unverified: unverified.slice(0, 4),
		coverage: {
			...counts,
			uniqueCandidateOffers: candidates.size,
			detailsSkipped: candidates.size - counts.detailsAttempted,
			searches,
			detailBudget: maxDetails,
			budgetReached,
			elapsedMs: Date.now() - started,
			uniqueMatches: grouped.size,
			completeMarketCoverage: false,
		},
		failures,
		warnings: [
			...new Set([
				...warnings,
				"Bounded first pass: at most 50 results per query/store and 24 label requests. No guarantee of the best product across the city; shelf stock is unknown.",
			]),
		],
		nextStep:
			status === "no_verified_matches"
				? "Explain missing evidence/rejections, not absence of products. Keep dietary constraints. Offer a separate category such as skyr/quark only with the user's agreement."
				: null,
	};
}
