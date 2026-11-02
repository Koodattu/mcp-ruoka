import { gunzipSync } from "node:zlib";
import * as z from "zod/v4";
import { memoizedLookup } from "../cache.ts";
import {
	type GroceryProduct,
	type GrocerySearchResult,
	productDefaults,
} from "../grocery-types.ts";
import { parseLidlLabel } from "../lidl-label.ts";
import { requestJson } from "./request.ts";
import { getContext } from "./session.ts";

const ORIGIN = "https://www.lidl.fi";
const COVERAGE =
	"Lidl publishes only part of its assortment. Prices may be dated, regional or conditional; local store stock is unknown.";
const PriceSchema = z.object({
	price: z.number().nullish(),
	currencyCode: z.string().nullish(),
	basePrice: z.object({ text: z.string().nullish() }).nullish(),
	packaging: z.object({ text: z.string().nullish() }).nullish(),
	startDate: z.string().nullish(),
	endDate: z.string().nullish(),
	variantsHaveDifferentPrices: z.boolean().nullish(),
});
const LidlProductSchema = z.object({
	productId: z.number(),
	canonicalPath: z.string(),
	fullTitle: z.string().nullish(),
	category: z.string(),
	image: z.string().nullish(),
	brand: z.object({ name: z.string().nullish() }).nullish(),
	keyfacts: z.object({ fullTitle: z.string().nullish() }).nullish(),
	price: PriceSchema.nullish(),
	eans: z.array(z.string()).nullish(),
	regionsV2: z
		.record(
			z.string(),
			z.object({ regionName: z.string(), isDefault: z.boolean(), regionPriceId: z.string() }),
		)
		.nullish(),
	regionsPrices: z.record(z.string(), z.object({ currentPrice: PriceSchema.nullish() })).nullish(),
	lidlPlus: z.array(z.unknown()).nullish(),
	multipack: z.boolean().nullish(),
	storeFacts: z.object({ storeStartDate: z.number().nullish() }).nullish(),
	stockAvailability: z
		.object({
			badgeInfoV2: z
				.array(
					z.object({
						validFrom: z.number().nullish(),
						validUntil: z.number().nullish(),
						badges: z.array(z.object({ text: z.string() })).nullish(),
					}),
				)
				.nullish(),
		})
		.nullish(),
});

