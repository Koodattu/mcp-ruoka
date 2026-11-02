import assert from "node:assert/strict";
import { parseSse } from "../agent.mjs";
import { config } from "../config.mjs";

// Opt-in real-model/retailer regressions; creates saved chats and spends API credit.
const base = `http://127.0.0.1:${config.port}`;
const settings = await (await fetch(`${base}/api/config`)).json();
assert.ok(settings.city, "Select a city before running evals.");
async function post(path, body) {
	const response = await fetch(base + path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok)
		throw new Error(`HTTP ${response.status}: ${await response.text()}`);
	return response;
}
async function conversation() {
	return (
		await (await post("/api/chats", { model: config.defaultModel })).json()
	).id;
}
const evidence = new Map(),
	candidates = new Set();
const key = (p) =>
	`${p.chain ?? p.store?.chain}:${p.storeId ?? p.store?.id}:${p.id}`;
async function send(id, message) {
	const started = Date.now();
	const response = await post(`/api/chats/${id}/messages`, {
		model: config.defaultModel,
		message,
	});
	for await (const event of parseSse(response.body))
		if (event.type === "error") throw new Error(event.error);
	const chat = await (await fetch(`${base}/api/chats/${id}`)).json();
	const turn = chat.turns.at(-1);
	assert.equal(turn.status, "complete");
	let inspected = 0,
		discovered = 0;
	for (const event of turn.trace) {
		if (event.type === "tool_start" && event.name === "inspect_groceries") {
			const refs = JSON.parse(event.arguments).products;
			assert.ok(refs.length <= 8);
			for (const ref of refs)
				assert.ok(
					candidates.has(key(ref)),
					`Inspect an observed candidate: ${key(ref)}`,
				);
		}
		if (event.type !== "tool_end") continue;
		const result = JSON.parse(event.output);
		if (result.isError) continue;
		if (event.name === "discover_groceries") {
			assert.equal(result.data.city, settings.city);
			discovered += result.data.products.length;
			for (const p of result.data.products) candidates.add(key(p));
		}
		if (event.name === "inspect_groceries") {
			inspected += result.data.products.length;
			for (const p of result.data.products) evidence.set(p.source.url, p);
		}
	}
	const recommended = [...evidence.values()].filter((p) =>
		turn.assistant_text.includes(`](${p.source.url})`),
	);
	console.log(
		JSON.stringify({
			message,
			discovered,
			inspected,
			seconds: Math.round((Date.now() - started) / 1000),
			chat: `${base}/#${id}`,
		}),
	);
	return { turn, recommended, discovered, inspected };
}
function checked(result) {
	assert.ok(result.recommended.length, "Answer must cite inspected products.");
	assert.ok(
		result.inspected > 0,
		"Recommendations need fresh/cached inspection this turn.",
	);
	assert.ok(
		!result.turn.assistant_text.includes("Hyllysaatavuutta en voi varmistaa"),
	);
}
if (process.argv.includes("--chicken")) {
	const id = await conversation();
	const first = await send(id, "tarvitsen paras kanan rintafilee maustamaton");
	checked(first);
	assert.ok(first.discovered > 0);
	const pirkka = await send(id, "mitenkäs pirkka vastaavat?");
	checked(pirkka);
	assert.ok(
		pirkka.recommended.some(
			(p) =>
				/pirkka/i.test(p.name) &&
				/fileepihvi|ohutleike|rintafilee|minuuttifilee/i.test(p.name),
		),
		"Find a relevant Pirkka cut without the user having to challenge the answer.",
	);
	for (const p of pirkka.recommended)
		assert.ok(
			!/munia|jauheliha|marinoitu|hunaja|miedosti suolattu/i.test(p.name),
			"Preserve plain breast requirement.",
		);
	console.log("PASS chicken discovery and Pirkka synonym follow-up");
} else {
	const id = await conversation();
	const first = await send(
		id,
		"Etsi laktoosittomia proteiinijogurtteja. Vertaa proteiinia ja sokeria per 100 g sekä hintaa.",
	);
	const yogurt = (result) => {
		checked(result);
		for (const p of result.recommended) {
			assert.ok(p.lactoseFreeEvidence, "Lactose-free evidence required.");
			assert.match(p.name, /jogurt|yogurt|yoghurt/i);
			assert.ok(!/rahka|skyr|juoma|vanukas/i.test(p.name));
			assert.ok(
				p.nutritionPer100g?.protein != null || p.nutritionTables?.length,
				"Preserve original nutrition if preparation needs explanation.",
			);
		}
	};
	yogurt(first);
	assert.ok(first.discovered > 0);
	const prisma = await send(id, "Entä Prismasta?");
	yogurt(prisma);
	assert.ok(prisma.recommended.every((p) => /prisma/i.test(p.store.name)));
	const cheaper = await send(id, "Jotain halvempaa.");
	yogurt(cheaper);
	assert.ok(cheaper.recommended.every((p) => /prisma/i.test(p.store.name)));
	const before = Math.min(
		...prisma.recommended
			.filter((p) => p.unitPrice?.unit === "kg")
			.map((p) => p.unitPrice.amount),
	);
	assert.ok(
		cheaper.recommended.some(
			(p) => p.unitPrice?.unit === "kg" && p.unitPrice.amount < before,
		),
		"Find a genuinely cheaper checked option.",
	);
	const vague = await send(await conversation(), "Paras jogurtti?");
	assert.ok(vague.turn.assistant_text.includes("?"));
	assert.equal(vague.discovered, 0);
	console.log(
		"PASS yogurt constraints, store/price follow-ups and ambiguous-best clarification",
	);
}
