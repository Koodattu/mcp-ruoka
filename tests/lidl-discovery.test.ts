import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { locateNearby } from "../src/geography.ts";
import { leafletLinks, parseLidlLeaflet, parseLidlStores } from "../src/lidl-discovery.ts";

const fixture = (name: string): unknown =>
	JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));

test("Lidl Seinäjoki directory retains exact coordinates and published offer region", () => {
	const stores = parseLidlStores(
		fixture("lidl-stores.json"),
		"https://www.lidl.fi/s/fi-FI/myymaelaet/seinaejoki/",
	);
	assert.equal(stores.length, 2);
	assert.equal(stores[0]?.id, "FI00173");
	assert.equal(stores[0]?.address, "Verkatehtaankatu 12");
	assert.deepEqual(stores[0]?.offerRegion, { id: 6, name: "Laukaa" });
	const nearby = locateNearby(stores, {
		coordinates: { latitude: 62.79481, longitude: 22.83085 },
		radiusKm: 1,
		chains: ["lidl"],
	});
	assert.equal(nearby.stores.length, 1);
	assert.equal(nearby.stores[0]?.distancePrecision, "store-coordinate");
	assert.throws(() => parseLidlStores([], "https://www.lidl.fi"), /missing/);
});

test("leaflet search separates publication and offer dates and never invents regional prices", () => {
	const leaflet = parseLidlLeaflet(fixture("lidl-leaflet.json"), "JOGURTTI", 6);
	assert.equal(leaflet.publicationStart, "2026-10-26");
	assert.equal(leaflet.offerStart, "2026-10-29");
	assert.equal(leaflet.matchesRequestedRegion, false);
	assert.deepEqual(leaflet.publishedRegions, ["0"]);
	assert.equal(leaflet.structuredProductCount, 0);
	assert.deepEqual(
		leaflet.pages.map((page) => page.number),
		[22],
	);
	assert.equal("price" in (leaflet.pages[0] ?? {}), false);
	assert.equal(parseLidlLeaflet(fixture("lidl-leaflet.json"), "nonexistent").pages.length, 0);
	assert.throws(() => parseLidlLeaflet({ success: false }), /true/);
});

test("leaflet links are deduplicated and restricted to the official Finnish viewer", () => {
	const url = "https://www.lidl.fi/l/fi/tarjouslehdet/koko-suomen-tarjoukset/ar/0";
	assert.deepEqual(
		leafletLinks(
			`<a href="${url}"></a><a href="${url}"></a> https://evil.example/l/fi/tarjouslehdet/x/ar/0`,
		),
		[url],
	);
});
