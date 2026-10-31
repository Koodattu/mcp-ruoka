import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPriceValidity } from "../src/grocery-types.ts";
import { ObservationStore } from "../src/observations.ts";
import { GroceryProductSchema } from "../src/product-schema.ts";
import { product } from "./helpers.ts";

test("an invalid database fails without replacing or deleting the original file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ruoka-invalid-db-"));
	const file = join(dir, "observations.sqlite");
	try {
		await writeFile(file, "not a SQLite database");
		await assert.rejects(ObservationStore.open(file));
		assert.equal(await readFile(file, "utf8"), "not a SQLite database");
	} finally {
		for (const name of await readdir(dir)) await rm(join(dir, name));
		await rmdir(dir);
	}
});

test("SQLite observations survive reopening, isolate stores, deduplicate observations and preserve historical offers", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ruoka-observations-"));
	const file = join(dir, "observations.sqlite");
	let db = await ObservationStore.open(file);
	try {
		const p = product();
		p.source.fetchedAt = "2026-10-31T12:00:00.123Z";
		p.pricing.validUntil = "2026-10-31T13:00:00Z";
		db.record([p], "detail");
		db.record([p], "detail");
		db.record([{ ...p, storeId: "2", price: 3 }], "detail");
		db.writeCache("detail:1", p, Date.now() + 60_000);
		db.close();
		db = await ObservationStore.open(file);
		assert.equal(
			db.readCache("detail:1", GroceryProductSchema)?.source.fetchedAt,
			p.source.fetchedAt,
		);
		assert.equal(db.readCache("detail:1", GroceryProductSchema, Date.now() + 61_000), null);
		const h = db.history({
			chain: "s-kaupat",
			id: p.id,
			storeId: "1",
			since: "2026-10-31T12:00:00Z",
		});
		assert.equal(h.observations.length, 1);
		assert.equal(h.observations[0]?.price, 2);
		applyPriceValidity(p, Date.parse("2026-11-01"));
		assert.equal(p.price, null);
		assert.equal(
			db.history({ chain: "s-kaupat", id: p.id, storeId: "1" }).observations[0]?.price,
			2,
		);
		assert.equal(db.history({ chain: "s-kaupat", id: p.id, limit: 1 }).truncated, true);
		assert.equal(db.history({ chain: "k-ruoka", id: p.id }).observations.length, 0);
	} finally {
		db.close();
		for (const name of await readdir(dir)) await rm(join(dir, name));
		await rmdir(dir);
	}
});

test("invalid cache payloads become misses; invalid product batches do not leave partial history", async () => {
	const db = await ObservationStore.open(":memory:");
	try {
		db.writeCache("bad", {}, Date.now() + 60_000);
		assert.equal(db.readCache("bad", GroceryProductSchema), null);
		const p = product();
		assert.throws(() => db.record([p, { ...p, price: Number.NaN }], "detail"));
		assert.equal(db.history({ chain: "s-kaupat", id: p.id }).observations.length, 0);
	} finally {
		db.close();
	}
});
