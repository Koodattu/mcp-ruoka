import assert from "node:assert/strict";
import test from "node:test";
import { createMcp } from "../mcp.mjs";

test("real stdio MCP discovers read-only tools and returns grocery capabilities", async () => {
	const mcp = createMcp();
	try {
		const tools = await mcp.tools();
		assert.ok(tools.some((tool) => tool.name === "compare_products"));
		assert.ok(tools.some((tool) => tool.name === "search_products"));
		assert.ok(!tools.some((tool) => tool.name === "set_preferences"));
		assert.equal(
			tools.every(
				(tool) => tool.strict === false && tool.parameters.type === "object",
			),
			true,
		);
		const result = await mcp.call(
			"get_capabilities",
			{},
			AbortSignal.timeout(15_000),
		);
		assert.ok(result.structuredContent);
		assert.ok(!result.isError);
		await assert.rejects(
			mcp.call("set_preferences", {}, AbortSignal.timeout(5000)),
			/not available/,
		);
	} finally {
		await mcp.close();
	}
});
