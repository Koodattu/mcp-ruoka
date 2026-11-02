import assert from "node:assert/strict";
import { parseSse } from "../agent.mjs";
import { config } from "../config.mjs";

// Opt-in integration check: real model, real retailers, saved reviewable chats.
const base = `http://127.0.0.1:${config.port}`;
async function post(path, body) {
	const r = await fetch(base + path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	assert.ok(r.ok, `HTTP ${r.status}`);
	return r;
}
async function newChat() {
	return (
		await (await post("/api/chats", { model: config.defaultModel })).json()
	).id;
}
async function send(id, message) {
	const progress = [];
	const r = await post(`/api/chats/${id}/messages`, {
		model: config.defaultModel,
		message,
	});
	for await (const e of parseSse(r.body)) {
		if (e.type === "error") throw new Error(e.error);
		if (e.type === "status") progress.push(e.text);
	}
	const chat = await (await fetch(`${base}/api/chats/${id}`)).json();
	const turn = chat.turns.at(-1);
	assert.equal(turn.status, "complete");
	const ends = turn.trace.filter(
		(e) => e.type === "tool_end" && e.name === "compare_groceries",
	);
	assert.ok(ends.length, "Use the exhaustive comparison tool");
	const end = ends.at(-1),
		output = JSON.parse(end.output);
	assert.equal(output.isError, false);
	assert.ok(!output.truncated);
	const args = JSON.parse(
		turn.trace.find((e) => e.type === "tool_start" && e.id === end.id)
			.arguments,
	);
	const data = output.data;
	assert.ok(data.products.length);
	assert.ok(
		data.products.every((p) => !("nutrition" in p) && !("ingredients" in p)),
		"Return selected metrics rather than labels",
	);
	const linked = [
		...data.products,
		...(data.leaders ?? []).map((l) => l.product).filter(Boolean),
	].filter((p) => turn.assistant_text.includes(`](${p.source.url})`));
	assert.ok(linked.length, "Cite tool-provided sources");
	assert.ok(
		progress.some((p) =>
			/Collecting candidates|Checking labels|Ranking \d/.test(p),
		),
		"Forward MCP progress into the chat stream",
	);
	console.log(
		JSON.stringify({
			message,
			chat: `${base}/#${id}`,
			coverage: data.coverage,
			outputBytes: end.output.length,
		}),
	);
	return { data, args, turn, linked };
}
const id = await newChat();
const broad = await send(
	id,
	"nyt tekis mieli proteiinipatukkaa, missä ois edullinen hinta, paljon protskuu ja vähä kaloreita",
);
assert.equal(broad.args.mode, "tradeoffs");
assert.ok(broad.data.coverage.distinctProducts > 8);
assert.ok(
	broad.data.coverage.searches.every(
		(s) => s.complete && s.returned === s.total,
	),
);
assert.equal(
	broad.args.constraints?.length ?? 0,
	0,
	"Do not invent thresholds",
);
assert.ok(
	broad.turn.assistant_text.includes("?"),
	"Ask a priority when the objectives conflict",
);
if (broad.data.coverage.unresolved)
	assert.ok(
		broad.turn.assistant_text.includes(String(broad.data.coverage.unresolved)),
		"Disclose missing evidence rather than substituting a generic store-coverage disclaimer",
	);
const precise = await send(
	id,
	"Enintään 2 euroa ja 200 kcal per patukka. Valitse eniten proteiinia, tasatilanteessa halvin.",
);
assert.equal(precise.args.mode, "ordered");
assert.deepEqual(precise.args.sort.slice(0, 2), [
	{ metric: "proteinPerItem", direction: "desc" },
	{ metric: "price", direction: "asc" },
]);
assert.ok(
	precise.args.constraints.some((c) => c.metric === "price" && c.max === 2),
);
assert.ok(
	precise.args.constraints.some(
		(c) => c.metric === "kcalPerItem" && c.max === 200,
	),
);
assert.equal(precise.data.coverage.complete, true);
assert.ok(
	precise.turn.assistant_text.includes(
		`](${precise.data.products[0].source.url})`,
	),
	"Recommend the computed winner",
);
const prisma = await send(id, "Entä Prismasta samoilla ehdoilla?");
assert.ok(prisma.data.products.every((p) => /prisma/i.test(p.store.name)));
assert.ok(
	prisma.args.constraints.some((c) => c.metric === "price" && c.max === 2),
);
assert.ok(
	prisma.args.constraints.some(
		(c) => c.metric === "kcalPerItem" && c.max === 200,
	),
);
const price = await send(
	await newChat(),
	"Listaa viisi halvinta proteiinipatukkaa. Vertaa vain pakkaushintaa ja pakkauskokoa, en tarvitse ravintoarvoja.",
);
assert.equal(price.args.sort[0].metric, "price");
assert.equal(price.data.coverage.labelsFetched, 0);
assert.equal(price.data.coverage.labelRequests, 0);
assert.ok(
	price.data.products.every((p) =>
		Object.keys(p.metrics).every((k) =>
			["price", "itemPrice", "pricePerKg", "sizeG"].includes(k),
		),
	),
);
console.log(
	"PASS exhaustive comparison, explicit winner, preserved follow-up constraints, compact fields and price-only zero-label path",
);
