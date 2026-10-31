import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	ManufacturerSourceSchema,
	manufacturerCandidates,
	parseArlaLabel,
	parseValioLabel,
} from "../src/manufacturer.ts";
import { assessNutrition } from "../src/nutrition.ts";

// Public label facts for Arla Aamu+ AB vanilla 175 g, observed 2026-10-31.
const reference = {
	gtin: "6413300024074",
	url: "https://www.arla.fi/tuotteet/aamuplus/ab-vaniljajogurtti-laktoositon-175g-686853/",
};
const text =
	"Ravintosisältö per 100 g energiaa 300 kJ / 71 kcal rasvaa 2 g josta tyydyttyneitä rasvoja 1.3 g hiilihydraatti 8.8 g josta sokereita 8.2 g proteiinia 3.9 g suola 0.11 g Ainesosat Pastöroitu maito, hedelmämehutiiviste, maitoproteiini, tärkkelys (tapioka, peruna), luontaiset aromit, vaniljauute, D-vitamiini, jogurttihapate. Säilytys Säilytetään alle + 8 C. Pakkauskoko 175 g EAN-koodi 6413300024074";

test("manufacturer enrichment requires the exact EAN and retains original nutrition basis", () => {
	const label = parseArlaLabel(text, reference);
	const nutrition = assessNutrition({ name: "", description: null, claims: [], ...label });
	assert.equal(nutrition.per100g.sugars, 8.2);
	assert.equal(nutrition.per100g.saturatedFat, 1.3);
	assert.equal(nutrition.addedSugar.status, "sweetening_ingredient_detected");
	assert.equal(label.source.url, reference.url);
	assert.throws(() => parseArlaLabel(text, { ...reference, gtin: "6413300000000" }), /EAN/);
	assert.throws(() => parseArlaLabel(text.replace("8.2 g", "<0.5 g"), reference), /missing/);
	assert.throws(() =>
		ManufacturerSourceSchema.parse({ ...reference, url: "https://example.com/product" }),
	);
	assert.throws(() =>
		ManufacturerSourceSchema.parse({ ...reference, url: "http://www.arla.fi/tuotteet/test" }),
	);
});

test("Valio package labels require matching EAN and preserve per-100g facts", () => {
	const html = readFileSync(new URL("fixtures/valio-vanilla-label.html", import.meta.url), "utf8");
	const reference = {
		gtin: "6408430002665",
		url: "https://www.valio.fi/tuotteet/valiojogurtti-vanilja-laktoositon/200-g-pikari/",
	};
	const label = parseValioLabel(html, reference);
	const nutrition = assessNutrition({ name: "", description: null, claims: [], ...label });
	assert.equal(nutrition.per100g.sugars, 9.2);
	assert.equal(nutrition.per100g.energyKcal, 71);
	assert.equal(nutrition.addedSugar.status, "sweetening_ingredient_detected");
	assert.throws(() => parseValioLabel(html, { ...reference, gtin: "6408430020539" }), /EAN/);
	assert.throws(() => parseValioLabel(html.replace("9,2 g", "&lt;0,5 g"), reference), /missing/);
});

test("manufacturer discovery ranks relevant official product pages but never treats names as EAN proof", () => {
	const base = "https://www.valio.fi/tuotteet/";
	const urls = [
		`${base}valiojogurtti-mango-vanilja-laktoositon/`,
		`${base}valiojogurtti-vanilja-laktoositon/`,
		"https://example.com/tuotteet/valiojogurtti-vanilja/",
		"https://www.valio.fi/reseptit/vanilja/",
		`${base}maito/`,
	];
	assert.deepEqual(
		manufacturerCandidates(
			urls.map((url) => `<loc>${url}</loc>`).join(""),
			"Valiojogurtti vanilja laktoositon 200 g",
			"valio",
		),
		[urls[1], urls[0]],
	);
});
