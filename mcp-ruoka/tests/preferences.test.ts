import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { getPreferences, PreferencesSchema, setPreferences } from "../src/preferences.ts";

test("local preferences are validated, persisted and replaced without touching retailer settings", async () => {
	const dir = await mkdtemp(join(tmpdir(), "ruoka-preferences-"));
	const file = pathToFileURL(join(dir, "preferences.json"));
	try {
		assert.deepEqual(getPreferences(file), {});
		await setPreferences({ postalCode: "60100", defaultStores: { "k-ruoka": "N192" } }, file);
		assert.equal(getPreferences(file).postalCode, "60100");
		await setPreferences({ preferredStores: [{ chain: "s-kaupat", storeId: "516242633" }] }, file);
		assert.equal(getPreferences(file).postalCode, undefined);
		assert.equal(JSON.parse(await readFile(file, "utf8")).preferredStores[0].storeId, "516242633");
		assert.throws(() => PreferencesSchema.parse({ defaultStores: { "s-kaupat": "N192" } }));
	} finally {
		await rm(file);
		await rmdir(dir);
	}
});
