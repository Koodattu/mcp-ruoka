import type { GroceryProduct } from "./grocery-types.ts";

export interface NutritionAssessment {
	per100g: {
		sugars: number | null;
		protein: number | null;
		fat: number | null;
		saturatedFat: number | null;
		carbohydrates: number | null;
		fibre: number | null;
		salt: number | null;
		energyKcal: number | null;
	};
	addedSugar: {
		status: "claimed_none" | "sweetening_ingredient_detected" | "unknown";
		gramsPer100g: null;
		evidence: string[];
	};
	sweeteners: { status: "detected" | "not_detected" | "unknown"; evidence: string[] };
	conflicts: { nutrients: Array<keyof NutritionAssessment["per100g"]>; addedSugar: boolean };
	warnings: string[];
}

function normalized(text: string) {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.replace(/[^a-z0-9]/g, "");
}
const names: Record<string, keyof NutritionAssessment["per100g"]> = {
	carbohydratessugar: "sugars",
	jostasokereita: "sugars",
	joistasokereita: "sugars",
	sugars: "sugars",
	sokereita: "sugars",
	protein: "protein",
	proteiinia: "protein",
	proteiini: "protein",
	fat: "fat",
	rasvaa: "fat",
	rasva: "fat",
	fatsaturated: "saturatedFat",
	jostatyydyttyneitarasvoja: "saturatedFat",
	jostatyydyttynyttarasvaa: "saturatedFat",
	carbohydrates: "carbohydrates",
	hiilihydraattia: "carbohydrates",
	hiilihydraatteja: "carbohydrates",
	fibre: "fibre",
	fiber: "fibre",
	ravintokuitu: "fibre",
	ravintokuitua: "fibre",
	salt: "salt",
	suola: "salt",
	suolaa: "salt",
	energykcal: "energyKcal",
	energia: "energyKcal",
};

export function assessNutrition(product: GroceryProduct): NutritionAssessment {
	const result: NutritionAssessment = {
		per100g: {
			sugars: null,
			protein: null,
			fat: null,
			saturatedFat: null,
			carbohydrates: null,
			fibre: null,
			salt: null,
			energyKcal: null,
		},
		addedSugar: { status: "unknown", gramsPer100g: null, evidence: [] },
		sweeteners: { status: product.ingredients ? "not_detected" : "unknown", evidence: [] },
		conflicts: { nutrients: [], addedSugar: false },
		warnings: [],
	};
	const conflicts = new Set<string>();
	for (const table of product.nutrition) {
		const basis = table.basis?.trim().match(/^(\d+(?:[.,]\d+)?)\s*g$/i);
		if (!basis?.[1] || Number(basis[1].replace(",", ".")) <= 0) continue;
		if (table.preparation && /valmistettuna|prepared|tillagad/i.test(table.preparation)) {
			result.warnings.push("Prepared-product nutrition was not used to rank an as-sold product.");
			continue;
		}
		const scale = 100 / Number(basis[1].replace(",", "."));
		for (const row of table.values) {
			const key = names[normalized(row.name)];
			if (!key || conflicts.has(key)) continue;
			const match =
				key === "energyKcal"
					? row.value.match(/(?:^|\/)\s*(\d+(?:[.,]\d+)?)\s*kcal\s*$/i)
					: row.value.trim().match(/^(\d+(?:[.,]\d+)?)\s*g$/i);
			if (!match?.[1]) continue; // Bounds such as <0.5 g are not exact values.
			const value = Math.round(Number(match[1].replace(",", ".")) * scale * 10000) / 10000;
			const previous = result.per100g[key];
			if (previous != null && previous !== value) {
				result.per100g[key] = null;
				conflicts.add(key);
				result.conflicts.nutrients.push(key);
				result.warnings.push(`Conflicting ${key} values in nutrition tables; left unknown.`);
			} else result.per100g[key] = value;
		}
	}
	const claimsText = [product.name, product.description ?? "", ...(product.claims ?? [])].join(
		"\n",
	);
	const claim = claimsText.match(
		/ei lis[aä]tty[aä] sokeria|ei lis[aä]ttyj[aä] sokereita|ilman lis[aä]tty[aä] sokeria|utan tillsatt socker|no added sugar/iu,
	);
	const ingredients = product.ingredients ?? "";
	const additions =
		ingredients.match(
			/\b(?:sokeri(?:a|t)?|ruokosokeri|sakkaroosi|glukoosi(?:siirappi)?|fruktoosi|dekstroosi|inverttisokeri|siirappi|hunaja|[a-zäöå-]*(?:mehutiiviste|mehutiivistett[aä])|sugar|sucrose|syrup|honey|socker)\b/giu,
		) ?? [];
	const sweeteners =
		ingredients.match(
			/\b(?:makeutusaine[a-zäö]*|sötningsmedel|aspartaami|asesulfaami\s*k|sukraloosi|stevioliglykosidit|sakariini|syklamaatti|erytritoli|ksylitoli|maltitoli|sorbitoli|E\s*(?:950|951|952|954|955|960[a-z]?|968|967|965|420))\b/giu,
		) ?? [];
	if (claim && additions.length === 0) {
		result.addedSugar.status = "claimed_none";
		result.addedSugar.evidence = [claim[0]];
	} else if (additions.length) {
		result.addedSugar.status = "sweetening_ingredient_detected";
		result.addedSugar.evidence = [...new Set(additions)];
		if (claim) {
			result.addedSugar.status = "unknown";
			result.conflicts.addedSugar = true;
			result.addedSugar.evidence.push(claim[0]);
			result.warnings.push(
				"No-added-sugar claim conflicts with ingredient detection; review the original label.",
			);
		}
	}
	if (sweeteners.length)
		result.sweeteners = { status: "detected", evidence: [...new Set(sweeteners)] };
	if (!product.ingredients)
		result.warnings.push(
			"Ingredients are missing; absence of added sugar or sweeteners cannot be established.",
		);
	result.warnings.push(
		"Total sugars include naturally occurring sugars. Exact added-sugar grams are not inferred from total sugar or ingredient order.",
	);
	return result;
}

