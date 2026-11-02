import * as z from "zod/v4";
import { getContext } from "./browser/session.ts";
import { memoizedLookup } from "./cache.ts";
import { getObservationStore } from "./observations.ts";
import { GroceryProductSchema } from "./product-schema.ts";
import { htmlText, readPublicDocument, readPublicText } from "./public-data.ts";

export const ManufacturerSourceSchema = z
	.object({
		gtin: z.string().regex(/^\d{8,14}$/),
		url: z.url().refine((value) => {
			const url = new URL(value);
			return (
				url.protocol === "https:" &&
				["www.arla.fi", "www.valio.fi"].includes(url.hostname) &&
				!url.port &&
				!url.username &&
				!url.password &&
				url.pathname.startsWith("/tuotteet/")
			);
		}, "Supported sources: HTTPS Arla or Valio Finland product pages"),
	})
	.strict();
export type ManufacturerSource = z.infer<typeof ManufacturerSourceSchema>;
const LabelSchema = z.object({
	gtin: z.string(),
	ingredients: z.string().nullable(),
	nutrition: GroceryProductSchema.shape.nutrition,
	source: GroceryProductSchema.shape.source,
});
export type ManufacturerLabel = z.infer<typeof LabelSchema>;

export function parseArlaLabel(text: string, input: ManufacturerSource): ManufacturerLabel {
	const reference = ManufacturerSourceSchema.parse(input);
	const content = text.replace(/\s+/g, " ");
	const gtin = content.match(/EAN-koodi\s*:?\s*(\d{8,14})\b/u)?.[1];
	if (gtin !== reference.gtin)
		throw new Error("Manufacturer label EAN does not match the requested product");
	const table = content.match(
		/Ravintosis[aä]lt[oö]\s+per\s+100\s*g\s*:?\s*(.+?)(?=Ainesosat|S[aä]ilytys|Pakkauskoko)/iu,
	)?.[1];
	if (!table) throw new Error("Supported manufacturer nutrition table was not found");
	const patterns = [
		["sugars", /josta sokereita\s*(\d+(?:[.,]\d+)?)\s*g/iu],
		["protein", /proteiinia?\s*(\d+(?:[.,]\d+)?)\s*g/iu],
		["fat", /(?:^|\s)rasvaa?\s*(\d+(?:[.,]\d+)?)\s*g/iu],
		["fatSaturated", /tyydyttyneit[aä]\s+rasvoja\s*(\d+(?:[.,]\d+)?)\s*g/iu],
		["carbohydrates", /hiilihydraatt(?:i|ia|eja)\s*(\d+(?:[.,]\d+)?)\s*g/iu],
		["salt", /suolaa?\s*(\d+(?:[.,]\d+)?)\s*g/iu],
	] as const;
	const values = patterns.flatMap(([name, pattern]) => {
		const value = table.match(pattern)?.[1];
		return value ? [{ name, value: `${value} g` }] : [];
	});
	if (!values.some((v) => v.name === "sugars"))
		throw new Error("Manufacturer sugar value is missing or not an exact amount");
	const ingredients =
		content
			.match(/Ainesosat\s*:?\s*(.+?)(?=S[aä]ilytys|Pakkauskoko|Allergiaseloste)/iu)?.[1]
			?.trim() ?? null;
	return LabelSchema.parse({
		gtin,
		ingredients,
		nutrition: [{ basis: "100 g", preparation: null, values }],
		source: { url: reference.url, fetchedAt: new Date().toISOString() },
	});
}

const inFlight = memoizedLookup<ManufacturerLabel>(0);
export async function getManufacturerLabel(input: ManufacturerSource): Promise<ManufacturerLabel> {
	const reference = ManufacturerSourceSchema.parse(input);
	const key = JSON.stringify(["manufacturer-label-v2", reference.gtin, reference.url]);
	return inFlight(key, async () => {
		const db = await getObservationStore();
		const cached = db.readCache(
			key,
			LabelSchema.refine(
				(label) =>
					label.gtin === reference.gtin &&
					ManufacturerSourceSchema.safeParse({ gtin: label.gtin, url: label.source.url }).success,
			),
		);
		if (cached) return cached;
		if (new URL(reference.url).hostname === "www.valio.fi") {
			const document = await readPublicDocument(reference.url, 24 * 60 * 60_000);
			const label = parseValioLabel(document.text, reference);
			label.source.fetchedAt = document.fetchedAt;
			db.writeCache(key, label, Date.parse(label.source.fetchedAt) + 24 * 60 * 60_000);
			return label;
		}
		const page = await (await getContext()).newPage();
		try {
			const response = await page.goto(reference.url, {
				waitUntil: "domcontentloaded",
				timeout: 30_000,
			});
			if (!response?.ok()) throw new Error(`Manufacturer page HTTP ${response?.status()}`);
			ManufacturerSourceSchema.parse({ ...reference, url: page.url() });
			const label = parseArlaLabel(await page.locator("body").innerText(), {
				...reference,
				url: page.url(),
			});
			db.writeCache(key, label, Date.parse(label.source.fetchedAt) + 24 * 60 * 60_000);
			return label;
		} finally {
			await page.close();
		}
	});
}

