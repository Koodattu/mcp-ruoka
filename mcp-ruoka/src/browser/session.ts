import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { logger } from "../logger.ts";

chromium.use(StealthPlugin());
const dataDir =
	process.env.BROWSER_DATA_DIR ?? join(import.meta.dirname, "..", "..", ".browser-data");
let context: BrowserContext | null = null;
let launchPromise: Promise<BrowserContext> | null = null;
const pages = new Map<string, Promise<Page>>();
let buildNumber: string | null = null;

export async function getContext(): Promise<BrowserContext> {
	if (process.platform === "win32" && process.versions.bun) {
		throw new Error(
			"Playwright startup hangs under Bun on this Windows setup. Use Node 24 for the CLI or MCP --stdio.",
		);
	}
	if (context) return context;
	if (!launchPromise) {
		logger.info({ dataDir }, "Launching browser");
		launchPromise = chromium
			.launchPersistentContext(dataDir, {
				headless: true,
				locale: "fi-FI",
				timeout: 30_000,
			})
			.then((created) => {
				context = created;
				created.setDefaultTimeout(20_000);
				created.setDefaultNavigationTimeout(30_000);
				created.on("close", () => {
					if (context === created) {
						context = null;
						pages.clear();
						buildNumber = null;
					}
				});
				return created;
			})
			.finally(() => {
				launchPromise = null;
			});
	}
	return launchPromise;
}

export async function getOriginPage(origin: string): Promise<Page> {
	let pending = pages.get(origin);
	if (!pending) {
		pending = (async () => {
			const page = await (await getContext()).newPage();
			try {
				const response = await page.goto(
					origin === "https://www.k-ruoka.fi" ? `${origin}/kauppa` : origin,
					{ waitUntil: "domcontentloaded" },
				);
				await page.waitForFunction('document.title !== "Just a moment..."', undefined, {
					timeout: 15_000,
				});
				if (!response?.ok())
					throw new Error(`Browser initialization HTTP ${response?.status()} for ${origin}`);
				if (origin === "https://www.k-ruoka.fi") {
					buildNumber = await response.headerValue("k-ruoka-build");
					buildNumber ??=
						(await page.locator('script[src*="/assets/b-"]').first().getAttribute("src"))?.match(
							/\/assets\/b-(\d+)\//,
						)?.[1] ?? null;
					buildNumber ??= await page.evaluate<string | null>(
						'document.documentElement.innerHTML.match(/"release":"(\\d+)"/)?.[1] ?? null',
					);
				}
				return page;
			} catch (error) {
				await page.close().catch(() => {});
				throw error;
			}
		})().catch((error) => {
			pages.delete(origin);
			throw error;
		});
		pages.set(origin, pending);
	}
	const page = await pending;
	if (page.isClosed()) {
		pages.delete(origin);
		return getOriginPage(origin);
	}
	return page;
}

export function getPage() {
	return getOriginPage("https://www.k-ruoka.fi");
}
export function getBuildNumber(): string {
	if (!buildNumber)
		throw new Error("K-Ruoka build number was not found; the website may have changed");
	return buildNumber;
}

export async function closeBrowser(): Promise<void> {
	const current = context ?? (await launchPromise);
	await current?.close();
	context = null;
	pages.clear();
	buildNumber = null;
}

export async function refreshOrigin(origin: string): Promise<void> {
	const pending = pages.get(origin);
	pages.delete(origin);
	const page = await pending?.catch(() => null);
	await page?.close().catch(() => {});
	if (origin === "https://www.k-ruoka.fi") buildNumber = null;
}

// Never remove the persistent profile to recover from an unrelated launch/network failure.
export async function resetSession(): Promise<void> {
	await closeBrowser();
}
