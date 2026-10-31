import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import * as z from "zod/v4";
import { PointSchema } from "./geography.ts";

export const StoreSelectionSchema = z
	.object({ chain: z.enum(["k-ruoka", "s-kaupat"]), storeId: z.string().min(1) })
	.strict()
	.refine(
		(s) => (s.chain === "k-ruoka" ? /^[A-Z]\d+$/ : /^\d+$/).test(s.storeId),
		"Invalid store ID for retailer",
	);
export const PreferencesSchema = z
	.object({
		postalCode: z
			.string()
			.regex(/^\d{5}$/)
			.optional(),
		coordinates: PointSchema.optional(),
		radiusKm: z.number().positive().max(100).optional(),
		preferredStores: z.array(StoreSelectionSchema).max(20).optional(),
		defaultStores: z
			.object({
				"k-ruoka": z
					.string()
					.regex(/^[A-Z]\d+$/)
					.optional(),
				"s-kaupat": z.string().regex(/^\d+$/).optional(),
			})
			.strict()
			.optional(),
	})
	.strict()
	.refine((p) => !(p.postalCode && p.coordinates), "Choose postalCode or coordinates, not both");
const path = new URL("../.ruoka-preferences.json", import.meta.url);

export function getPreferences(target: URL = path): z.infer<typeof PreferencesSchema> {
	try {
		return PreferencesSchema.parse(JSON.parse(readFileSync(target, "utf8")));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
		throw new Error("Could not read .ruoka-preferences.json; check its JSON and supported fields", {
			cause: error,
		});
	}
}

let writeTail: Promise<unknown> = Promise.resolve();
export async function setPreferences(input: z.input<typeof PreferencesSchema>, target: URL = path) {
	const value = PreferencesSchema.parse(input);
	const task = writeTail
		.catch(() => {})
		.then(async () => {
			const temporary = new URL(`${target.href}.${process.pid}.tmp`);
			await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
			await rename(temporary, target);
			return { preferences: value, saved: true };
		});
	writeTail = task;
	return task;
}
