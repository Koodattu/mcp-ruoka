import assert from "node:assert/strict";
import test from "node:test";
import { parseSse, runAgent, toolOutput } from "../agent.mjs";

const answer = (text) => ({
	output: [
		{
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text }],
		},
	],
});
const call = (name, args = "{}", id = "c1") => ({
	type: "function_call",
	name,
	arguments: args,
	call_id: id,
});
const signal = () => new AbortController().signal;

test("Luna uses high reasoning with room for reasoning tokens; Terra stays low", async () => {
	for (const [model, effort, cap] of [
		["gpt-6-luna", "high", 16000],
		["gpt-6-luna-2026-10-01", "high", 16000],
		["gpt-6.1-terra", "low", 5000],
	]) {
		await runAgent({
			model,
			apiKey: "test",
			history: [],
			message: "Hello",
			mcp: { tools: async () => [] },
			emit() {},
			signal: signal(),
			respond: async (request) => {
				assert.equal(request.reasoning.effort, effort);
				assert.equal(request.max_output_tokens, cap);
				return answer("Hello");
			},
		});
	}
});

test("current city context is replayable and new search replaces the old comparison tool", async () => {
	let request;
	const result = await runAgent({
		model: "test",
		apiKey: "test",
		message: "Paras jogurtti?",
		history: [],
		city: "Seinäjoki",
		signal: signal(),
		emit() {},
		mcp: {
			tools: async () => [
				{ name: "compare_products" },
				{ name: "get_preferences" },
			],
		},
		respond: async (req) => {
			request = req;
			return answer("Mikä on sinulle tärkeintä?");
		},
	});
	assert.match(request.instructions, /Seinäjoki/);
	assert.ok(request.tools.some((tool) => tool.name === "discover_groceries"));
	assert.ok(request.tools.some((tool) => tool.name === "inspect_groceries"));
	assert.ok(!request.tools.some((tool) => tool.name === "compare_products"));
	assert.equal(result.input[0].role, "developer");
	assert.match(result.input[0].content, /Seinäjoki/);
});

test("SSE preserves UTF-8 and CRLF boundaries split across network chunks", async () => {
	const bytes = new TextEncoder().encode(
		'event: response.output_text.delta\r\ndata: {"text":"jogurtti ä €"}\r\n\r\ndata: {"ok":true}\n\n',
	);
	async function* chunks() {
		for (const byte of bytes) yield Uint8Array.of(byte);
	}
	const result = [];
	for await (const event of parseSse(chunks())) result.push(event);
	assert.deepEqual(result, [{ text: "jogurtti ä €" }, { ok: true }]);
});

test("tool loop preserves reasoning, call IDs, errors and evidence for a follow-up", async () => {
	const events = [],
		requests = [],
		executed = [];
	const reasoning = {
		type: "reasoning",
		id: "r1",
		summary: [],
		encrypted_content: "opaque-state",
	};
	const mcp = {
		tools: async () => [{ type: "function", name: "search_products" }],
		call: async (name, args) => {
			executed.push({ name, args });
			return {
				structuredContent: {
					products: [
						{ name: "Test yogurt", source: "https://example.com/yogurt" },
					],
				},
			};
		},
	};
	const history = [
		{ role: "user", content: "My postcode is 60100." },
		...answer("Understood.").output,
	];
	const result = await runAgent({
		model: "gpt-6-luna",
		apiKey: "test",
		message: "Find yogurt",
		history,
		mcp,
		signal: signal(),
		emit: (e) => events.push(e),
		respond: async (req) => {
			requests.push(structuredClone(req));
			return requests.length === 1
				? {
						output: [
							reasoning,
							call("search_products", '{"query":"jogurtti","chain":"lidl"}'),
						],
					}
				: answer("Here is the yogurt.");
		},
	});
	assert.equal(result.text, "Here is the yogurt.");
	assert.ok(requests[0].tools.some((tool) => tool.name === "search_products"));
	assert.deepEqual(executed, [
		{ name: "search_products", args: { query: "jogurtti", chain: "lidl" } },
	]);
	assert.deepEqual(requests[1].input.slice(0, history.length), history);
	assert.ok(
		requests[1].input.some((item) => item.encrypted_content === "opaque-state"),
	);
	const output = requests[1].input.find(
		(item) => item.type === "function_call_output",
	);
	assert.equal(output.call_id, "c1");
	assert.match(output.output, /Test yogurt/);
	assert.equal(result.input[0].content, "Find yogurt");
	assert.equal(events.filter((e) => e.type === "tool_end").length, 1);
});

test("malformed arguments are recoverable tool errors, not executed", async () => {
	let count = 0,
		second;
	const result = await runAgent({
		model: "x",
		apiKey: "test",
		message: "Search",
		history: [],
		signal: signal(),
		emit() {},
		mcp: {
			tools: async () => [],
			call() {
				assert.fail("Malformed input must not reach MCP");
			},
		},
		respond: async (req) => {
			if (++count === 1)
				return { output: [call("search_products", "{broken")] };
			second = structuredClone(req);
			return answer("The search failed.");
		},
	});
	assert.equal(result.text, "The search failed.");
	assert.equal(
		JSON.parse(
			second.input.find((i) => i.type === "function_call_output").output,
		).isError,
		true,
	);
});

test("tool budget forces a final answer without running extra calls", async () => {
	let requests = 0,
		calls = 0;
	await runAgent({
		model: "x",
		apiKey: "test",
		message: "Search",
		history: [],
		maxCalls: 1,
		signal: signal(),
		emit() {},
		mcp: {
			tools: async () => [],
			call: async () => {
				calls++;
				return { content: [] };
			},
		},
		respond: async (req) => {
			if (++requests === 1) return { output: [call("get_capabilities")] };
			assert.equal(req.tool_choice, "none");
			return answer("Partial findings.");
		},
	});
	assert.equal(calls, 1);
	assert.equal(requests, 2);
});

test("abort interrupts the loop before another model call", async () => {
	const controller = new AbortController();
	let requests = 0;
	await assert.rejects(
		runAgent({
			model: "x",
			apiKey: "test",
			message: "Search",
			history: [],
			signal: controller.signal,
			emit() {},
			mcp: {
				tools: async () => [],
				call: async () => {
					controller.abort(new Error("stopped"));
					throw controller.signal.reason;
				},
			},
			respond: async () => {
				requests++;
				return { output: [call("get_capabilities")] };
			},
		}),
		/stopped/,
	);
	assert.equal(requests, 1);
});

test("large tool output is explicitly marked incomplete", () => {
	const result = JSON.parse(
		toolOutput({ structuredContent: { products: "x".repeat(200) } }, 50),
	);
	assert.equal(result.truncated, true);
	assert.equal(result.prefix.length, 50);
	assert.match(result.warning, /do not infer/);
});
