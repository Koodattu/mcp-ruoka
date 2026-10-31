import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import proj4 from "proj4";
import * as z from "zod/v4";

// Regeneration only: proj4 is a dev dependency, not part of the running service.
const source = resolve(process.argv[2] ?? ".cache/postal-source");
const fi = await readFile(resolve(source, "FI.json"));
const pno = await readFile(resolve(source, "FI_PNO.json"));
const names = z
	.array(
		z.object({
			postcode: z.string().regex(/^\d{5}$/),
			postcode_fi_name: z.string(),
			postcode_sv_name: z.string(),
			municipal_code: z.string(),
			municipal_name_fi: z.string(),
			municipal_name_sv: z.string(),
			date: z.string(),
		}),
	)
	.parse(JSON.parse(fi.toString("utf8")));
const areas = z
	.object({
		crs: z.object({ properties: z.object({ name: z.literal("urn:ogc:def:crs:EPSG::3067") }) }),
		timeStamp: z.string(),
		features: z.array(
			z.object({
				properties: z.object({
					postinumeroalue: z.string(),
					euref_x: z.number(),
					euref_y: z.number(),
					vuosi: z.number(),
				}),
			}),
		),
	})
	.parse(JSON.parse(pno.toString("utf8")));
const points = new Map(
	areas.features.map(({ properties: p }) => {
		const [longitude, latitude] = proj4(
			"+proj=utm +zone=35 +ellps=GRS80 +units=m +no_defs",
			"EPSG:4326",
			[p.euref_x, p.euref_y],
		);
		return [p.postinumeroalue, { latitude, longitude }];
	}),
);
const rows = names
	.map((p) => {
		const point = points.get(p.postcode);
		return [
			p.postcode,
			p.postcode_fi_name,
			p.postcode_sv_name,
			p.municipal_code,
			p.municipal_name_fi,
			p.municipal_name_sv,
			point?.latitude ?? null,
			point?.longitude ?? null,
		];
	})
	.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
const output = {
	crs: "EPSG:4326",
	pointMeaning:
		"Paavo representative land point inside postal area; not a store address or necessarily a centroid",
	postalDate: names[0]?.date,
	areaTimestamp: areas.timeStamp,
	sourceSha256: {
		"FI.json": createHash("sha256").update(fi).digest("hex"),
		"FI_PNO.json": createHash("sha256").update(pno).digest("hex"),
	},
	columns: [
		"postalCode",
		"localityFi",
		"localitySv",
		"municipalityCode",
		"municipalityFi",
		"municipalitySv",
		"latitude",
		"longitude",
	],
	rows,
};
await mkdir("data", { recursive: true });
await writeFile("data/postal-areas.json", `${JSON.stringify(output, null, "\t")}\n`);
process.stdout.write(
	`Generated ${rows.length} postal records (${points.size} reference points). Source files were only read.\n`,
);
