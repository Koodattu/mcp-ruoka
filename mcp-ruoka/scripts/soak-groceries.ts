import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import * as z from "zod/v4";

const { values } = parseArgs({
	options: {
		cycles: { type: "string", default: "49" },
		"interval-seconds": { type: "string", default: "1800" },
		"run-id": { type: "string", default: new Date().toISOString().replace(/[:.]/g, "-") },
	},
});
const options = z
	.object({
		cycles: z.coerce.number().int().min(1).max(337),
		"interval-seconds": z.coerce.number().int().min(60).max(3600),
		"run-id": z.string().regex(/^[a-zA-Z0-9_-]+$/),
	})
	.parse(values);
const directory = resolve(".cache", "soak", options["run-id"]);
await mkdir(directory, { recursive: true });
// Never share a browser profile or observations database with the user's MCP process.
process.env.BROWSER_DATA_DIR = resolve(directory, "browser");
process.env.RUOKA_DB_PATH = resolve(directory, "observations.sqlite");
const { closeBrowser, getContext } = await import("../src/browser/session.ts");
const { searchProducts } = await import("../src/groceries.ts");
const { GroceryProductSchema } = await import("../src/product-schema.ts");
const { getObservationStore } = await import("../src/observations.ts");
const k = await import("../src/browser/k-ruoka.ts");
const s = await import("../src/browser/s-kaupat.ts");
const lidl = await import("../src/browser/lidl.ts");
let stopping = false;
process.on("SIGINT", () => {
	stopping = true;
});
process.on("SIGTERM", () => {
	stopping = true;
});
const started = Date.now();
let completedCycles = 0;
let failedChecks = 0;
let recoveredContexts = 0;
let createdRun = false;
const summary = (status: string) => ({
	status,
	pid: process.pid,
	directory,
	startedAt: new Date(started).toISOString(),
	updatedAt: new Date().toISOString(),
	elapsedSeconds: Math.round((Date.now() - started) / 1000),
	completedCycles,
	requestedCycles: options.cycles,
	intervalSeconds: options["interval-seconds"],
	failedChecks,
	recoveredContexts,
	memory: process.memoryUsage(),
});
async function checkpoint(status: string) {
	await writeFile(
		resolve(directory, "status.json"),
		`${JSON.stringify(summary(status), null, 2)}\n`,
	);
}
async function record(event: unknown) {
	const line = `${JSON.stringify(event)}\n`;
	await appendFile(resolve(directory, "checks.jsonl"), line);
	process.stdout.write(line);
}
const targets = [
	{ chain: "k-ruoka", storeId: "N192", query: "vaniljajogurtti" },
	{ chain: "s-kaupat", storeId: "625910120", query: "vaniljajogurtti" },
	{ chain: "lidl", storeId: undefined, query: "juustokierre" },
] as const;

try {
	// Refuse to overwrite an earlier run, including its evidence and browser state.
	await writeFile(resolve(directory, "run.json"), JSON.stringify(summary("starting"), null, 2), {
		flag: "wx",
	});
	createdRun = true;
	await checkpoint("running");
	for (let cycle = 1; cycle <= options.cycles && !stopping; cycle++) {
		const cycleStart = Date.now();
		if (existsSync(resolve(directory, "STOP"))) {
			stopping = true;
			break;
		}
		if (cycle % 3 === 0) {
			// Close the actual context, exercising the unexpected-context-close cleanup path.
			const previous = await getContext();
			await previous.close();
			assert.notEqual(await getContext(), previous);
			recoveredContexts++;
		}
		for (const target of targets) {
			const requestStart = Date.now();
			try {
				const result = await searchProducts({ ...target, limit: 1 });
				const first = result.products[0];
				assert.ok(first, `${target.chain}: empty search result`);
				const detailStart = Date.now();
				// Bypass detail cache so every cycle proves the upstream detail adapter still works.
				const product = GroceryProductSchema.parse(
					target.chain === "lidl"
						? await lidl.getProduct(first.id)
						: await (target.chain === "k-ruoka" ? k : s).getProduct(first.id, target.storeId),
				);
				assert.equal(product.id, first.id);
				assert.equal(product.storeId, target.storeId ?? null);
				assert.ok(
					Date.parse(product.source.fetchedAt) >= detailStart,
					"Detail was not freshly fetched",
				);
				assert.equal(product.availability.stock, "unknown");
				(await getObservationStore()).record([product], "detail");
				const cached = await searchProducts({ ...target, limit: 1 });
				assert.equal(cached.products[0]?.source.fetchedAt, first.source.fetchedAt);
				await record({
					cycle,
					chain: target.chain,
					success: true,
					elapsedMs: Date.now() - requestStart,
					product: product.id,
					source: product.source,
					searchFetchedAt: first.source.fetchedAt,
					nutritionTables: product.nutrition.length,
					memory: process.memoryUsage(),
				});
			} catch (error) {
				failedChecks++;
				await record({
					cycle,
					chain: target.chain,
					success: false,
					elapsedMs: Date.now() - requestStart,
					error: error instanceof Error ? error.message : String(error),
				});
				await closeBrowser().catch(() => {});
			}
		}
		completedCycles++;
		await checkpoint("running");
		const nextStart = cycleStart + options["interval-seconds"] * 1000;
		while (cycle < options.cycles && !stopping && Date.now() < nextStart) {
			await delay(Math.min(5000, nextStart - Date.now()));
			stopping = existsSync(resolve(directory, "STOP"));
		}
	}
	await checkpoint(stopping ? "stopped" : failedChecks ? "completed_with_failures" : "passed");
	if (failedChecks) process.exitCode = 1;
} catch (error) {
	if (!createdRun) throw error;
	await record({ fatal: error instanceof Error ? error.message : String(error) });
	process.exitCode = 1;
	await checkpoint("failed");
} finally {
	await closeBrowser();
}