export function parseLidlProduct(raw: unknown, now = Date.now()): GroceryProduct {
	const p = LidlProductSchema.parse(raw);
	if (!/^\/p\/[a-z0-9-]+\/p\d+$/.test(p.canonicalPath))
		throw new Error("Unexpected Lidl product path");
	const regions = Object.values(p.regionsV2 ?? {});
	const defaultRegion = regions.find((r) => r.isDefault);
	const price =
		(defaultRegion && p.regionsPrices?.[defaultRegion.regionPriceId]?.currentPrice) || p.price;
	const badges = p.stockAvailability?.badgeInfoV2 ?? [];
	const starts = [
		price?.startDate ? Date.parse(price.startDate) : null,
		p.storeFacts?.storeStartDate ? p.storeFacts.storeStartDate * 1000 : null,
		...badges.map((b) => (b.validFrom == null ? null : b.validFrom * 1000)),
	].filter((v) => v != null);
	const ends = [
		price?.endDate ? Date.parse(price.endDate) : null,
		...badges.map((b) => (b.validUntil == null ? null : b.validUntil * 1000)),
	].filter((v) => v != null);
	const validFrom = starts.length ? Math.max(...starts) : null;
	const validUntil = ends.length ? Math.min(...ends) : null;
	const active =
		(validFrom == null || validFrom <= now) && (validUntil == null || validUntil >= now);
	const conditions: string[] = [];
	if (regions.length)
		conditions.push(
			`Published regions: ${regions.map((r) => r.regionName).join(", ")}. Price region: ${defaultRegion?.regionName ?? "unspecified"}.`,
		);
	if (p.lidlPlus?.length)
		conditions.push("Lidl Plus offers also exist; membership prices are not resolved.");
	if (p.multipack)
		conditions.push("Multipack offer; check the product page for quantity conditions.");
	if (price?.variantsHaveDifferentPrices) conditions.push("Variants have different prices.");
	conditions.push(...badges.flatMap((b) => (b.badges ?? []).map((badge) => badge.text)));
	const text = price?.basePrice?.text ?? price?.packaging?.text ?? null;
	const match = text?.match(/(\d+(?:[,.]\d+)?)\s*€\s*\/\s*(kg|l)\b/i);
	const comparison =
		active && !p.multipack && match?.[1] && match[2]
			? { amount: Number(match[1].replace(",", ".")), unit: match[2].toLowerCase() }
			: null;
	const result: GroceryProduct = {
		...productDefaults("lidl", null, `${ORIGIN}${p.canonicalPath}`),
		id: String(p.productId),
		gtins: p.eans ?? [],
		name: p.fullTitle ?? p.keyfacts?.fullTitle ?? p.canonicalPath,
		price: active && price?.currencyCode === "EUR" && !p.multipack ? (price.price ?? null) : null,
		unitPrice: active ? text : null,
		pricePerKg: comparison?.unit === "kg" ? comparison.amount : null,
		imageUrl: p.image ?? null,
		brand: p.brand?.name ?? null,
		category: p.category,
		warnings: [COVERAGE],
	};
	result.pricing = {
		...result.pricing,
		unitPrice: comparison,
		publishedPrice: price?.currencyCode === "EUR" ? (price.price ?? null) : null,
		validFrom:
			validFrom != null && Number.isFinite(validFrom) ? new Date(validFrom).toISOString() : null,
		validUntil:
			validUntil != null && Number.isFinite(validUntil) ? new Date(validUntil).toISOString() : null,
		conditions,
	};
	if (!active)
		result.warnings.push(
			"Published price is outside its validity period; current price is unknown.",
		);
	return result;
}

const indexCache = memoizedLookup<Map<string, GroceryProduct>>(60 * 60_000, 1);
async function getIndex(): Promise<Map<string, GroceryProduct>> {
	return indexCache("catalog", async () => {
		const url = new URL("/q/api/search", ORIGIN);
		url.search = new URLSearchParams({
			assortment: "FI",
			locale: "fi_FI",
			version: "v2.0.0",
			fetchsize: "60",
		}).toString();
		const items: unknown[] = [];
		for (let page = 0; page < 20; page++) {
			url.searchParams.set("offset", String(items.length));
			const data = z
				.object({
					numFound: z.number(),
					offset: z.number(),
					items: z.array(z.object({ gridbox: z.object({ data: z.unknown() }) })),
				})
				.parse(await requestJson(url, ORIGIN));
			if (data.offset !== items.length)
				throw new Error("Lidl did not honor the catalog pagination offset");
			items.push(...data.items.map((item) => item.gridbox.data));
			if (items.length >= data.numFound) break;
			if (!data.items.length || page === 19)
				throw new Error("Lidl catalog pagination was incomplete");
		}
		const products = new Map<string, GroceryProduct>();
		for (const item of items) {
			const category = z.object({ category: z.string() }).parse(item).category;
			if (!["Food", "F+V"].includes(category)) continue;
			const product = parseLidlProduct(item);
			products.set(product.id, product);
		}
		// The product sitemap also contains permanent bakery labels missing from search.
		const res = await fetch(`${ORIGIN}/p/export/FI/fi/product_sitemap.xml.gz`, {
			signal: AbortSignal.timeout(20_000),
		});
		if (!res.ok) throw new Error(`Lidl sitemap HTTP ${res.status}`);
		const bytes = Buffer.from(await res.arrayBuffer());
		const xml = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString(
			"utf8",
		);
		for (const match of xml.matchAll(
			/<loc>(https:\/\/www\.lidl\.fi\/p\/([a-z0-9-]+)\/p(\d+))<\/loc>/g,
		)) {
			const [, source, slug, id] = match;
			if (!source || !slug || !id || products.has(id)) continue;
			products.set(id, {
				...productDefaults("lidl", null, source),
				id,
				name: slug.replaceAll("-", " "),
				price: null,
				unitPrice: null,
				imageUrl: null,
				brand: null,
				category: null,
				warnings: [
					COVERAGE,
					"Sitemap-only match: name is derived from URL; call get_product to verify product category and label.",
				],
			});
		}
		if (!products.size) throw new Error("Lidl returned an empty catalog");
		return products;
	});
}

