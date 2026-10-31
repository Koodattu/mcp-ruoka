import assert from "node:assert/strict";
import test from "node:test";
import { matchesCriteria } from "../src/matching.ts";
import { product } from "./helpers.ts";

test("vanilla yogurt matching recognizes Finnish, Swedish and English and excludes blends and quark", () => {
	assert.equal(
		matchesCriteria(product({ name: "Oddlygood® Soygurt 1 kg puolukka-vanilja" }), {
			productKind: "yogurt",
			vanillaOnly: true,
		}),
		false,
	);
	for (const name of [
		"Valiojogurtti vanilja 1 kg",
		"Yoghurt vanilj 200g",
		"Vanilla yogurt",
		"Oddlygood soygurt vanilja",
	])
		assert.equal(
			matchesCriteria(product({ name }), { productKind: "yogurt", vanillaOnly: true }),
			true,
			name,
		);
	for (const name of [
		"Vadelma-vanilja jogurtti",
		"Yoghurt päron vanilj",
		"Vanilla strawberry yogurt",
		"Vaniljarahkajogurtti",
		"Vaniljajogurttijäätelö",
		"Vaniljavanukas",
	])
		assert.equal(
			matchesCriteria(product({ name }), { productKind: "yogurt", vanillaOnly: true }),
			false,
			name,
		);
	assert.equal(
		matchesCriteria(product({ name: "Vadelma-vanilja jogurtti" }), { productKind: "yogurt" }),
		true,
	);
	assert.equal(
		matchesCriteria(product({ name: "Vaniljarahkajogurtti" }), {
			productKind: "quark",
			vanillaOnly: true,
		}),
		true,
	);
});
