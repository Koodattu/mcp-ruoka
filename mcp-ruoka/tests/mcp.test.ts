import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as z from "zod/v4";

test("Node stdio advertises grocery tools and returns structured capabilities without opening a browser", async () => {
	const client = new Client({ name: "grocery-test", version: "1" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [resolve("src/index.ts"), "--stdio"],
		stderr: "pipe",
		env: { RUOKA_DB_PATH: ":memory:" },
	});
	try {
		await client.connect(transport);
		const tools = await client.listTools();
		assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
			"compare_products",
			"discover_manufacturer_label",
			"discover_products",
			"get_capabilities",
			"get_lidl_leaflets",
			"get_manufacturer_label",
			"get_nearby_stores",
			"get_preferences",
			"get_price_history",
			"get_product",
			"get_product_availability",
			"get_products",
			"get_provider_health",
			"get_stores",
			"search_products",
			"set_preferences",
		]);
		const result = await client.callTool({ name: "get_capabilities", arguments: {} });
		assert.ok(result.structuredContent);
		assert.ok(!result.isError);
		const history = await client.callTool({
			name: "get_price_history",
			arguments: { chain: "k-ruoka", id: "6413300024074" },
		});
		assert.ok(!history.isError);
		const historyData = z
			.object({ historical: z.boolean(), observations: z.array(z.unknown()) })
			.parse(history.structuredContent);
		assert.equal(historyData.historical, true);
		assert.deepEqual(historyData.observations, []);
		const health = await client.callTool({ name: "get_provider_health", arguments: {} });
		assert.deepEqual(
			z.object({ providers: z.record(z.string(), z.unknown()) }).parse(health.structuredContent)
				.providers,
			{},
		);
		const invalid = await client.callTool({
			name: "search_products",
			arguments: { chain: "lidl", storeId: "123", query: "maito" },
		});
		assert.equal(invalid.isError, true);
	} finally {
		await client.close();
	}
});
