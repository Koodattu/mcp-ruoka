import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import { CACHE_MS, offerExpiry } from "./cache-policy.ts";
import { GroceryChainSchema, type GroceryProduct, productDefaults } from "./grocery-types.ts";
import { packageSize } from "./package-size.ts";
import { GroceryProductSchema } from "./product-schema.ts";

type Binding = string | number | null;
interface Database {
	exec(sql: string): unknown;
	prepare(sql: string): {
		run(...values: Binding[]): unknown;
		get(...values: Binding[]): unknown;
		all(...values: Binding[]): unknown;
	};
	close(): void;
}
const JsonRow = z.object({ payload: z.string() });
const CacheRow = JsonRow.extend({ expires: z.number() });
export const HistoryInputSchema = z
	.object({
		chain: GroceryChainSchema,
		id: z.string().regex(/^\d{1,14}$/),
		storeId: z.string().min(1).optional(),
		since: z.iso.datetime().optional(),
		limit: z.number().int().min(1).max(200).default(50),
	})
	.strict()
	.refine((v) => v.chain !== "lidl" || !v.storeId, "Lidl has no store-specific observations");
const OfferSchema = GroceryProductSchema.pick({
	chain: true,
	storeId: true,
	id: true,
	name: true,
	price: true,
	pricePerKg: true,
	pricing: true,
	availability: true,
	source: true,
}).extend({ kind: z.enum(["search", "detail"]) });

