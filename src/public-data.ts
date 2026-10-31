import * as z from "zod/v4";
import { memoizedLookup } from "./cache.ts";
import { getObservationStore } from "./observations.ts";

const DocumentSchema = z.object({ text: z.string().max(5_000_000), fetchedAt: z.iso.datetime() });
const pending = memoizedLookup<z.infer<typeof DocumentSchema>>(0);
// Callers validate URLs against their own official source allowlists.
export async function readPublicDocument(url: string, ttlMs = 60 * 60_000) {
	return pending(url, async () => {
		const db = await getObservationStore();
		const key = `public-document-v1:${url}`;
		const cached = db.readCache(key, DocumentSchema);
		if (cached !== null) return cached;
		const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "error" });
		if (!response.ok) throw new Error(`Public source HTTP ${response.status}: ${url}`);
		const document = DocumentSchema.parse({
			text: await response.text(),
			fetchedAt: new Date().toISOString(),
		});
		db.writeCache(key, document, Date.now() + ttlMs);
		return document;
	});
}

export async function readPublicText(url: string, ttlMs = 60 * 60_000): Promise<string> {
	return (await readPublicDocument(url, ttlMs)).text;
}

export function htmlText(html: string): string {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;|&#160;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}
