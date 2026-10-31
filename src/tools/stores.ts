import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
	getNearbyStores,
	getPreferences,
	getStores,
	NearbyInputSchema,
	PreferencesSchema,
	StoresInputSchema,
	setPreferences,
} from "../groceries.ts";
import { toolResult } from "./result.ts";

export function registerStoresTool(server: McpServer): void {
	server.registerTool(
		"get_nearby_stores",
		{
			description:
				"Find K/S stores near a Finnish postal code or coordinates, ordered by straight-line distance. Postal reference points are approximate and may affect radius boundaries. Returns distance precision, excluded/unlocated counts and truncation; Lidl is unsupported.",
			inputSchema: NearbyInputSchema,
		},
		(input) => toolResult(() => getNearbyStores(input)),
	);
	server.registerTool(
		"get_preferences",
		{
			description: "Read saved local home location, preferred stores and default store settings.",
			inputSchema: z.object({}),
		},
		() => toolResult(getPreferences),
	);
	server.registerTool(
		"set_preferences",
		{
			description:
				"Replace saved local grocery preferences. Writes .ruoka-preferences.json in this project. Omitted fields are cleared; use get_preferences first to preserve existing fields. No retailer account is changed.",
			inputSchema: PreferencesSchema,
		},
		(input) => toolResult(() => setPreferences(input)),
	);
	server.registerTool(
		"get_stores",
		{
			description:
				"Find K-Ruoka and S-Kaupat stores by city. Includes K-Market, K-Supermarket, K-Citymarket, Prisma, S-market and other S stores. Returns IDs for search_products/get_product; Lidl store selection is unsupported.",
			inputSchema: StoresInputSchema,
		},
		(input) => toolResult(() => getStores(input)),
	);
}
