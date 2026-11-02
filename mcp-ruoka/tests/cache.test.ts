import assert from "node:assert/strict";
import test from "node:test";
import { memoizedLookup } from "../src/cache.ts";

test("cache deduplicates concurrent requests and protects stored values from mutation", async () => {
	const lookup = memoizedLookup<{ price: number }>(1000);
	let calls = 0;
	const load = async () => {
		calls++;
		return { price: 1 };
	};
	const [a, b] = await Promise.all([lookup("store-a:ean", load), lookup("store-a:ean", load)]);
	assert.equal(calls, 1);
	a.price = 99;
	assert.equal(b.price, 1);
	assert.equal((await lookup("store-a:ean", load)).price, 1);
	await lookup("store-b:ean", load);
	assert.equal(calls, 2);
});

test("failed lookups are retried and do not poison the cache", async () => {
	const lookup = memoizedLookup<number>(1000);
	await assert.rejects(
		lookup("x", async () => {
			throw new Error("temporary");
		}),
	);
	assert.equal(await lookup("x", async () => 42), 42);
});

test("expired values and capacity-evicted values are reloaded", async (t) => {
	let now = 100;
	t.mock.method(Date, "now", () => now);
	const lookup = memoizedLookup<number>(1000, 1);
	assert.equal(await lookup("a", async () => 1), 1);
	now += 1001;
	assert.equal(await lookup("a", async () => 2), 2);
	await lookup("b", async () => 3);
	assert.equal(await lookup("a", async () => 4), 4);
});
