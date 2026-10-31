import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { RetailerHttpError, requestJson, retryDelay } from "../src/browser/request.ts";

test("retry delays honor seconds and HTTP dates without accepting malformed values", () => {
	assert.equal(retryDelay("12", 0), 12_000);
	assert.equal(retryDelay("Thu, 01 Jan 1970 00:01:00 GMT", 0, 30_000), 30_000);
	assert.equal(retryDelay("invalid", 1), 2000);
});

test("transport retries a transient response, rejects HTTP errors, and serializes a retailer", async (t) => {
	let retries = 0;
	let requests = 0;
	let active = 0;
	let maximum = 0;
	const server = createServer((req, res) => {
		requests++;
		active++;
		maximum = Math.max(maximum, active);
		setTimeout(() => {
			if (req.url === "/retry" && retries++ === 0) {
				res.writeHead(503);
				res.end("temporary");
			} else if (req.url === "/missing") {
				res.writeHead(404);
				res.end("missing");
			} else if (req.url === "/cooldown") {
				res.writeHead(429, { "retry-after": "120" });
				res.end("wait");
			} else if (req.url === "/html") {
				res.end("<html>challenge</html>");
			} else {
				res.setHeader("content-type", "application/json");
				res.end('{"ok":true}');
			}
			active--;
		}, 10);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	try {
		assert.deepEqual(await requestJson(new URL("/retry", origin), origin), { ok: true });
		assert.equal(retries, 2);
		await Promise.all([
			requestJson(new URL("/a", origin), origin),
			requestJson(new URL("/b", origin), origin),
		]);
		assert.equal(maximum, 1);
		await assert.rejects(
			requestJson(new URL("/missing", origin), origin),
			(e) => e instanceof RetailerHttpError && e.status === 404,
		);
		await assert.rejects(requestJson(new URL("/html", origin), origin), /non-JSON/);
		await assert.rejects(
			requestJson(new URL("/cooldown", origin), origin),
			(e) => e instanceof RetailerHttpError && e.status === 429,
		);
		const before = requests;
		await assert.rejects(
			requestJson(new URL("/a", origin), origin),
			(e) => e instanceof RetailerHttpError && e.status === 429,
		);
		assert.equal(requests, before, "queued calls must respect the retailer cooldown");
		const afterCooldown = Date.now() + 121_000;
		t.mock.method(Date, "now", () => afterCooldown);
		assert.deepEqual(await requestJson(new URL("/a", origin), origin), { ok: true });
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