export function parseValioLabel(html: string, input: ManufacturerSource): ManufacturerLabel {
	const reference = ManufacturerSourceSchema.parse(input);
	const products = [
		...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g),
	]
		.map((match) =>
			z
				.object({ "@type": z.literal("Product"), gtin13: z.string() })
				.safeParse(JSON.parse(match[1] ?? "null")),
		)
		.filter((value) => value.success)
		.map((value) => value.data);
	if (!products.some((product) => product?.gtin13 === reference.gtin))
		throw new Error("Manufacturer label EAN does not match the requested product");
	const table = html.match(
		/Ravintosisältö per 100 g([\s\S]*?)(?=<h4 class="vl-product-nutrient-title"|<\/dl>)/u,
	)?.[1];
	if (!table) throw new Error("Supported manufacturer nutrition table was not found");
	const names: Record<string, string> = {
		"Energia kJ": "energyKj",
		"Energia kcal": "energyKcal",
		Rasva: "fat",
		"josta tyydyttynyttä": "fatSaturated",
		Hiilihydraatit: "carbohydrates",
		"josta sokereita": "sugars",
		Proteiini: "protein",
		Suola: "salt",
	};
	const values = [
		...table.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/g),
	].flatMap((match) => {
		const name = names[htmlText(match[1] ?? "")];
		const value = htmlText(match[2] ?? "");
		return name && /^\d+(?:[.,]\d+)?\s*(?:g|kJ|kcal)$/.test(value) ? [{ name, value }] : [];
	});
	if (!values.some((value) => value.name === "sugars"))
		throw new Error("Manufacturer sugar value is missing or not an exact amount");
	const ingredients = html.match(
		/Ainesosat ja allergeenit[\s\S]*?<p class="vl-product-detail__info">([\s\S]*?)<\/p>/u,
	)?.[1];
	return LabelSchema.parse({
		gtin: reference.gtin,
		ingredients: ingredients ? htmlText(ingredients) : null,
		nutrition: [{ basis: "100 g", preparation: null, values }],
		source: { url: reference.url, fetchedAt: new Date().toISOString() },
	});
}

export const ManufacturerDiscoverySchema = z
	.object({
		gtin: ManufacturerSourceSchema.shape.gtin,
		name: z.string().trim().min(3).max(200),
		manufacturer: z.enum(["arla", "valio"]),
		maxCandidates: z.number().int().min(1).max(10).default(5),
	})
	.strict();

const sitemaps = {
	arla: "https://www.arla.fi/sitemap.xml?type=Modules.Products.Business.SitemapUrlRewriter.ProductSitemapUrlWriter",
	valio: "https://www.valio.fi/vl_product-sitemap.xml",
};
const normalize = (text: string) =>
	text
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "");
export function manufacturerCandidates(
	xml: string,
	name: string,
	manufacturer: "arla" | "valio",
): string[] {
	const tokens = [...new Set(normalize(name).match(/[a-z]{3,}/g) ?? [])].filter(
		(token) => !["arla", "valio"].includes(token),
	);
	return [
		...new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => htmlText(match[1] ?? ""))),
	]
		.filter(
			(url) =>
				ManufacturerSourceSchema.shape.url.safeParse(url).success &&
				new URL(url).hostname === `www.${manufacturer}.fi`,
		)
		.map((url) => ({
			url,
			score: tokens.filter((token) => normalize(new URL(url).pathname).includes(token)).length,
		}))
		.filter((candidate) => candidate.score > 0)
		.sort((a, b) => b.score - a.score || a.url.length - b.url.length || a.url.localeCompare(b.url))
		.map((candidate) => candidate.url);
}

export async function discoverManufacturerLabel(
	input: z.input<typeof ManufacturerDiscoverySchema>,
) {
	const options = ManufacturerDiscoverySchema.parse(input);
	const sitemapUrl = sitemaps[options.manufacturer];
	const queue = manufacturerCandidates(
		await readPublicText(sitemapUrl, 24 * 60 * 60_000),
		options.name,
		options.manufacturer,
	);
	const checked: Array<{ url: string; error: string | null }> = [];
	const seen = new Set<string>();
	let label: ManufacturerLabel | null = null;
	while (queue.length && checked.length < options.maxCandidates) {
		const url = queue.shift();
		if (!url || seen.has(url)) continue;
		seen.add(url);
		try {
			label = await getManufacturerLabel({ gtin: options.gtin, url });
			checked.push({ url, error: null });
			break;
		} catch (error) {
			checked.push({ url, error: error instanceof Error ? error.message : String(error) });
			// Valio indexes the family page; individual package EANs live on child pages.
			if (options.manufacturer === "valio") {
				try {
					const html = await readPublicText(url, 24 * 60 * 60_000);
					const variants = [...html.matchAll(/href="([^"]+)"/g)]
						.map((match) => match[1] ?? "")
						.filter(
							(link) =>
								link.startsWith(url) &&
								link !== url &&
								ManufacturerSourceSchema.shape.url.safeParse(link).success &&
								!new URL(link).search &&
								!new URL(link).hash,
						);
					queue.unshift(...new Set(variants));
				} catch {
					/* Original failure is retained above. */
				}
			}
		}
	}
	return {
		label,
		checked,
		sitemapUrl,
		candidateLimit: options.maxCandidates,
		completeMarketCoverage: false,
		warnings: label
			? []
			: [
					"No verified label found within the candidate budget; this does not prove the manufacturer has no label.",
				],
	};
}
