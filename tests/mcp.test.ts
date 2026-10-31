import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("Node stdio advertises grocery tools and returns structured capabilities without opening a browser", async () => {
	const client = new Client({ name: "grocery-test", version: "1" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [resolve("src/index.ts"), "--stdio"],
		stderr: "pipe",
	});
	try {
		await client.connect(transport);
		const tools = await client.listTools();
		assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
			"compare_products",
			"get_capabilities",
			"get_nearby_stores",
			"get_preferences",
			"get_product",
			"get_stores",
			"search_products",
			"set_preferences",
		]);
		const result = await client.callTool({ name: "get_capabilities", arguments: {} });
		assert.ok(result.structuredContent);
		assert.ok(!result.isError);
		const invalid = await client.callTool({
			name: "search_products",
			arguments: { chain: "lidl", storeId: "123", query: "maito" },
		});
		assert.equal(invalid.isError, true);
	} finally {
		await client.close();
	}
});