export class ObservationStore {
	private readonly counters = { hits: 0, misses: 0, writes: 0 };
	cacheStats() {
		return { ...this.counters };
	}
	private readonly db: Database;
	private constructor(db: Database) {
		this.db = db;
	}
	static async open(path: string) {
		if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
		const db: Database = process.versions.bun
			? new (await import("bun:sqlite")).Database(path)
			: new (await import("node:sqlite")).DatabaseSync(path);
		try {
			db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;
			CREATE TABLE IF NOT EXISTS cache_v1 (key TEXT PRIMARY KEY, expires REAL NOT NULL, payload TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS offers_v1 (chain TEXT NOT NULL, store TEXT NOT NULL, id TEXT NOT NULL, observed_at TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(chain,store,id,observed_at,kind));
			CREATE INDEX IF NOT EXISTS offers_product_v1 ON offers_v1(chain,id,observed_at DESC);
			CREATE TABLE IF NOT EXISTS labels_v1 (chain TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(chain,id,digest));`);
		} catch (error) {
			db.close();
			throw error;
		}
		return new ObservationStore(db);
	}
	close() {
		this.db.close();
	}
	readLabel(summary: GroceryProduct, now = Date.now()): GroceryProduct | null {
		const row = this.db
			.prepare(
				"SELECT payload,last_seen FROM labels_v1 WHERE chain=? AND id=? ORDER BY last_seen DESC LIMIT 1",
			)
			.get(summary.chain, summary.id) as { payload: string; last_seen: string } | undefined;
		if (!row || Date.parse(row.last_seen) + CACHE_MS.labels <= now) {
			this.counters.misses++;
			return null;
		}
		const label = JSON.parse(row.payload);
		const oldSize = packageSize(label.name ?? summary.name),
			newSize = packageSize(summary.name);
		if (
			oldSize &&
			newSize &&
			(oldSize.totalG !== newSize.totalG || oldSize.units !== newSize.units)
		) {
			this.counters.misses++;
			return null;
		}
		const parsed = GroceryProductSchema.safeParse({
			...summary,
			...label,
			source: { url: label.url, fetchedAt: row.last_seen },
		});
		if (!parsed.success || !parsed.data.gtins.includes(summary.id)) {
			this.counters.misses++;
			return null;
		}
		this.counters.hits++;
		return parsed.data;
	}
	readProduct(
		chain: GroceryProduct["chain"],
		storeId: string | null,
		id: string,
		now = Date.now(),
	): GroceryProduct | null {
		const row = this.db
			.prepare(
				"SELECT payload FROM offers_v1 WHERE chain=? AND store=? AND id=? AND observed_at>? ORDER BY observed_at DESC LIMIT 1",
			)
			.get(chain, storeId ?? "", id, new Date(now - CACHE_MS.offers).toISOString()) as
			| { payload: string }
			| undefined;
		if (!row) return null;
		const offer = OfferSchema.parse(JSON.parse(row.payload));
		if (offerExpiry([offer], now) <= now) return null;
		const summary = GroceryProductSchema.parse({
			...productDefaults(chain, storeId, offer.source.url),
			imageUrl: null,
			brand: null,
			category: null,
			unitPrice: null,
			gtins: [id],
			...offer,
		});
		const label = this.readLabel(summary, now);
		return label
			? {
					...label,
					...offer,
					labelSource: label.source,
					unitPrice: offer.pricing.unitPrice
						? `${offer.pricing.unitPrice.amount} EUR/${offer.pricing.unitPrice.unit}`
						: null,
				}
			: null;
	}
	readCache<T>(key: string, schema: z.ZodType<T>, now = Date.now()): T | null {
		const raw = this.db.prepare("SELECT expires,payload FROM cache_v1 WHERE key=?").get(key);
		if (!raw) {
			this.counters.misses++;
			return null;
		}
		const row = CacheRow.parse(raw);
		if (row.expires <= now) {
			this.counters.misses++;
			return null;
		}
		try {
			const value = schema.parse(JSON.parse(row.payload));
			this.counters.hits++;
			return value;
		} catch {
			this.counters.misses++;
			// A cache from an older schema can be reloaded; historical observations stay untouched.
			this.db.prepare("DELETE FROM cache_v1 WHERE key=?").run(key);
			return null;
		}
	}
	writeCache(key: string, value: unknown, expires: number) {
		this.counters.writes++;
		this.db
			.prepare(
				"INSERT INTO cache_v1 VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET expires=excluded.expires,payload=excluded.payload",
			)
			.run(key, expires, JSON.stringify(value));
		this.db.prepare("DELETE FROM cache_v1 WHERE expires < ?").run(Date.now());
	}
	record(products: GroceryProduct[], kind: "search" | "detail") {
		const validated = products.map((p) => GroceryProductSchema.parse(p));
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const insertOffer = this.db.prepare("INSERT OR IGNORE INTO offers_v1 VALUES (?,?,?,?,?,?)");
			const insertLabel = this.db.prepare(
				"INSERT INTO labels_v1 VALUES (?,?,?,?,?,?) ON CONFLICT(chain,id,digest) DO UPDATE SET first_seen=min(first_seen,excluded.first_seen),last_seen=max(last_seen,excluded.last_seen)",
			);
			for (const p of validated) {
				p.source.fetchedAt = new Date(p.source.fetchedAt).toISOString();
				// Prices and catalog flags are observations, never proof of physical stock.
				const offer = {
					chain: p.chain,
					storeId: p.storeId,
					id: p.id,
					name: p.name,
					price: p.price,
					pricePerKg: p.pricePerKg,
					pricing: p.pricing,
					availability: p.availability,
					source: p.source,
					kind,
				};
				insertOffer.run(
					p.chain,
					p.storeId ?? "",
					p.id,
					p.source.fetchedAt,
					kind,
					JSON.stringify(offer),
				);
				if (kind === "detail") {
					const label = {
						name: p.name,
						imageUrl: p.imageUrl,
						brand: p.brand,
						category: p.category,
						categoryPath: p.categoryPath,
						gtins: p.gtins,
						ingredients: p.ingredients,
						description: p.description,
						claims: p.claims,
						allergens: p.allergens,
						nutrition: p.nutrition,
						origin: p.origin,
						storage: p.storage,
						labelText: p.labelText,
						url: p.source.url,
					};
					const payload = JSON.stringify(label);
					const digest = createHash("sha256").update(payload).digest("hex");
					insertLabel.run(p.chain, p.id, digest, p.source.fetchedAt, p.source.fetchedAt, payload);
				}
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	history(input: z.input<typeof HistoryInputSchema>) {
		const p = HistoryInputSchema.parse(input);
		const rows = z
			.array(JsonRow)
			.parse(
				this.db
					.prepare(
						"SELECT payload FROM offers_v1 WHERE chain=? AND id=? AND (? IS NULL OR store=?) AND observed_at>=? ORDER BY observed_at DESC,store,kind LIMIT ?",
					)
					.all(
						p.chain,
						p.id,
						p.storeId ?? null,
						p.storeId ?? null,
						p.since ? new Date(p.since).toISOString() : "",
						p.limit + 1,
					),
			);
		return {
			chain: p.chain,
			id: p.id,
			storeId: p.storeId ?? null,
			historical: true,
			observations: rows.slice(0, p.limit).map((r) => OfferSchema.parse(JSON.parse(r.payload))),
			truncated: rows.length > p.limit,
			warnings: [
				"Historical observations collected by this installation, not current checkout prices or a complete price history. Search and detail observations can overlap. Dates and offer conditions must be checked.",
			],
		};
	}
}

let pending: Promise<ObservationStore> | undefined;
export function getObservationStore() {
	pending ??= ObservationStore.open(
		process.env.RUOKA_DB_PATH ??
			fileURLToPath(new URL("../.ruoka-data/observations.sqlite", import.meta.url)),
	).catch((error) => {
		pending = undefined;
		throw error;
	});
	return pending;
}
export async function getPriceHistory(input: z.input<typeof HistoryInputSchema>) {
	return (await getObservationStore()).history(input);
}
