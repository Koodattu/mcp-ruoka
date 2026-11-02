import { createRequire } from "node:module";
import { resolve } from "node:path";
import { resolveCity } from "./cities.mjs";
import { config } from "./config.mjs";
import { compactProduct, unpack } from "./search.mjs";

const z = createRequire(resolve(config.mcpDir, "package.json"))("zod/v4");
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
		name: "discover_groceries",
		strict: false,
		description:
			"FIRST discover a compact candidate list in the selected city (up to 50 per K/S store), without fetching labels. Use short Finnish queries, then select products by name/category/price for inspect_groceries. Reports weak matches and pagination; these are candidates, not verified recommendations. Explicit storeName selects matching stores, including multiple stores when the user requests comparison. Use returned nextOffset to continue one store at a time via storeName.",
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
