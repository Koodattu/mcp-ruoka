// Preserve evidence and reject ambiguous weights. Never infer mass from rounded EUR/kg.
export function packageSize(name: string) {
	const text = name.replace(/\u00a0/g, " ").toLowerCase();
	const number = (s: string | undefined) => Number(s?.replace(",", "."));
	const multi = text.match(/\b(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g)\b/);
	const weights = [...text.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(kg|g)\b/g)];
	if (!weights.length) return null;
	const masses = weights.map((m) => number(m[1]) * (m[2] === "kg" ? 1000 : 1));
	let units = 1,
		totalG = masses[0] ?? Number.NaN;
	if (multi) {
		units = number(multi[1]);
		const itemG = number(multi[2]) * (multi[3] === "kg" ? 1000 : 1);
		totalG = units * itemG;
		if (masses.some((g) => Math.abs(g - itemG) > 0.01 && Math.abs(g - totalG) > 0.01)) return null;
	} else {
		if (masses.some((g) => g !== totalG)) return null;
		const count = text.match(/\b(\d+)\s*(?:kpl|pcs|pack)\b/);
		if (count) units = number(count[1]);
		else if (/multipack|monipakkaus|\d+\s*[x×]/.test(text)) return null;
	}
	if (!(units > 0 && units <= 1000 && totalG > 0 && totalG <= 100000)) return null;
	return { totalG, units, itemG: totalG / units, evidence: name, basis: "retailer product name" };
}
