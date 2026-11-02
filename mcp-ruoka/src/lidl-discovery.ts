import * as z from "zod/v4";
import { memoizedLookup } from "./cache.ts";
import { normalizePlace, PointSchema } from "./geography.ts";
import { readPublicDocument, readPublicText } from "./public-data.ts";
import type { Store } from "./types.ts";

const ORIGIN = "https://www.lidl.fi";
const DIRECTORY = "/s/fi-FI/myymaelaet/";
const DirectoryPath = z.string().regex(/^\/s\/fi-FI\/myymaelaet\/[a-z0-9/_?=.-]*$/);

// Decode only selected data records, never execute Nuxt scripts or read runtime configuration.
function decodeRecord(values: unknown[], entry: unknown, depth = 0): unknown {
	if (depth > 30) throw new Error("Recursive Lidl directory data");
	function resolve(index: unknown): unknown {
		const id = z.number().int().parse(index);
		if (id < 0) return null;
		if (id >= values.length) throw new Error("Invalid Lidl directory reference");
		return decodeRecord(values, values[id], depth + 1);
	}
	if (Array.isArray(entry)) return entry.map(resolve);
	if (entry && typeof entry === "object")
		return Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, resolve(value)]));
	return entry;
}

const RawStore = z.object({
	objectNumber: z.string().regex(/^FI\d+$/),
	objectType: z.literal("STORE"),
	storeName: z.string(),
	address: PointSchema.extend({
		streetName: z.string(),
		streetNumber: z.string().nullable(),
		city: z.string(),
		zip: z.string(),
	}),
	marketingData: z.object({ offerRegion: z.number().int(), offerRegionName: z.string() }),
});
export function parseLidlStores(raw: unknown, sourceUrl: string): Store[] {
	const values = z.array(z.unknown()).parse(raw);
	const records = values.filter(
		(entry) =>
			z
				.object({ objectNumber: z.number(), objectType: z.number(), address: z.number() })
				.safeParse(entry).success,
	);
	if (!records.length) throw new Error("Lidl store records missing from directory payload");
	return records.map((entry) => {
		const store = RawStore.parse(decodeRecord(values, entry));
		return {
			id: store.objectNumber,
			name: `Lidl ${store.storeName}`,
			chain: "lidl",
			location: store.address.city,
			postalCode: store.address.zip,
			address: [store.address.streetName, store.address.streetNumber].filter(Boolean).join(" "),
			coordinates: { latitude: store.address.latitude, longitude: store.address.longitude },
			website: sourceUrl,
			offerRegion: {
				id: store.marketingData.offerRegion,
				name: store.marketingData.offerRegionName,
			},
		};
	});
}

const City = z.object({
	name: z.string(),
	numberOfStores: z.number().int().positive(),
	url: DirectoryPath,
});
export function parseLidlCities(raw: unknown) {
	const values = z.array(z.unknown()).parse(raw);
	const regions = values.filter(
		(entry) => z.object({ cities: z.number() }).safeParse(entry).success,
	);
	const cities = regions.flatMap(
		(entry) => z.object({ cities: z.array(City) }).parse(decodeRecord(values, entry)).cities,
	);
	if (!cities.length) throw new Error("Lidl city directory missing");
	return cities;
}
async function payload(path: string): Promise<unknown> {
	DirectoryPath.parse(path);
	const html = await readPublicText(`${ORIGIN}${path}`, 24 * 60 * 60_000);
	const dataPath = DirectoryPath.parse(
		html.match(/data-src="([^"]+\/[_]payload\.json[^"<>]*)"/)?.[1],
	);
	return JSON.parse(await readPublicText(`${ORIGIN}${dataPath}`, 24 * 60 * 60_000));
}
const storesCache = memoizedLookup<Store[]>(60 * 60_000, 150);
export async function getLidlStores(city?: string): Promise<Store[]> {
	return storesCache(city ?? "*", async () => {
		const cities = parseLidlCities(await payload(DIRECTORY)).filter(
			(entry) => !city || normalizePlace(entry.name) === normalizePlace(city),
		);
		const stores: Store[] = [];
		// Two concurrent city loads keep the first nationwide refresh bounded and polite.
		for (let index = 0; index < cities.length; index += 2) {
			const batch = await Promise.all(
				cities.slice(index, index + 2).map(async (entry) => {
					const found = parseLidlStores(await payload(entry.url), `${ORIGIN}${entry.url}`);
					// The country index can lag openings (observed Tampere: 9 vs 10).
					if (found.length < entry.numberOfStores)
						throw new Error(`Lidl directory appears incomplete for ${entry.name}`);
					return found;
				}),
			);
			stores.push(...batch.flat());
		}
		return [...new Map(stores.map((store) => [store.id, store])).values()];
	});
}

