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
import { toolResult } from "./result.ts";

export function registerSearchTool(server: McpServer): void {
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
