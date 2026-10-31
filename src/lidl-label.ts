import type { GroceryProduct } from "./grocery-types.ts";

// Only the observed bilingual bakery-label format is normalized. The original label
// remains available, and unsupported formats must not become zero-filled nutrition.
export function parseLidlLabel(text: string): GroceryProduct["nutrition"] {
	const basis = text.match(/Ravintoarvo[^:]*?100\s*(g|ml)\s*:/iu);
	if (!basis || basis.index == null) return [];
	const body = text.slice(basis.index + basis[0].length);
	const patterns: Array<[string, RegExp]> = [
		[
			"energyKcal",
			/Energiaa?\s*\/\s*Energi\s+\d+(?:[,.]\d+)?\s*kJ\s*\/\s*(\d+(?:[,.]\d+)?)\s*kcal/iu,
		],
		["fat", /Rasvaa?\s*\/\s*Fett\s+(\d+(?:[,.]\d+)?)\s*g/iu],
		[
			"fatSaturated",
			/tyydyttynytt[aä] rasvaa\s*\/\s*varav m[aä]ttat fett\s+(\d+(?:[,.]\d+)?)\s*g/iu,
		],
		["carbohydrates", /Hiilihydraatteja\s*\/\s*Kolhydrat\s+(\d+(?:[,.]\d+)?)\s*g/iu],
		["carbohydratesSugar", /sokereita\s*\/\s*varav sockerarter\s+(\d+(?:[,.]\d+)?)\s*g/iu],
		["fibre", /Ravintokuitua\s*\/\s*Fiber\s+(\d+(?:[,.]\d+)?)\s*g/iu],
		["protein", /Proteiinia\s*\/\s*Protein\s+(\d+(?:[,.]\d+)?)\s*g/iu],
		["salt", /Suolaa\s*\/\s*Salt\s+(\d+(?:[,.]\d+)?)\s*g/iu],
	];
	const values = patterns.flatMap(([name, pattern]) => {
		const match = body.match(pattern);
		return match?.[1]
			? [{ name, value: `${match[1]} ${name === "energyKcal" ? "kcal" : "g"}` }]
			: [];
	});
	return values.length ? [{ basis: `100 ${basis[1]}`, preparation: null, values }] : [];
}
