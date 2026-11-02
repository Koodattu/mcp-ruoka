import { createRequire } from "node:module";
import { resolve } from "node:path";
import { RankingCriteriaSchema } from "../mcp-ruoka/src/ranking-schema.ts";
import { resolveCity } from "./cities.mjs";
import { config } from "./config.mjs";
import { compactProduct, unpack } from "./search.mjs";

const z = createRequire(resolve(config.mcpDir, "package.json"))("zod/v4");
const ComparisonInput = RankingCriteriaSchema.extend({
	city: z.string().trim().min(1).max(100).optional(),
	chain: z.enum(["s-kaupat", "k-ruoka"]).optional(),
	storeName: z.string().trim().min(1).max(100).optional(),
});
const DiscoveryInput = z
	.object({
		query: z.string().trim().min(1).max(100),
		city: z.string().trim().min(1).max(100).optional(),
		chain: z.enum(["s-kaupat", "k-ruoka"]).optional(),
		storeName: z.string().trim().min(1).max(100).optional(),
		offset: z.number().int().min(0).max(10000).default(0),
	})
	.strict();
const InspectionInput = z
	.object({
		products: z
			.array(
				z
					.object({
						chain: z.enum(["s-kaupat", "k-ruoka", "lidl"]),
						storeId: z.string().min(1).optional(),
						id: z.string().regex(/^\d{1,14}$/),
						refresh: z.boolean().default(false),
					})
					.strict(),
			)
			.min(1)
			.max(8),
	})
	.strict();
export const workflowTools = [
	{
		type: "function",
		name: "compare_groceries",
		strict: false,
		description:
			"Use for best/cheapest/nutrient/size comparisons or sorted lists. The MCP automatically checks ALL search pages in selected city stores, deduplicates barcodes, retrieves only missing needed labels and computes exact rankings. Choose fields to return only requested metrics, plus sort/constraint metrics. Ordered sort is lexicographic priority: price asc, proteinPer100g desc, kcalPerItem asc, sizeG desc, etc. For multiple competing preferences WITHOUT a priority use mode tradeoffs with each objective; never invent numerical limits or weights. price is package purchase cost, itemPrice is per bar within a multipack. A precise ordered objective may produce a winner; tradeoffs may need a user priority. Never replace incomplete coverage with a definitive claim. Follow-ups repeat the constraints and reuse cached labels. freshness=current_prices is only for an explicitly current check.",
		parameters: z.toJSONSchema(ComparisonInput, { io: "input" }),
	},
	{
		type: "function",
		name: "discover_groceries",
		strict: false,
		description:
			"Explore unfamiliar categories or qualitative product requirements using compact candidates, then inspect selected labels. For numeric rankings, best/cheapest comparisons and sorted lists use compare_groceries instead: discovery is only a partial page and cannot establish a winner. Use nextOffset to browse more candidates.",
		parameters: z.toJSONSchema(DiscoveryInput, { io: "input" }),
	},
	{
		type: "function",
		name: "inspect_groceries",
		strict: false,
		description:
			"Read full labels, nutrition, photos and store offers for up to 8 selected references from discovery/earlier results. Keeps per-item failures and source timestamps. Verify all user requirements against these labels before recommending. Uses the MCP cache; refresh only for an explicit current check.",
		parameters: z.toJSONSchema(InspectionInput, { io: "input" }),
	},
];
const normalize = (text) =>
	text
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLocaleLowerCase("fi");

