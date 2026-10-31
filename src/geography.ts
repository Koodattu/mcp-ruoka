import { readFileSync } from "node:fs";
import * as z from "zod/v4";
import type { Store } from "./types.ts";

export const PointSchema = z.object({
	latitude: z.number().min(-90).max(90),
	longitude: z.number().min(-180).max(180),
});
export type Point = z.infer<typeof PointSchema>;
const RowSchema = z.tuple([
	z.string(),
	z.string(),
	z.string(),
	z.string(),
	z.string(),
	z.string(),
	z.number().nullable(),
	z.number().nullable(),
]);
const DatasetSchema = z.object({
	postalDate: z.string(),
	areaTimestamp: z.string(),
	rows: z.array(RowSchema),
});
let data: z.infer<typeof DatasetSchema> | undefined;
export function postalData() {
	data ??= DatasetSchema.parse(
		JSON.parse(readFileSync(new URL("../data/postal-areas.json", import.meta.url), "utf8")),
	);
	return data;
}
export function postalArea(postalCode: string) {
	const row = postalData().rows.find((r) => r[0] === postalCode);
	if (!row) return null;
	return {
		postalCode: row[0],
		locality: row[1],
		localitySv: row[2],
		municipalityCode: row[3],
		municipality: row[4],
		municipalitySv: row[5],
		point: row[6] == null || row[7] == null ? null : { latitude: row[6], longitude: row[7] },
	};
}
export function normalizePlace(text: string) {
	return text
		.trim()
		.toLocaleLowerCase("fi")
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "");
}

export function matchesCity(store: Store, city: string): boolean {
	const query = normalizePlace(city);
	const area = store.postalCode ? postalArea(store.postalCode) : null;
	const names = [
		store.location,
		area?.municipality,
		area?.municipalitySv,
		area?.locality,
		area?.localitySv,
	];
	if (names.some((s) => s && normalizePlace(s) === query)) return true;
	// K's directory sometimes omits postal codes; municipality membership can still be
	// resolved from the locality name, without substring-matching Peräseinäjoki to Seinäjoki.
	return postalData().rows.some(
		(r) =>
			[r[1], r[2]].some((s) => normalizePlace(s) === normalizePlace(store.location)) &&
			[r[4], r[5]].some((s) => normalizePlace(s) === query),
	);
}

export function distanceKm(a: Point, b: Point): number {
	const rad = Math.PI / 180;
	const dLat = (b.latitude - a.latitude) * rad;
	const dLon = (b.longitude - a.longitude) * rad;
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
	return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export const NearbyInputSchema = z
	.object({
		postalCode: z
			.string()
			.regex(/^\d{5}$/)
			.optional(),
		coordinates: PointSchema.optional(),
		radiusKm: z.number().positive().max(100).default(15),
		chains: z
			.array(z.enum(["k-ruoka", "s-kaupat"]))
			.min(1)
			.default(["k-ruoka", "s-kaupat"]),
		limit: z.number().int().min(1).max(100).default(30),
	})
	.strict()
	.refine(
		(v) => Boolean(v.postalCode) !== Boolean(v.coordinates),
		"Provide either postalCode or coordinates, not both",
	);

export function locateNearby(stores: Store[], input: z.input<typeof NearbyInputSchema>) {
	const options = NearbyInputSchema.parse(input);
	const area = options.postalCode ? postalArea(options.postalCode) : null;
	const origin = options.coordinates ?? area?.point;
	if (!origin)
		throw new Error(
			`No location point for postal code ${options.postalCode}; provide coordinates instead`,
		);
	const located = stores.flatMap((store) => {
		const point =
			store.coordinates ?? (store.postalCode ? postalArea(store.postalCode)?.point : null);
		if (!point) return [];
		const distance = distanceKm(origin, point);
		return [
			{
				...store,
				distanceKm: Math.round(distance * 10) / 10,
				distancePrecision: store.coordinates
					? ("store-coordinate" as const)
					: ("postal-area-reference" as const),
				withinRadius: distance <= options.radiusKm,
			},
		];
	});
	const matches = located
		.filter((s) => s.withinRadius)
		.sort((a, b) => a.distanceKm - b.distanceKm || a.id.localeCompare(b.id));
	return {
		origin: {
			...origin,
			postalCode: options.postalCode ?? null,
			locality: area?.locality ?? null,
			municipality: area?.municipality ?? null,
			precision: options.coordinates ? "provided-coordinate" : "postal-area-reference",
		},
		radiusKm: options.radiusKm,
		stores: matches.slice(0, options.limit).map(({ withinRadius: _, ...store }) => store),
		totalWithinRadius: matches.length,
		truncated: matches.length > options.limit,
		unlocatedStoreCount: stores.length - located.length,
		warnings: [
			"Distances are straight-line estimates, not driving distances. Postal-area reference points can be far from an actual home or store; radius boundaries are approximate.",
			"Lidl store discovery is not supported; Lidl published products have no verified local availability.",
		],
		postalDataDate: postalData().postalDate,
	};
}
