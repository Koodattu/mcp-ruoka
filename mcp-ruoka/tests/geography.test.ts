import assert from "node:assert/strict";
import test from "node:test";
import {
	distanceKm,
	locateNearby,
	matchesCity,
	NearbyInputSchema,
	postalArea,
} from "../src/geography.ts";

test("copied postal data resolves Hyllykallio to Seinäjoki and locates Prisma nearby", () => {
	const home = postalArea("60100");
	const hyllykallio = postalArea("60510");
	assert.equal(hyllykallio?.municipality, "Seinäjoki");
	assert.ok(home?.point && hyllykallio?.point);
	assert.ok(home.point.latitude > 62.7 && home.point.latitude < 62.9);
	assert.ok(home.point.longitude > 22.7 && home.point.longitude < 23);
	const prisma = {
		chain: "s-kaupat" as const,
		id: "516242633",
		name: "Prisma Seinäjoki",
		location: "Hyllykallio",
		postalCode: "60510",
	};
	assert.equal(matchesCity(prisma, "Seinäjoki"), true);
	const result = locateNearby([prisma], { postalCode: "60100", radiusKm: 10 });
	assert.equal(result.stores[0]?.id, prisma.id);
	assert.ok((result.stores[0]?.distanceKm ?? 99) > 2 && (result.stores[0]?.distanceKm ?? 99) < 5);
	assert.equal(result.stores[0]?.distancePrecision, "postal-area-reference");
});

test("city membership without postcodes preserves locality aliases and exact municipality matching", () => {
	const store = { id: "N192", chain: "k-ruoka" as const, name: "Store", location: "Hyllykallio" };
	assert.equal(matchesCity(store, "Seinäjoki"), true);
	assert.equal(matchesCity(store, " SEINAJOKI "), true);
	assert.equal(matchesCity(store, "Hyllykallio"), true);
	assert.equal(matchesCity(store, "Helsinki"), false);
	assert.equal(matchesCity(store, "joki"), false);
	assert.equal(matchesCity({ ...store, location: "Helsinki" }, "Helsingfors"), true);
	assert.equal(matchesCity({ ...store, location: "Not a locality" }, "Seinäjoki"), false);
});

test("nearby reporting preserves unknown location counts and limits", () => {
	const origin = { latitude: 62.8, longitude: 22.8 };
	const stores = [1, 2, 3].map((n) => ({
		id: String(n),
		chain: "k-ruoka" as const,
		name: "Store",
		location: "Seinäjoki",
		coordinates: origin,
	}));
	const result = locateNearby(
		[...stores, { id: "unknown", chain: "s-kaupat", name: "Unknown", location: "Unknown" }],
		{ coordinates: origin, limit: 2 },
	);
	assert.equal(result.unlocatedStoreCount, 1);
	assert.equal(result.totalWithinRadius, 3);
	assert.equal(result.truncated, true);
	assert.equal(result.stores.length, 2);
	assert.equal(distanceKm(origin, origin), 0);
	assert.ok(
		Math.abs(distanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }) - 111.195) <
			0.01,
	);
	assert.throws(() => NearbyInputSchema.parse({ postalCode: "60100", coordinates: origin }));
	assert.throws(() => locateNearby([], { postalCode: "00000" }), /No location point/);
});
