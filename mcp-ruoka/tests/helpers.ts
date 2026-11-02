import { type GroceryProduct, productDefaults } from "../src/grocery-types.ts";

export function product(overrides: Partial<GroceryProduct> = {}): GroceryProduct {
	return {
		...productDefaults("s-kaupat", "1", "https://example.test/product"),
		id: "12345678",
		gtins: ["12345678"],
		name: "Vaniljajogurtti",
		price: 2,
		pricePerKg: 2,
		unitPrice: "2 EUR/kg",
		brand: null,
		category: "Jogurtti",
		imageUrl: null,
		...overrides,
	};
}
