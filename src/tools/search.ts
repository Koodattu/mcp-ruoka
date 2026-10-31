import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
	CompareInputSchema,
	compareProducts,
	getCapabilities,
	getProduct,
	ProductInputSchema,
	SearchInputSchema,
	searchProducts,
} from "../groceries.ts";
import { getProviderHealth } from "../health.ts";
import { getLidlLeaflets, LidlLeafletsInputSchema } from "../lidl-discovery.ts";
import {
	discoverManufacturerLabel,
	getManufacturerLabel,
	ManufacturerDiscoverySchema,
	ManufacturerSourceSchema,
} from "../manufacturer.ts";
import { getPriceHistory, HistoryInputSchema } from "../observations.ts";
import { toolResult } from "./result.ts";

export function registerSearchTool(server: McpServer): void {
	server.registerTool(
		"discover_manufacturer_label",
		{
			description:
				"Find an Arla or Valio nutrition label from official product sitemaps using a product name and expected GTIN. Checks a bounded number of candidates and package variants. Only exact EAN matches are returned; a miss is not proof of absence. Supply the discovered URL to compare_products manufacturerSources for enrichment.",
			inputSchema: ManufacturerDiscoverySchema,
		},
		(input) => toolResult(() => discoverManufacturerLabel(input)),
	);
	server.registerTool(
		"get_lidl_leaflets",
		{
			description:
				"Search Lidl's published leaflet pages and return PDF/image links, dates and region evidence. Optional storeId (FI...) resolves its offer region; city speeds directory lookup. Page text is not structured pricing and does not prove shelf stock. Regional-only leaflet coverage may be incomplete.",
			inputSchema: LidlLeafletsInputSchema,
		},
		(input) => toolResult(() => getLidlLeaflets(input)),
	);
	server.registerTool(
		"get_manufacturer_label",
		{
			description:
				"Read nutrition and ingredients from an explicit Arla or Valio Finland product URL, validating its EAN against the expected GTIN. Use discover_manufacturer_label to find URLs. Does not provide prices; retains source and timestamp.",
			inputSchema: ManufacturerSourceSchema,
		},
		(input) => toolResult(() => getManufacturerLabel(input)),
	);
	server.registerTool(
		"get_provider_health",
		{
			description:
				"Read search/detail provider health since this process started: successful/failed live loads, last error, latency and in-flight operations. Cached results do not establish current provider health. Does not probe retailer websites.",
			inputSchema: z.object({}),
		},
		() => toolResult(getProviderHealth),
	);
	server.registerTool(
		"get_price_history",
		{
			description:
				"Read locally collected historical price observations for a product; optionally restrict store and starting timestamp. Never current checkout prices. Does not contact retailers.",
			inputSchema: HistoryInputSchema,
		},
		(input) => toolResult(() => getPriceHistory(input)),
	);
	server.registerTool(
		"compare_products",
		{
			description:
				"Compare products across selected or nearby K/S stores, optionally check Lidl's partial published catalog. Provide Finnish query variants and include/exclude name terms to define the category. Rank verified no-added-sugar claims then EUR/kg, total sugar then EUR/kg, or EUR/kg. Unknowns, truncation, failed stores and nonlocal Lidl prices are explicit; this cannot guarantee shelf stock or exact added-sugar grams.",
			inputSchema: CompareInputSchema,
		},
		(input) => toolResult(() => compareProducts(input)),
	);
	server.registerTool(
		"search_products",
		{
			description:
				"Search Finnish groceries. K/S require storeId or a configured default. Lidl has partial published coverage and no store selection. Use get_product for nutrition and ingredients. Supports offset pagination.",
			inputSchema: SearchInputSchema,
		},
		(input) => toolResult(() => searchProducts(input)),
	);
	server.registerTool(
		"get_product",
		{
			description:
				"Get product details: prices, unit prices, ingredients, allergens, nutrition and available catalog flags. ID is from search_products (EAN for K/S, retailer ID for Lidl). Unknown shelf stock is never inferred from a price.",
			inputSchema: ProductInputSchema,
		},
		(input) => toolResult(() => getProduct(input)),
	);
	server.registerTool(
		"get_capabilities",
		{
			description:
				"Get supported retailers, configured default stores, cache lifetimes and coverage limitations.",
			inputSchema: z.object({}),
		},
		() => toolResult(getCapabilities),
	);
}
