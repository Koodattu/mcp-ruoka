import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { CompareInputSchema } from "./comparison.ts";
import {
	closeBrowser,
	compareProducts,
	getCapabilities,
	getNearbyStores,
	getPreferences,
	getProduct,
	getStores,
	searchProducts,
	setPreferences,
} from "./groceries.ts";
import { GroceryChainSchema } from "./grocery-types.ts";
import { getProviderHealth } from "./health.ts";
import { getLidlLeaflets } from "./lidl-discovery.ts";
import {
	discoverManufacturerLabel,
	getManufacturerLabel,
	ManufacturerDiscoverySchema,
} from "./manufacturer.ts";
import { getPriceHistory } from "./observations.ts";
import { PreferencesSchema } from "./preferences.ts";

try {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			chain: { type: "string" },
			query: { type: "string" },
			store: { type: "string" },
			id: { type: "string" },
			city: { type: "string" },
			limit: { type: "string" },
			offset: { type: "string" },
			"postal-code": { type: "string" },
			radius: { type: "string" },
			latitude: { type: "string" },
			longitude: { type: "string" },
			include: { type: "string", multiple: true },
			exclude: { type: "string", multiple: true },
			"rank-by": { type: "string" },
			"max-stores": { type: "string" },
			input: { type: "string" },
			since: { type: "string" },
			url: { type: "string" },
			"product-kind": { type: "string" },
			"vanilla-only": { type: "boolean" },
		},
	});
	const chain = values.chain ? GroceryChainSchema.parse(values.chain) : undefined;
	const command = positionals[0];
	let result: unknown;
	const coordinates =
		values.latitude != null || values.longitude != null
			? { latitude: Number(values.latitude), longitude: Number(values.longitude) }
			: undefined;
	const jsonInput: unknown = values.input
		? JSON.parse(await readFile(values.input, "utf8"))
		: undefined;
	if (command === "capabilities") result = getCapabilities();
	else if (command === "health") result = getProviderHealth();
	else if (command === "discover-manufacturer" && jsonInput)
		result = await discoverManufacturerLabel(ManufacturerDiscoverySchema.parse(jsonInput));
	else if (command === "leaflets")
		result = await getLidlLeaflets({
			storeId: values.store,
			city: values.city,
			query: values.query,
			limit: values.limit ? Number(values.limit) : undefined,
		});
	else if (command === "manufacturer" && values.id && values.url)
		result = await getManufacturerLabel({ gtin: values.id, url: values.url });
	else if (command === "history" && chain && values.id)
		result = await getPriceHistory({
			chain,
			id: values.id,
			storeId: values.store,
			since: values.since,
			limit: values.limit ? Number(values.limit) : undefined,
		});
	else if (command === "preferences") result = getPreferences();
	else if (command === "configure" && jsonInput)
		result = await setPreferences(PreferencesSchema.parse(jsonInput));
	else if (command === "nearby") {
		result = await getNearbyStores({
			postalCode: values["postal-code"],
			coordinates,
			radiusKm: values.radius ? Number(values.radius) : undefined,
			chains: chain ? [chain] : undefined,
			limit: values.limit ? Number(values.limit) : undefined,
		});
	} else if (command === "compare")
		result = await compareProducts(
			CompareInputSchema.parse(
				jsonInput ?? {
					queries: values.query ? [values.query] : undefined,
					productKind: values["product-kind"],
					vanillaOnly: values["vanilla-only"],
					postalCode: values["postal-code"],
					coordinates,
					radiusKm: values.radius ? Number(values.radius) : undefined,
					includeTerms: values.include,
					excludeTerms: values.exclude,
					rankBy: values["rank-by"],
					maxStores: values["max-stores"] ? Number(values["max-stores"]) : undefined,
					limit: values.limit ? Number(values.limit) : undefined,
				},
			),
		);
	else if (command === "stores") result = await getStores({ chain, city: values.city });
	else if (command === "search" && chain && values.query)
		result = await searchProducts({
			chain,
			query: values.query,
			storeId: values.store,
			limit: values.limit ? Number(values.limit) : undefined,
			offset: values.offset ? Number(values.offset) : undefined,
		});
	else if (command === "product" && chain && values.id)
		result = await getProduct({ chain, id: values.id, storeId: values.store });
	else
		throw new Error(
			"Usage: cli.ts capabilities | health | history --chain CHAIN --id ID [--store ID] [--since ISO_TIMESTAMP] | manufacturer --id GTIN --url PRODUCT_URL | discover-manufacturer --input JSON_FILE | leaflets [--store FI00173 --city Seinäjoki] [--query TEXT] | preferences | configure --input JSON_FILE | nearby --postal-code CODE [--radius KM] | compare --input JSON_FILE | compare --postal-code CODE --query TEXT [--product-kind yogurt] [--vanilla-only] [--rank-by total_sugar_then_price] | stores [--chain CHAIN] [--city CITY] | search --chain CHAIN --query TEXT [--store ID] | product --chain CHAIN --id ID [--store ID]",
		);
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
	process.stderr.write(
		`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
	);
	process.exitCode = 1;
} finally {
	await closeBrowser();
}
