import * as z from "zod/v4";
import { getProducts as getSProducts } from "./browser/s-product.ts";
import { matchesProduct, selectPrice } from "./comparison.ts";
import { getProduct, searchProducts } from "./groceries.ts";
import type { GroceryProduct, GrocerySearchResult } from "./grocery-types.ts";
import { observeProvider } from "./health.ts";
import { normalizeText } from "./matching.ts";
import { assessNutrition, mergeNutrition } from "./nutrition.ts";
import { getObservationStore } from "./observations.ts";
import { packageSize } from "./package-size.ts";
import { type Metric, RankProductsSchema } from "./ranking-schema.ts";

export { RankProductsSchema } from "./ranking-schema.ts";

type Input = z.input<typeof RankProductsSchema>;
type Options = z.infer<typeof RankProductsSchema>;
type Store = Options["stores"][number];
type Metrics = Record<Metric, number | null>;
export interface RankingClient {
	search(
		args: {
			chain: Store["chain"];
			storeId: string;
			query: string;
			limit: number;
			offset: number;
			refresh: boolean;
		},
		options: { catalogOnly: boolean },
	): Promise<GrocerySearchResult>;
	cachedLabel(product: GroceryProduct): Promise<GroceryProduct | null>;
	label(product: GroceryProduct): Promise<GroceryProduct>;
	labels?(
		products: GroceryProduct[],
	): Promise<{ products: GroceryProduct[]; failures: Array<{ id: string; error: string }> }>;
	unavailableLabel?(product: GroceryProduct): Promise<boolean>;
}
type Control = {
	signal?: AbortSignal;
	progress?: (message: string) => void | Promise<void>;
	maxPages?: number;
	maxLabels?: number;
	maxDurationMs?: number;
};
const nutritionMetrics = new Set<Metric>([
	"proteinPer100g",
	"kcalPer100g",
	"sugarPer100g",
	"proteinPerItem",
	"kcalPerItem",
	"pricePer20gProtein",
	"proteinPer100kcal",
]);
const moneyMetrics = new Set<Metric>(["price", "itemPrice", "pricePerKg", "pricePer20gProtein"]);
const round = (n: number) => Math.round(n * 10000) / 10000;
function kindMatches(p: GroceryProduct, kind: Options["productKind"]) {
	const name = normalizeText(p.name);
	if (kind === "protein_bar")
		return (
			/proteiin|protein/.test(name) &&
			/patukka|\bbar\b/.test(name) &&
			!/juoma|jauhe|drink/.test(name)
		);
	if (kind === "yogurt")
		return (
			/jogurt|yogurt|yoghurt/.test(name) &&
			!/rahka|kvarg|skyr|vanukas|juoma|juotava|drink|jaatelo|soija|kaura|soy/.test(name)
		);
	return true;
}
function labelEvidence(labels: GroceryProduct[]) {
	return labels.length
		? mergeNutrition(labels.map(assessNutrition))
		: assessNutrition({
				name: "",
				description: null,
				ingredients: null,
				claims: [],
				nutrition: [],
			});
}
function lactoseFree(labels: GroceryProduct[]) {
	return labels.some((p) =>
		/laktoositon|laktoosittom|lactose[ -]?free|laktosfri/i.test(
			[p.name, p.description, ...p.claims].join(" "),
		),
	);
}
function metricsFor(p: GroceryProduct, labels: GroceryProduct[], options: Options): Metrics {
	const size = packageSize(p.name);
	const nutrition = labelEvidence(labels).per100g;
	const offer = selectPrice(p, {
		includeLoyaltyPrices: options.includeLoyaltyPrices,
		allowMultipacks: false,
	});
	const price =
		p.availability.inStore === false || p.pricing.approximate === true ? null : offer.price;
	const protein = nutrition.protein,
		kcal = nutrition.energyKcal;
	return {
		price,
		itemPrice: price != null && size ? round(price / size.units) : null,
		pricePerKg: price != null ? offer.pricePerKg : null,
		sizeG: size?.totalG ?? null,
		proteinPer100g: protein,
		kcalPer100g: kcal,
		sugarPer100g: nutrition.sugars,
		proteinPerItem: protein != null && size ? round((protein * size.itemG) / 100) : null,
		kcalPerItem: kcal != null && size ? round((kcal * size.itemG) / 100) : null,
		pricePer20gProtein:
			price != null && size && protein != null && protein > 0
				? round((price * 20) / ((protein * size.totalG) / 100))
				: null,
		proteinPer100kcal:
			protein != null && kcal != null && kcal > 0 ? round((protein / kcal) * 100) : null,
	};
}
function ordered(a: Metrics, b: Metrics, sort: Options["sort"]) {
	for (const { metric, direction } of sort) {
		const left = a[metric],
			right = b[metric];
		if (left == null || right == null) throw new Error("Cannot rank an unknown metric");
		const diff = (left - right) * (direction === "asc" ? 1 : -1);
		if (diff) return diff;
	}
	return 0;
}
function inBounds(value: number | null, constraint: Options["constraints"][number]) {
	return (
		value != null &&
		(constraint.min == null || value >= constraint.min) &&
		(constraint.max == null || value <= constraint.max)
	);
}
function dominates(a: Metrics, b: Metrics, sort: Options["sort"]) {
	return sort.every((s) => ordered(a, b, [s]) <= 0) && sort.some((s) => ordered(a, b, [s]) < 0);
}

