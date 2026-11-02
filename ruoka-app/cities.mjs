import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.mjs";

const normalize = (value) =>
	value
		.trim()
		.toLocaleLowerCase("fi")
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "");
const { rows } = JSON.parse(
	readFileSync(resolve(config.mcpDir, "data/postal-areas.json"), "utf8"),
);
const municipalities = new Map();
for (const row of rows) {
	if (!row[4]) continue;
	const city = municipalities.get(row[4]) ?? {
		name: row[4],
		aliases: new Set(),
	};
	for (const name of [row[1], row[2], row[4], row[5]])
		if (name) city.aliases.add(normalize(name));
	municipalities.set(city.name, city);
}
export const cities = [...municipalities.keys()].sort((a, b) =>
	a.localeCompare(b, "fi"),
);
export function resolveCity(value) {
	if (typeof value !== "string" || !value.trim() || value.length > 100)
		throw new Error("Choose a Finnish city from the suggestions.");
	const key = normalize(value);
	const exact = cities.find((city) => normalize(city) === key);
	if (exact) return exact;
	const matches = [...municipalities.values()].filter((city) =>
		city.aliases.has(key),
	);
	if (matches.length === 1) return matches[0].name;
	throw new Error(
		matches.length
			? "That locality belongs to more than one municipality. Choose the municipality name."
			: "City not found. Choose a Finnish city from the suggestions.",
	);
}
