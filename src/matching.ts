import type { GroceryProduct } from "./grocery-types.ts";

export const normalizeText = (text: string) =>
	text
		.toLocaleLowerCase("fi")
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "");
export type ProductKind = "yogurt" | "quark" | "pudding";
export function matchesCriteria(
	product: GroceryProduct,
	criteria: { productKind?: ProductKind; vanillaOnly?: boolean },
) {
	const name = normalizeText(product.name);
	if (
		criteria.productKind === "yogurt" &&
		(!/jogurt|yogurt|yoghurt|soygurt|kauragurt/.test(name) ||
			/rahka|kvarg|quark|jaatelo|\bglass\b|frozen/.test(name))
	)
		return false;
	if (criteria.productKind === "quark" && !/rahka|kvarg|quark/.test(name)) return false;
	if (criteria.productKind === "pudding" && !/vanukas|pudding/.test(name)) return false;
	if (criteria.vanillaOnly) {
		if (!/vanilja|vanilj|vanilla/.test(name)) return false;
		if (
			/puolukka|lingon|karpalo|cranberry|tranbar|lakka|hjortron|cloudberry|aprikoo|apricot|luumu|plommon|\bplum\b|kookos|coconut|kaneli|kanel|cinnamon|pahkina|hassel|pistaasi|pistachio|stracciatella|keksi|cookie/.test(
				name,
			)
		)
			return false;
		if (
			/vadelma|hallon|raspberry|mansikka|jordgubb|strawberry|mustikka|blabar|blueberry|paaryna|paron|pear|mango|banaani|banan|banana|tyrni|havtorn|sea.?buckthorn|persikka|persik|peach|omena|apple|appel|kirsikka|korsbar|cherry|suklaa|choklad|chocolate|kaakao|kakao|cocoa|sitruuna|citron|lemon|karamelli|caramel|kinuski|toffee|kahvi|kaffe|coffee|ananas|pineapple|passion|hedelma|frukt|fruit|marja|\bbar\b|berr/.test(
				name,
			)
		)
			return false;
	}
	return true;
}