export async function compareGroceries(
	args,
	{ mcp, city, signal, emit = () => {} },
) {
	const input = ComparisonInput.parse(args);
	if (!input.city && !city)
		return {
			status: "needs_location",
			message: "Choose a shopping city; no store ID needed.",
		};
	const location = resolveCity(input.city ?? city);
	const stores = [],
		warnings = [],
		failures = [];
	for (const chain of input.chain ? [input.chain] : ["s-kaupat", "k-ruoka"]) {
		signal.throwIfAborted();
		try {
			const directory = unpack(
				await mcp.call("get_stores", { chain, city: location }, signal),
			);
			const matches = directory.stores.filter(
				(s) =>
					s.chain === chain &&
					(!input.storeName ||
						normalize(s.name).includes(normalize(input.storeName))),
			);
			matches.sort(
				(a, b) =>
					Number(/prisma|citymarket/i.test(b.name)) -
						Number(/prisma|citymarket/i.test(a.name)) ||
					a.name.localeCompare(b.name, "fi"),
			);
			const selected = matches.slice(
				0,
				Math.min(input.storeName ? 2 : 1, 2 - stores.length),
			);
			stores.push(
				...selected.map((s) => ({ chain, storeId: s.id, name: s.name })),
			);
			if (matches.length > selected.length)
				warnings.push(
					`Compared ${selected.length} of ${matches.length} matching ${chain} stores; not city-wide coverage.`,
				);
		} catch (error) {
			signal.throwIfAborted();
			failures.push({ chain, error: error.message });
		}
	}
	if (!stores.length)
		return {
			status: failures.length ? "provider_failure" : "no_stores",
			failures,
			city: location,
		};
	const { city: _city, chain: _chain, storeName: _name, ...criteria } = input;
	emit({ type: "status", text: "Collecting the full comparison…" });
	const result = unpack(
		await mcp.call(
			"rank_products",
			{ ...criteria, stores },
			signal,
			(progress) => {
				if (progress.message) emit({ type: "status", text: progress.message });
			},
		),
	);
	if (failures.length) {
		result.status = "incomplete";
		result.coverage.complete = false;
		result.winnerId = null;
		result.limitation = [
			result.limitation,
			"A requested retailer's store directory failed; its products were not compared.",
		]
			.filter(Boolean)
			.join(" ");
	}
	return {
		...result,
		city: location,
		stores,
		failures,
		warnings: [...warnings, ...(result.warnings ?? [])],
	};
}
export async function discoverGroceries(
	args,
	{ mcp, city, signal, emit = () => {} },
) {
	const input = DiscoveryInput.parse(args);
	if (!input.city && !city)
		return {
			status: "needs_location",
			message:
				"Ask for a city or suggest the city picker. No postcode or store ID is required.",
		};
	const location = resolveCity(input.city ?? city);
	const products = [],
		searches = [],
		failures = [],
		stores = [],
		warnings = [];
	const cache = { hits: 0, misses: 0 };
	for (const chain of input.chain ? [input.chain] : ["s-kaupat", "k-ruoka"]) {
		signal.throwIfAborted();
		try {
			const directory = unpack(
				await mcp.call("get_stores", { chain, city: location }, signal),
			);
			warnings.push(...(directory.warnings ?? []));
			const matches = directory.stores.filter(
				(s) =>
					s.chain === chain &&
					(!input.storeName ||
						normalize(s.name).includes(normalize(input.storeName))),
			);
			matches.sort(
				(a, b) =>
					Number(/prisma|citymarket/i.test(b.name)) -
						Number(/prisma|citymarket/i.test(a.name)) ||
					a.name.localeCompare(b.name, "fi"),
			);
			const selected = matches.slice(
				0,
				Math.min(input.storeName ? 2 : 1, Math.max(0, 2 - stores.length)),
			);
			if (matches.length > selected.length)
				warnings.push(
					`Selected ${selected.length} of ${matches.length} matching ${chain} stores; this is not city-wide coverage or a nearest-store search.`,
				);
			for (const store of selected) {
				signal.throwIfAborted();
				stores.push({ id: store.id, name: store.name, chain });
				emit({ type: "status", text: `Browsing products · ${store.name}…` });
				try {
					const result = unpack(
						await mcp.call(
							"discover_products",
							{
								chain,
								storeId: store.id,
								query: input.query,
								limit: 50,
								offset: input.offset,
							},
							signal,
						),
					);
					if (result.chain !== chain || result.storeId !== store.id)
						throw new Error("Discovery returned a different store.");
					products.push(
						...result.products.map((p) => ({
							...p,
							store: { id: store.id, name: store.name, chain },
						})),
					);
					searches.push({
						store: store.name,
						storeId: store.id,
						chain,
						returned: result.products.length,
						totalCount: result.totalCount,
						nextOffset: result.nextOffset,
						hasGoodResults: result.hasGoodResults ?? null,
					});
					warnings.push(...(result.warnings ?? []));
					cache.hits += result.cache?.hits ?? 0;
					cache.misses += result.cache?.misses ?? 0;
				} catch (error) {
					signal.throwIfAborted();
					failures.push({ chain, store: store.name, error: error.message });
				}
			}
		} catch (error) {
			signal.throwIfAborted();
			failures.push({ chain, error: error.message });
		}
	}
	return {
		status: products.length
			? "candidates"
			: failures.length
				? "provider_failure"
				: stores.length
					? "no_results"
					: "no_stores",
		city: location,
		query: input.query,
		products,
		stores,
		searches,
		failures,
		warnings,
		cache,
		nextStep:
			"Select relevant candidates by category, cut/type, flavour/brand and value; inspect 5–8 before recommending. Reject obvious mismatches. Broaden synonyms or paginate if weak; never infer absence from a partial list.",
	};
}

export async function inspectGroceries(args, { mcp, signal, emit = () => {} }) {
	const input = InspectionInput.parse(args);
	signal.throwIfAborted();
	emit({
		type: "status",
		text: `Checking ${input.products.length} selected product labels…`,
	});
	const result = unpack(await mcp.call("get_products", input, signal));
	signal.throwIfAborted();
	const directories = new Map();
	const products = [];
	for (const product of result.products) {
		if (
			!input.products.some(
				(p) =>
					p.id === product.id &&
					p.chain === product.chain &&
					(p.storeId ?? null) === (product.storeId ?? null),
			)
		)
			throw new Error("Details returned an unrequested product or store.");
		if (!directories.has(product.chain)) {
			const directory = unpack(
				await mcp.call("get_stores", { chain: product.chain }, signal),
			);
			directories.set(product.chain, directory.stores);
		}
		const store = directories
			.get(product.chain)
			.find((s) => s.id === product.storeId) ?? {
			id: product.storeId,
			name: product.chain,
			chain: product.chain,
		};
		products.push(compactProduct(product, store));
	}
	return {
		status: products.length ? "inspected" : "details_failed",
		products,
		failures: result.failures,
		cache: result.cache,
		note: "These are inspected candidates. Check ingredients, category and every user requirement before recommending; prepared nutrition and unknowns remain labelled. A price is not proof of store availability.",
	};
}