export async function runRanking(input: Input, client: RankingClient, control: Control = {}) {
	const options = RankProductsSchema.parse(input),
		started = Date.now();
	const stores = [...new Map(options.stores.map((s) => [`${s.chain}:${s.storeId}`, s])).values()];
	const queries = new Set(
		options.queries.map((q) =>
			q.normalize("NFC").toLocaleLowerCase("fi").replace(/\s+/g, " ").trim(),
		),
	);
	// Retailer searches return different matches for these category synonyms.
	// Expand general category queries only; preserve explicitly narrowed brand/flavour queries.
	if (
		options.productKind === "protein_bar" &&
		[...queries].some((q) => /^(proteiinipatuk(?:ka|kaa|at)|protein bars?)$/.test(q))
	) {
		queries.add("proteiinipatukka");
		queries.add("protein bar");
	}
	const required = new Set<Metric>([
		...options.sort.map((s) => s.metric),
		...options.constraints.map((c) => c.metric),
	]);
	const fields = [...new Set<Metric>([...options.fields, ...required])];
	const needsLabels =
		fields.some((f) => nutritionMetrics.has(f)) || options.lactoseFree || options.excludeSweeteners;
	const catalogOnly =
		!fields.some((f) => moneyMetrics.has(f)) && options.freshness !== "current_prices";
	const budget = () => Date.now() - started > (control.maxDurationMs ?? 180000);
	const check = () => control.signal?.throwIfAborted();
	const progress = async (text: string) => {
		check();
		await control.progress?.(text);
	};
	const searches: Array<{
		store: string;
		query: string;
		returned: number;
		total: number | null;
		complete: boolean;
		error?: string;
	}> = [];
	const offers = new Map<string, GroceryProduct>();
	const warnings = new Set<string>();
	for (const store of stores)
		for (const query of queries) {
			const coverage = {
				store: store.name ?? store.storeId,
				query,
				returned: 0,
				total: null as number | null,
				complete: false,
				error: undefined as string | undefined,
			};
			searches.push(coverage);
			const seen = new Set<string>();
			let offset = 0;
			try {
				for (let page = 0; page < (control.maxPages ?? 20); page++) {
					check();
					if (budget()) {
						coverage.error = "Time limit reached";
						break;
					}
					await progress(
						`Collecting candidates · ${store.name ?? store.storeId} · ${offers.size} listings`,
					);
					const result = await client.search(
						{
							chain: store.chain,
							storeId: store.storeId,
							query,
							limit: 50,
							offset,
							refresh: options.freshness === "current_prices",
						},
						{ catalogOnly },
					);
					check();
					if (result.chain !== store.chain || result.storeId !== store.storeId)
						throw new Error("Search returned a different store");
					if (coverage.total != null && coverage.total !== result.totalCount)
						coverage.error = "Assortment changed during pagination";
					coverage.total = result.totalCount;
					if (result.hasGoodResults === false)
						coverage.error = "Retailer reported weak matches; refine the search";
					for (const p of result.products) {
						if (p.chain !== store.chain || p.storeId !== store.storeId)
							throw new Error("Candidate belongs to a different store");
						seen.add(p.id);
						offers.set(`${p.chain}:${p.storeId}:${p.id}`, p);
					}
					coverage.returned = seen.size;
					if (result.nextOffset == null) {
						coverage.complete = !coverage.error && seen.size === result.totalCount;
						break;
					}
					if (result.nextOffset <= offset || !result.products.length)
						throw new Error("Pagination did not advance");
					offset = result.nextOffset;
				}
			} catch (error) {
				check();
				coverage.error = error instanceof Error ? error.message : "Search failed";
			}
		}
	const groups = new Map<string, GroceryProduct[]>();
	let excluded = 0;
	for (const p of offers.values()) {
		if (
			!kindMatches(p, options.productKind) ||
			!matchesProduct(p, options.includeTerms, options.excludeTerms)
		) {
			excluded++;
			continue;
		}
		const key = p.gtins.length === 1 && p.gtins[0] === p.id ? `gtin:${p.id}` : `${p.chain}:${p.id}`;
		groups.set(key, [...(groups.get(key) ?? []), p]);
	}
	const unresolved: Array<{ id: string; name: string; reason: string }> = [];
	const eligible: Array<{
		product: GroceryProduct;
		labels: GroceryProduct[];
		metrics: Metrics;
		offers: GroceryProduct[];
	}> = [];
	let labelsFetched = 0,
		labelsReused = 0,
		labelRequests = 0,
		labelAttempts = 0,
		evaluated = 0,
		ruledOut = 0;
	const pending = [...groups.values()].sort(
		(a, b) =>
			Math.min(...a.map((p) => p.price ?? Infinity)) -
			Math.min(...b.map((p) => p.price ?? Infinity)),
	);
	for (const group of pending) {
		check();
		const first = group[0];
		if (!first) continue;
		const unknown = (reason: string) => unresolved.push({ id: first.id, name: first.name, reason });
		if (budget()) {
			unknown("Comparison budget reached; cached work is reusable");
			continue;
		}
		evaluated++;
		let usable = group.filter((p) => p.availability.inStore !== false);
		if (!usable.length) {
			ruledOut++;
			continue;
		}
		const sizes = usable.map((p) => packageSize(p.name)).filter((s) => s != null);
		const firstSize = sizes[0];
		if (
			firstSize &&
			sizes.some((s) => s.totalG !== firstSize.totalG || s.units !== firstSize.units)
		) {
			unknown("Conflicting package sizes for the same barcode");
			continue;
		}
		if (!options.allowMultipacks && sizes.some((s) => s.units > 1)) {
			ruledOut++;
			continue;
		}
		if (
			!options.allowMultipacks &&
			usable.some(
				(p) =>
					!packageSize(p.name) &&
					/multipack|monipakkaus|\d+\s*(?:[x×]|kpl|pcs|pack)\b/i.test(p.name),
			)
		) {
			unknown("Package count cannot be verified for a single-item comparison");
			continue;
		}
		// Only proven constraints can prune before labels. Price is purchase cost, not cost per protein.
		usable = usable.filter((p) => {
			const values = metricsFor(p, [], options);
			return options.constraints.every(
				(c) =>
					nutritionMetrics.has(c.metric) ||
					values[c.metric] == null ||
					inBounds(values[c.metric], c),
			);
		});
		if (!usable.length) {
			ruledOut++;
			continue;
		}
		const labels: GroceryProduct[] = [];
		const labelCandidates = [...new Map(usable.map((p) => [p.chain, p])).values()].sort(
			(a, b) => Number(b.chain === "s-kaupat") - Number(a.chain === "s-kaupat"),
		);
		// An observed GTIN can have an S global label even without a local S offer.
		// This is label enrichment only: never add its fallback price to the offer set.
		const sStore = stores.find((s) => s.chain === "s-kaupat");
		if (sStore && !labelCandidates.some((p) => p.chain === "s-kaupat"))
			labelCandidates.push({ ...first, chain: "s-kaupat", storeId: sStore.storeId });
		const cachedChains = new Set<string>();
		const sufficient = () => {
			const values = metricsFor(usable[0] ?? first, labels, options);
			return (
				fields.filter((f) => nutritionMetrics.has(f)).every((f) => values[f] != null) &&
				(!options.lactoseFree || lactoseFree(labels)) &&
				(!options.excludeSweeteners || labelEvidence(labels).sweeteners.status !== "unknown")
			);
		};
		if (needsLabels) {
			for (const p of labelCandidates) {
				const cached = await client.cachedLabel(p);
				check();
				if (cached) {
					labels.push(cached);
					cachedChains.add(p.chain);
					labelsReused++;
				}
			}
			for (const p of labelCandidates) {
				if (sufficient()) break;
				if (cachedChains.has(p.chain)) continue;
				if (await client.unavailableLabel?.(p)) continue;
				check();
				if (budget() || labelAttempts >= (control.maxLabels ?? 300)) break;
				await progress(
					`Checking labels · ${evaluated}/${groups.size} products · ${labelsReused} cached`,
				);
				try {
					let label: GroceryProduct;
					if (client.labels && p.chain === "s-kaupat") {
						const batch = [p];
						for (const future of pending.slice(evaluated)) {
							if (batch.length >= Math.min(8, (control.maxLabels ?? 300) - labelAttempts)) break;
							const candidate = future.find(
								(o) =>
									o.chain === p.chain &&
									o.storeId === p.storeId &&
									o.availability.inStore !== false,
							);
							if (
								!candidate ||
								(!options.allowMultipacks && (packageSize(candidate.name)?.units ?? 1) > 1)
							)
								continue;
							const values = metricsFor(candidate, [], options);
							if (
								options.constraints.some(
									(c) =>
										!nutritionMetrics.has(c.metric) &&
										values[c.metric] != null &&
										!inBounds(values[c.metric], c),
								)
							)
								continue;
							if (await client.cachedLabel(candidate)) continue;
							if (await client.unavailableLabel?.(candidate)) continue;
							batch.push(candidate);
						}
						check();
						labelRequests++;
						labelAttempts += batch.length;
						const loaded = await client.labels(batch);
						check();
						labelsFetched += loaded.products.length;
						for (const f of loaded.failures) warnings.add(`${f.id}: ${f.error}`);
						const selected = loaded.products.find((l) => l.id === p.id);
						if (!selected) throw new Error("Selected label could not be retrieved in batch");
						label = selected;
					} else {
						labelRequests++;
						labelAttempts++;
						label = await client.label(p);
						labelsFetched++;
					}
					check();
					if (label.id !== p.id || label.chain !== p.chain || label.storeId !== p.storeId)
						throw new Error("Label returned a different product/store");
					labels.push(label);
					// A fresh detail response also refreshes that offer; keep other stores independent.
					usable = usable.map((o) =>
						o.chain === label.chain && o.storeId === label.storeId ? label : o,
					);
				} catch (error) {
					check();
					warnings.add(
						`${p.chain}: ${error instanceof Error ? error.message : "Label request failed"}`,
					);
				}
			}
		}
		const nutrition = labelEvidence(labels);
		if (options.lactoseFree && !lactoseFree(labels)) {
			unknown("Lactose-free status not verified");
			continue;
		}
		if (options.excludeSweeteners && nutrition.sweeteners.status !== "not_detected") {
			if (nutrition.sweeteners.status === "detected") ruledOut++;
			else unknown("Ingredients not verified");
			continue;
		}
		const possible = usable
			.filter((p) => p.availability.inStore !== false)
			.map((p) => ({
				product: p,
				metrics: metricsFor(p, labels, options),
				labels,
				offers: usable,
			}));
		const passing = possible.filter(
			(p) =>
				[...required].every((m) => p.metrics[m] != null) &&
				options.constraints.every((c) => inBounds(p.metrics[c.metric], c)),
		);
		if (!passing.length) {
			if (possible.some((p) => [...required].some((m) => p.metrics[m] == null)))
				unknown("Required price, package size or comparable as-sold nutrition is missing");
			else ruledOut++;
			continue;
		}
		// A missing competing store price can still change the winning offer.
		if (
			required.size &&
			possible.some((p) => [...required].some((m) => moneyMetrics.has(m) && p.metrics[m] == null))
		)
			unknown("A competing store offer has an unknown required price");
		passing.sort(
			(a, b) =>
				ordered(a.metrics, b.metrics, options.sort) ||
				(a.metrics.price ?? Infinity) - (b.metrics.price ?? Infinity),
		);
		const bestOffer = passing[0];
		if (bestOffer) eligible.push(bestOffer);
	}
	check();
	await progress(`Ranking ${eligible.length} eligible products · ${unresolved.length} unresolved`);
	eligible.sort(
		(a, b) =>
			ordered(a.metrics, b.metrics, options.sort) || a.product.id.localeCompare(b.product.id),
	);
	const frontier = eligible.filter(
		(a) => !eligible.some((b) => dominates(b.metrics, a.metrics, options.sort)),
	);
	const ranked = options.mode === "tradeoffs" ? frontier : eligible;
	const complete = searches.every((s) => s.complete) && unresolved.length === 0;
	const best = ranked[0];
	const tieCount = best
		? ranked.filter((p) => ordered(p.metrics, best.metrics, options.sort) === 0).length
		: 0;
	const project = (row: (typeof eligible)[number]) => {
		const p = row.product;
		const store = stores.find((s) => s.chain === p.chain && s.storeId === p.storeId);
		const price = selectPrice(p, {
			includeLoyaltyPrices: options.includeLoyaltyPrices,
			allowMultipacks: false,
		});
		return {
			id: p.id,
			name: p.name,
			store: { id: p.storeId, chain: p.chain, name: store?.name ?? p.storeId },
			metrics: Object.fromEntries(fields.map((f) => [f, row.metrics[f]])),
			package: fields.some((f) => /Item|sizeG|itemPrice|pricePer20g/.test(f))
				? packageSize(p.name)
				: undefined,
			source: p.source,
			labelSources: row.labels.map((l) => l.source),
			verified: {
				lactoseFree: options.lactoseFree || undefined,
				noSweeteners: options.excludeSweeteners || undefined,
			},
			imageUrl: row.labels.find((l) => l.imageUrl)?.imageUrl ?? p.imageUrl,
			availability: p.availability,
			priceConditions: price.selectedConditions,
			otherOffers: row.offers
				.filter((o) => o !== p)
				.map((o) => ({
					id: o.id,
					store: {
						id: o.storeId,
						chain: o.chain,
						name: stores.find((s) => s.chain === o.chain && s.storeId === o.storeId)?.name,
					},
					price: o.price,
					availability: o.availability,
					source: o.source,
				})),
		};
	};
	return {
		winnerId:
			complete && best && tieCount === 1 && (options.mode === "ordered" || frontier.length === 1)
				? best.product.id
				: null,
		needsPriority: options.mode === "tradeoffs" && frontier.length > 1,
		limitation: unresolved.length
			? `${unresolved.length} products have missing or conflicting required evidence. This is a data gap within the searched stores, not merely limited city-wide store coverage.`
			: searches.some((s) => !s.complete)
				? "Not all requested search pages completed successfully."
				: null,
		status: !complete
			? "incomplete"
			: !ranked.length
				? "no_matches"
				: options.mode === "tradeoffs" && frontier.length > 1
					? "choose_priority"
					: tieCount > 1
						? "tied"
						: "ranked",
		rule: {
			filters: {
				productKind: options.productKind,
				includeTerms: options.includeTerms,
				excludeTerms: options.excludeTerms,
				lactoseFree: options.lactoseFree,
				excludeSweeteners: options.excludeSweeteners,
				allowMultipacks: options.allowMultipacks,
				includeLoyaltyPrices: options.includeLoyaltyPrices,
			},
			mode: options.mode,
			sort: options.sort,
			constraints: options.constraints,
			fields,
			freshness: options.freshness,
			itemBasis: "one item within the package; price is whole-package purchase cost",
			scope: "selected stores and exact searches, not the whole market",
		},
		products: ranked.slice(options.offset, options.offset + options.limit).map(project),
		leaders:
			options.mode === "tradeoffs"
				? options.sort.map((s) => {
						const sorted = [...eligible].sort(
							(a, b) =>
								ordered(a.metrics, b.metrics, [s]) || a.product.id.localeCompare(b.product.id),
						);
						const leader = sorted[0];
						return {
							...s,
							product: leader ? project(leader) : null,
							tied: leader
								? sorted.filter((p) => ordered(p.metrics, leader.metrics, [s]) === 0).length
								: 0,
						};
					})
				: undefined,
		coverage: {
			complete,
			searches,
			listings: offers.size,
			distinctProducts: groups.size,
			evaluated,
			labelsFetched,
			labelsReused,
			labelRequests,
			labelAttempts,
			excludedListings: excluded,
			ruledOut,
			eligible: eligible.length,
			unresolved: unresolved.length,
			frontier: frontier.length,
			tieCount,
			returned: Math.min(options.limit, Math.max(0, ranked.length - options.offset)),
			nextOffset:
				options.offset + options.limit < ranked.length ? options.offset + options.limit : null,
			elapsedMs: Date.now() - started,
		},
		unresolved: unresolved.slice(0, 20),
		warnings: [...warnings].slice(0, 10),
		conclusion: complete
			? "Ordering is calculated from the stated rule and observed data. Multiple trade-off leaders require a user priority; do not invent an overall winner."
			: "Do not claim a definitive winner: collection or required evidence is incomplete. Repeating the comparison reuses completed label work.",
	};
}

