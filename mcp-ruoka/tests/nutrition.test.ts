import assert from "node:assert/strict";
import test from "node:test";
import { parseLidlLabel } from "../src/lidl-label.ts";
import { assessNutrition, mergeNutrition } from "../src/nutrition.ts";
import { product } from "./helpers.ts";

test("sugar normalization handles comma decimals and serving mass without confusing lactose", () => {
	const p = product({
		nutrition: [
			{
				basis: "200 g",
				preparation: null,
				values: [
					{ name: "- josta sokereita", value: "9,2 g" },
					{ name: "Laktoosia", value: "0 g" },
				],
			},
		],
	});
	assert.equal(assessNutrition(p).per100g.sugars, 4.6);
	assert.equal(assessNutrition(p).addedSugar.gramsPer100g, null);
	for (const value of ["<0,5 g", "unknown"])
		assert.equal(
			assessNutrition(
				product({
					nutrition: [
						{ basis: "100 g", preparation: null, values: [{ name: "carbohydratesSugar", value }] },
					],
				}),
			).per100g.sugars,
			null,
		);
	assert.equal(
		assessNutrition(
			product({
				nutrition: [
					{
						basis: "100 ml",
						preparation: null,
						values: [{ name: "carbohydratesSugar", value: "1 g" }],
					},
				],
			}),
		).per100g.sugars,
		null,
	);
});

test("prepared nutrition does not silently rank an as-sold product", () => {
	const n = assessNutrition(
		product({
			nutrition: [
				{
					basis: "100 g",
					preparation: "Valmistettuna",
					values: [{ name: "carbohydratesSugar", value: "1 g" }],
				},
			],
		}),
	);
	assert.equal(n.per100g.sugars, null);
	assert.ok(n.warnings.some((w) => w.includes("Prepared")));
});

test("no-added-sugar claims, juice concentrate and sweeteners are separate evidence", () => {
	const a = assessNutrition(
		product({
			description: "Ei lisättyä sokeria.",
			ingredients: "MAITO, vanilja, makeutusaine (sukraloosi)",
		}),
	);
	assert.equal(a.addedSugar.status, "claimed_none");
	assert.equal(a.sweeteners.status, "detected");
	const b = assessNutrition(product({ ingredients: "MAITO, hedelmämehutiiviste, vanilja" }));
	assert.equal(b.addedSugar.status, "sweetening_ingredient_detected");
	assert.equal(b.addedSugar.gramsPer100g, null);
	assert.equal(
		assessNutrition(product({ ingredients: "MAITO, vanilja" })).addedSugar.status,
		"unknown",
	);
	assert.equal(assessNutrition(product()).sweeteners.status, "unknown");
});

test("cross-retailer nutrition conflicts are order-independent and remain unknown", () => {
	const a = assessNutrition(
		product({
			description: "Ei lisättyä sokeria",
			ingredients: "MAITO",
			nutrition: [
				{
					basis: "100 g",
					preparation: null,
					values: [{ name: "carbohydratesSugar", value: "4 g" }],
				},
			],
		}),
	);
	const b = assessNutrition(
		product({
			ingredients: "MAITO, sokeri",
			nutrition: [
				{
					basis: "100 g",
					preparation: null,
					values: [{ name: "carbohydratesSugar", value: "9 g" }],
				},
			],
		}),
	);
	for (const values of [
		[a, b],
		[b, a],
	]) {
		const merged = mergeNutrition(values);
		assert.equal(merged.per100g.sugars, null);
		assert.equal(merged.addedSugar.status, "unknown");
	}
	const conflict = assessNutrition(
		product({ description: "Ei lisättyä sokeria", ingredients: "MAITO, sokeri" }),
	);
	assert.equal(mergeNutrition([a, conflict]).addedSugar.status, "unknown");
});

test("observed Lidl bilingual bakery label yields sugar and energy, unsupported labels stay empty", () => {
	const nutrition = parseLidlLabel(
		"Ravintoarvo/Näringsvärde Ø/100 g: Energiaa/Energi 1605 kJ/384 kcal; Rasvaa/Fett 21,8 g, josta tyydyttynyttä rasvaa/varav mättat fett 10,8 g; Hiilihydraatteja/Kolhydrat 36,8 g, joista sokereita/varav sockerarter 6,0 g; Ravintokuitua/Fiber 2,0 g; Proteiinia/Protein 9,2 g; Suolaa/Salt 1,04 g.",
	);
	const n = assessNutrition(product({ nutrition }));
	assert.equal(n.per100g.sugars, 6);
	assert.equal(n.per100g.energyKcal, 384);
	assert.equal(n.per100g.saturatedFat, 10.8);
	assert.deepEqual(parseLidlLabel("No nutritional information"), []);
});