export async function searchProducts(
	query: string,
	limit: number,
	offset: number,
): Promise<GrocerySearchResult> {
	const normalize = (s: string) =>
		s
			.toLowerCase()
			.normalize("NFD")
			.replace(/\p{Diacritic}/gu, "");
	const terms = normalize(query).split(/\s+/);
	const matches = [...(await getIndex()).values()].filter((p) =>
		terms.every((term) => normalize(`${p.name} ${p.brand ?? ""} ${p.id}`).includes(term)),
	);
	return {
		chain: "lidl",
		storeId: null,
		query,
		products: matches.slice(offset, offset + limit),
		totalCount: matches.length,
		offset,
		nextOffset: offset + limit < matches.length ? offset + limit : null,
		coverage: "partial-published-catalog",
		warnings: [
			COVERAGE,
			"Search matches published names/brands and sitemap URLs, not a complete GTIN or ingredients index. Sitemap-only matches may include non-food items.",
		],
	};
}

// Nuxt's JSON contains indexed references. Decode only the product subtree; never eval scripts.
export function decodeLidlProduct(raw: unknown): unknown {
	const values = z.array(z.unknown()).parse(raw);
	const entry = values.find(
		(v) =>
			z
				.object({ productId: z.number(), variants: z.number(), canonicalPath: z.number() })
				.safeParse(v).success,
	);
	if (!entry) throw new Error("Lidl product data was not found in the page");
	function decode(value: unknown, depth = 0): unknown {
		if (depth > 30) throw new Error("Unexpected recursive Lidl product data");
		if (Array.isArray(value)) return value.map((v: unknown) => resolve(v, depth + 1));
		if (value && typeof value === "object")
			return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, depth + 1)]));
		return value;
	}
	function resolve(index: unknown, depth: number): unknown {
		const i = z.number().int().parse(index);
		if (i < 0) return null;
		if (i >= values.length) throw new Error("Invalid Lidl data reference");
		return decode(values[i], depth);
	}
	return decode(entry);
}

let detailTail: Promise<unknown> = Promise.resolve();
export async function getProduct(id: string): Promise<GroceryProduct> {
	const task = detailTail
		.catch(() => {})
		.then(async () => {
			const found = (await getIndex()).get(id);
			if (!found) throw new Error("Lidl product ID was not found in its published catalog");
			const page = await (await getContext()).newPage();
			try {
				const response = await page.goto(found.source.url, { waitUntil: "domcontentloaded" });
				if (!response?.ok()) throw new Error(`Lidl product page HTTP ${response?.status()}`);
				const text = await page.locator("script#__NUXT_DATA__").textContent();
				const product = parseLidlProduct(decodeLidlProduct(JSON.parse(text ?? "null")));
				if (product.id !== id) throw new Error("Lidl returned the wrong product");
				product.labelText =
					(await page.locator(".info-content").allTextContents()).join("\n").trim() || null;
				product.nutrition = product.labelText ? parseLidlLabel(product.labelText) : [];
				if (product.labelText)
					product.warnings.push(
						"Original bilingual label is retained. Only the supported bakery-label format is normalized; absent parsed fields remain unknown.",
					);
				return product;
			} finally {
				await page.close();
			}
		});
	detailTail = task;
	return task;
}