export async function rankProducts(input: Input, control: Control = {}) {
	const db = await getObservationStore(),
		before = db.cacheStats();
	const missingKey = (p: { chain: string; id: string; storeId: string | null }) =>
		JSON.stringify(["label-missing-v1", p.chain, p.storeId, p.id]);
	const result = await runRanking(
		input,
		{
			search: searchProducts,
			cachedLabel: async (p) => db.readLabel(p),
			unavailableLabel: async (p) => db.readCache(missingKey(p), z.literal(true)) === true,
			label: (p) =>
				getProduct({ chain: p.chain, storeId: p.storeId ?? undefined, id: p.id, refresh: true }),
			labels: async (products) => {
				const first = products[0];
				if (!first?.storeId) throw new Error("A label batch requires a store");
				const storeId = first.storeId;
				const result = await observeProvider("s-kaupat", () =>
					getSProducts(
						products.map((p) => p.id),
						storeId,
					),
				);
				db.record(result.products, "detail");
				for (const f of result.failures)
					if (f.error === "S-Kaupat product not found")
						db.writeCache(missingKey({ ...first, id: f.id }), true, Date.now() + 3600000);
				return result;
			},
		},
		control,
	);
	const after = db.cacheStats();
	return {
		...result,
		cache: { hits: after.hits - before.hits, misses: after.misses - before.misses },
	};
}
