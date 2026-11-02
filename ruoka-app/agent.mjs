import { instructions } from "./prompt.mjs";
import {
	compareGroceries,
	discoverGroceries,
	inspectGroceries,
	workflowTools,
} from "./workflow.mjs";

export async function* parseSse(body) {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		while (true) {
			const match = /\r?\n\r?\n/.exec(buffer);
			if (!match) break;
			const block = buffer.slice(0, match.index);
			buffer = buffer.slice(match.index + match[0].length);
			const data = block
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (data && data !== "[DONE]") yield JSON.parse(data);
		}
	}
	if (buffer.trim())
		throw new Error(
			"The response stream ended unexpectedly. Please try again.",
		);
}

export async function openaiResponse({ apiKey, ...request }, emit, signal) {
	const response = await fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		signal,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			...request,
			stream: true,
			store: false,
			include: ["reasoning.encrypted_content"],
		}),
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		const code = body.error?.code;
		if (response.status === 401)
			throw new Error(
				"OpenAI rejected the API key. Check OPENAI_API_KEY in ruoka-app/.env and restart.",
			);
		if (code === "model_not_found" || response.status === 404)
			throw new Error(
				`Model ${request.model} is not available to this API key. Choose another model or update OPENAI_MODELS in .env.`,
			);
		if (response.status === 429)
			throw new Error(
				"OpenAI rate limit or quota reached. Check API billing/quota, or try again later.",
			);
		throw new Error(
			`OpenAI request failed (${response.status}${code ? `, ${code}` : ""}). ${body.error?.message || "Please try again."}`,
		);
	}
	let completed;
	for await (const event of parseSse(response.body)) {
		if (event.type === "response.output_text.delta")
			emit({ type: "delta", text: event.delta });
		if (event.type === "response.completed") completed = event.response;
		if (
			["error", "response.failed", "response.incomplete"].includes(event.type)
		) {
			throw new Error(
				event.response?.error?.message ||
					event.message ||
					"The model could not finish this reply. Try a narrower request.",
			);
		}
	}
	if (!completed || !Array.isArray(completed.output))
		throw new Error(
			"OpenAI closed the stream before completing the reply. Please try again.",
		);
	return completed;
}

export function toolOutput(result, maxLength = 60_000) {
	const value = {
		isError: Boolean(result.isError),
		data: result.structuredContent ?? result.content,
	};
	const json = JSON.stringify(value);
	if (json.length <= maxLength) return json;
	return JSON.stringify({
		isError: value.isError,
		truncated: true,
		warning:
			"Tool output exceeded the demo context limit. This is only a prefix; do not infer missing data or complete coverage. Narrow the request if necessary.",
		prefix: json.slice(0, maxLength),
	});
}

export async function runAgent({
	model,
	apiKey,
	history,
	message,
	city = null,
	mcp,
	emit,
	signal,
	respond = openaiResponse,
	maxRounds = 8,
	maxCalls = 16,
}) {
	const input = [...history];
	if (city)
		input.push({
			role: "developer",
			content: `App city selection for this turn: ${city}. A changed app selection replaces the previous default location. An explicit city in the current user request still takes precedence.`,
		});
	input.push({ role: "user", content: message });
	const start = history.length;
	const tools = [
		...workflowTools,
		...(await mcp.tools()).filter(
			(tool) =>
				![
					"compare_products",
					"get_preferences",
					"discover_products",
					"get_products",
					"rank_products",
				].includes(tool.name),
		),
	];
	let callsUsed = 0,
		text = "";
	for (let round = 0; round <= maxRounds; round++) {
		signal.throwIfAborted();
		if (JSON.stringify(input).length > 450_000)
			throw new Error(
				"This conversation has reached the demo context limit. Start a new chat for the next search.",
			);
		const exhausted = round === maxRounds || callsUsed >= maxCalls;
		emit({
			type: "status",
			text: exhausted ? "Putting together the findings…" : "Thinking…",
		});
		const response = await respond(
			{
				apiKey,
				model,
				instructions:
					instructions(city) +
					(exhausted
						? "\nTool budget reached. Finish now with available evidence and disclose gaps."
						: ""),
				input,
				tools,
				tool_choice: exhausted ? "none" : "auto",
				parallel_tool_calls: false,
				reasoning: {
					effort: /^gpt-6-luna(?:-|$)/.test(model) ? "high" : "low",
				},
				// The cap includes private reasoning as well as the visible answer.
				max_output_tokens: /^gpt-6-luna(?:-|$)/.test(model) ? 16000 : 5000,
			},
			emit,
			signal,
		);
		input.push(...response.output);
		const messageText = response.output
			.filter((item) => item.type === "message")
			.flatMap((item) => item.content ?? [])
			.map((part) => part.text ?? part.refusal ?? "")
			.join("");
		if (messageText) text += (text ? "\n\n" : "") + messageText;
		const calls = response.output.filter(
			(item) => item.type === "function_call",
		);
		if (!calls.length) {
			if (!text)
				throw new Error("The model returned no answer. Please try again.");
			return { text, input: input.slice(start) };
		}
		if (exhausted)
			throw new Error(
				"The model exceeded the demo tool budget. Try a more specific request.",
			);
		for (const call of calls) {
			signal.throwIfAborted();
			let output;
			const started = Date.now();
			emit({
				type: "tool_start",
				id: call.call_id,
				name: call.name,
				arguments: call.arguments,
			});
			try {
				if (++callsUsed > maxCalls)
					throw new Error(
						"Tool call budget reached. Use the evidence already gathered.",
					);
				const args = JSON.parse(call.arguments);
				if (!args || typeof args !== "object" || Array.isArray(args))
					throw new Error("Tool arguments must be a JSON object.");
				const result = [
					"discover_groceries",
					"inspect_groceries",
					"compare_groceries",
				].includes(call.name)
					? {
							structuredContent: await (call.name === "compare_groceries"
								? compareGroceries
								: call.name === "discover_groceries"
									? discoverGroceries
									: inspectGroceries)(args, {
								mcp,
								city,
								signal,
								emit,
							}),
						}
					: await mcp.call(call.name, args, signal);
				output = toolOutput(result);
			} catch (error) {
				signal.throwIfAborted();
				output = JSON.stringify({
					isError: true,
					error: error instanceof Error ? error.message : "Tool failed",
				});
			}
			emit({
				type: "tool_end",
				id: call.call_id,
				name: call.name,
				output,
				durationMs: Date.now() - started,
			});
			input.push({
				type: "function_call_output",
				call_id: call.call_id,
				output,
			});
		}
	}
	throw new Error("The search did not finish within the demo budget.");
}