export const LidlLeafletsInputSchema = z
	.object({
		storeId: z
			.string()
			.regex(/^FI\d+$/)
			.optional(),
		city: z.string().trim().min(1).optional(),
		query: z.string().trim().min(1).max(100).optional(),
		limit: z.number().int().min(1).max(10).default(4),
	})
	.strict();
const LeafletUrl = z
	.url()
	.refine((value) =>
		/^https:\/\/www\.lidl\.fi\/l\/fi\/tarjouslehdet\/[a-z0-9-]+\/ar\/\d+$/.test(value),
	);
export function leafletLinks(html: string): string[] {
	return [
		...new Set(
			[...html.matchAll(/https:\/\/www\.lidl\.fi\/l\/fi\/tarjouslehdet\/[^"<>\s]+/g)]
				.map((match) => match[0])
				.filter((url) => LeafletUrl.safeParse(url).success),
		),
	];
}
const FlyerSchema = z.object({
	success: z.literal(true),
	flyer: z.object({
		id: z.string(),
		name: z.string(),
		title: z.string(),
		countryCode: z.literal("FI"),
		isActive: z.boolean(),
		pdfUrl: z.url(),
		flyerUrlAbsolute: z.url(),
		startDate: z.string(),
		endDate: z.string(),
		offerStartDate: z.string().nullable(),
		offerEndDate: z.string().nullable(),
		regions: z.array(z.object({ code: z.string() })),
		products: z.array(z.unknown()),
		pages: z.array(
			z.object({
				number: z.number().int(),
				keyWords: z.string().nullish(),
				altText: z.string().nullish(),
				image: z.url(),
			}),
		),
	}),
});
export function parseLidlLeaflet(raw: unknown, query?: string, regionId?: number) {
	const { flyer } = FlyerSchema.parse(raw);
	const matchesRegion =
		regionId === undefined
			? null
			: flyer.regions.some((region) => region.code === String(regionId));
	return {
		id: flyer.id,
		name: flyer.name,
		title: flyer.title,
		url: flyer.flyerUrlAbsolute,
		pdfUrl: flyer.pdfUrl,
		isActive: flyer.isActive,
		publicationStart: flyer.startDate,
		publicationEnd: flyer.endDate,
		offerStart: flyer.offerStartDate,
		offerEnd: flyer.offerEndDate,
		requestedRegion: regionId ?? null,
		publishedRegions: flyer.regions.map((region) => region.code),
		matchesRequestedRegion: matchesRegion,
		structuredProductCount: flyer.products.length,
		totalPages: flyer.pages.length,
		pages: flyer.pages
			.filter(
				(page) =>
					!query ||
					normalizePlace(`${page.keyWords ?? ""} ${page.altText ?? ""}`).includes(
						normalizePlace(query),
					),
			)
			.map((page) => ({
				number: page.number,
				text: page.keyWords ?? null,
				description: page.altText ?? null,
				imageUrl: page.image,
			})),
	};
}
export async function getLidlLeaflets(input: z.input<typeof LidlLeafletsInputSchema> = {}) {
	const options = LidlLeafletsInputSchema.parse(input);
	const store = options.storeId
		? (await getLidlStores(options.city)).find((entry) => entry.id === options.storeId)
		: undefined;
	if (options.storeId && !store) throw new Error("Lidl store not found in the requested directory");
	const indexUrl = `${ORIGIN}/c/tarjouslehdet/s10019134`;
	const links = leafletLinks(await readPublicText(indexUrl));
	if (!links.length)
		throw new Error("No Lidl leaflet links found; publication layout may have changed");
	const leaflets = [];
	const failures: Array<{ url: string; error: string }> = [];
	for (const url of links.slice(0, options.limit)) {
		const segments = new URL(url).pathname.split("/");
		const region = store?.offerRegion?.id ?? Number(segments.at(-1));
		const api = new URL("https://endpoints.leaflets.schwarz/v4/flyer");
		api.search = new URLSearchParams({
			flyer_identifier: segments.at(-3) ?? "",
			region_id: String(region),
			region_code: String(region),
		}).toString();
		try {
			const document = await readPublicDocument(api.href);
			leaflets.push({
				...parseLidlLeaflet(JSON.parse(document.text), options.query, store?.offerRegion?.id),
				source: { url: api.href, fetchedAt: document.fetchedAt },
			});
		} catch (error) {
			failures.push({ url, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return {
		store: store ?? null,
		leaflets,
		failures,
		truncated: links.length > options.limit,
		sourceUrl: indexUrl,
		warnings: [
			"Published leaflet index coverage only; regional-only leaflets may be absent. Returned region codes must match before claiming store-specific applicability.",
			"Page text is search evidence, not structured prices: layout and decimal separators may be lost. Consult the PDF/image for prices and Lidl Plus conditions. Shelf stock and complete assortment remain unknown.",
		],
	};
}
