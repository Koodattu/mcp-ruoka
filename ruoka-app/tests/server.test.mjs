import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { openStore } from "../db.mjs";
import { createApp } from "../server.mjs";

async function setup(t, agent) {
	const store = openStore(":memory:");
	let closed = 0;
	const mcp = {
		close: async () => {
			closed++;
		},
	};
	const app = createApp({
		store,
		mcp,
		agent,
		settings: {
			apiKey: "test-secret",
			defaultModel: "gpt-6-luna",
			models: ["gpt-6-luna", "gpt-6.1-terra"],
		},
	});
	app.server.listen(0, "127.0.0.1");
	await once(app.server, "listening");
	const base = `http://127.0.0.1:${app.server.address().port}`;
	t.after(async () => {
		app.abort();
		await new Promise((resolve) => app.server.close(resolve));
		store.close();
	});
	const post = (path, body, extra = {}) =>
		fetch(base + path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			...extra,
		});
	const chat = await (await post("/api/chats", { model: "gpt-6-luna" })).json();
	return { base, post, chat, store, closed: () => closed };
}

test("city setting validates aliases, persists, and is passed to the agent without store IDs", async (t) => {
	let selected;
	const { base, post, chat } = await setup(t, async (request) => {
		selected = request.city;
		return { text: "Hello", input: [] };
	});
	assert.equal(
		(await post("/api/settings/city", { city: "Unknown place 123" })).status,
		400,
	);
	assert.equal(
		(await post("/api/settings/city", { city: "Helsingfors" })).status,
		200,
	);
	const config = await (await fetch(`${base}/api/config`)).json();
	assert.equal(config.city, "Helsinki");
	const options = await (await fetch(`${base}/api/cities`)).json();
	assert.ok(options.includes("Seinäjoki"));
	await (
		await post(`/api/chats/${chat.id}/messages`, {
			model: "gpt-6-luna",
			message: "Etsi jogurtti",
		})
	).text();
	assert.equal(selected, "Helsinki");
});

test("HTTP streams a reply, persists it, replays context and accepts a model change", async (t) => {
	const seen = [];
	const { base, post, chat } = await setup(t, async (request) => {
		seen.push(request);
		request.emit({ type: "delta", text: "Hello" });
		return {
			text: "Hello",
			input: [
				{ role: "user", content: request.message },
				{ role: "assistant", content: "Hello" },
			],
		};
	});
	const response = await post(`/api/chats/${chat.id}/messages`, {
		model: "gpt-6-luna",
		message: "Yogurt",
	});
	assert.equal(
		response.headers.get("content-type"),
		"text/event-stream; charset=utf-8",
	);
	assert.match(await response.text(), /"type":"done"/);
	await (
		await post(`/api/chats/${chat.id}/messages`, {
			model: "gpt-6.1-terra",
			message: "Cheaper?",
		})
	).text();
	assert.equal(seen[1].history[0].content, "Yogurt");
	assert.equal(seen[1].model, "gpt-6.1-terra");
	const saved = await (await fetch(`${base}/api/chats/${chat.id}`)).json();
	assert.equal(saved.turns.length, 2);
	assert.equal(saved.turns[0].assistant_text, "Hello");
	assert.ok(
		saved.turns.every((turn) =>
			turn.trace.some(
				(event) => event.type === "timing" && event.durationMs >= 0,
			),
		),
	);
	const config = await (await fetch(`${base}/api/config`)).text();
	assert.equal(config.includes("test-secret"), false);
	assert.equal((await fetch(`${base}/.env`)).status, 404);
});

test("rejects cross-origin requests, invalid models, and empty messages before execution", async (t) => {
	const { post, chat } = await setup(t, () =>
		assert.fail("Invalid request must not reach the model"),
	);
	assert.equal(
		(
			await post(
				"/api/chats",
				{ model: "gpt-6-luna" },
				{
					headers: {
						Origin: "https://example.com",
						"Content-Type": "application/json",
					},
				},
			)
		).status,
		403,
	);
	assert.equal((await post("/api/chats", { model: "unknown" })).status, 400);
	assert.equal(
		(
			await post(`/api/chats/${chat.id}/messages`, {
				model: "gpt-6-luna",
				message: " ",
			})
		).status,
		400,
	);
	assert.equal(
		(
			await post(`/api/chats/${chat.id}/messages`, {
				model: "unknown",
				message: "Hi",
			})
		).status,
		400,
	);
	assert.equal((await post("/api/chats", null)).status, 400);
});

test("serializes replies and saves cancellation when the browser disconnects", async (t) => {
	const { post, chat, store, closed } = await setup(t, async ({ signal }) => {
		await new Promise((_resolve, reject) =>
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			}),
		);
	});
	const controller = new AbortController();
	const first = await post(
		`/api/chats/${chat.id}/messages`,
		{ model: "gpt-6-luna", message: "Wait" },
		{ signal: controller.signal },
	);
	assert.equal(first.status, 200);
	assert.equal(
		(
			await post(`/api/chats/${chat.id}/messages`, {
				model: "gpt-6-luna",
				message: "Duplicate",
			})
		).status,
		409,
	);
	controller.abort();
	await assert.rejects(first.text());
	for (let i = 0; i < 30 && !closed(); i++)
		await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(store.get(chat.id).turns[0].status, "cancelled");
	assert.equal(closed(), 1);
});