export function mergeNutrition(assessments: NutritionAssessment[]): NutritionAssessment {
	const first = assessments[0];
	if (!first) throw new Error("No nutrition assessments to merge");
	const result = structuredClone(first);
	result.warnings = [...new Set(assessments.flatMap((a) => a.warnings))];
	result.conflicts.nutrients = [...new Set(assessments.flatMap((a) => a.conflicts.nutrients))];
	for (const field of new Set(Object.values(names))) {
		if (result.conflicts.nutrients.includes(field)) {
			result.per100g[field] = null;
			continue;
		}
		const values = assessments.flatMap((a) => (a.per100g[field] == null ? [] : [a.per100g[field]]));
		const minimum = values.length ? Math.min(...values) : null;
		const maximum = values.length ? Math.max(...values) : null;
		result.per100g[field] = minimum;
		if (minimum != null && maximum != null && maximum - minimum > 0.01) {
			result.per100g[field] = null;
			result.conflicts.nutrients.push(field);
			result.warnings.push(`Retailer labels disagree on ${field}; left unknown.`);
		}
	}
	const claimed = assessments.some((a) => a.addedSugar.status === "claimed_none");
	const detected = assessments.some(
		(a) => a.addedSugar.status === "sweetening_ingredient_detected",
	);
	result.conflicts.addedSugar =
		(claimed && detected) || assessments.some((a) => a.conflicts.addedSugar);
	result.addedSugar = {
		status: result.conflicts.addedSugar
			? "unknown"
			: claimed
				? "claimed_none"
				: detected
					? "sweetening_ingredient_detected"
					: "unknown",
		gramsPer100g: null,
		evidence: [...new Set(assessments.flatMap((a) => a.addedSugar.evidence))],
	};
	if (claimed && detected)
		result.warnings.push("Retailer labels disagree on added-sugar evidence; left unknown.");
	result.sweeteners = {
		status: assessments.some((a) => a.sweeteners.status === "detected")
			? "detected"
			: assessments.some((a) => a.sweeteners.status === "not_detected")
				? "not_detected"
				: "unknown",
		evidence: [...new Set(assessments.flatMap((a) => a.sweeteners.evidence))],
	};
	return result;
}
