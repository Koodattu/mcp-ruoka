import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config.mjs";

// Uses the real frontend, but intercepts every API request: no model calls or saved user data.
export async function checkUi(
	browser,
	base = `http://127.0.0.1:${config.port}`,
) {
	const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
	const errors = [],
		requests = [];
	let city = null;
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/api/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/api/config")
			return route.fulfill({
				json: {
					city,
					apiKeyConfigured: true,
					defaultModel: "gpt-6-luna",
					models: ["gpt-6-luna", "gpt-6.1-terra"],
				},
			});
		if (path === "/api/cities")
			return route.fulfill({ json: ["Helsinki", "Seinäjoki"] });
		if (path === "/api/settings/city") {
			const value = route.request().postDataJSON().city;
			if (!["Helsinki", "Seinäjoki"].includes(value))
				return route.fulfill({
					status: 400,
					json: { error: "City not found. Choose a Finnish city." },
				});
			city = value;
			return route.fulfill({ json: { city } });
		}
		if (path === "/api/chats")
			return route.fulfill({
				json: route.request().method() === "POST" ? { id: "ui-test" } : [],
			});
		if (path.endsWith("/messages")) {
			requests.push({ ...route.request().postDataJSON(), city });
			return route.fulfill({
				status: 503,
				json: { error: "Test provider unavailable" },
			});
		}
		return route.fulfill({
			status: 404,
			json: { error: "Unknown fixture endpoint" },
		});
	});
	try {
		await page.goto(base);
		await page
			.locator("#city-options option")
			.first()
			.waitFor({ state: "attached" });
		await page.getByLabel("Shopping city").fill("Not a city");
		await page.getByLabel("Shopping city").press("Enter");
		await page.locator('#city[aria-invalid="true"]').waitFor();
		assert.equal(city, null);
		await page.getByLabel("Shopping city").fill("Seinäjoki");
		await page.getByLabel("Shopping city").press("Tab");
		await page.waitForFunction(() =>
			document
				.querySelector("#city-help")
				.textContent.includes("Saved: Seinäjoki"),
		);
		assert.equal(city, "Seinäjoki");
		await page.reload();
		await page.waitForFunction(
			() => document.querySelector("#city").value === "Seinäjoki",
		);
		await page
			.getByRole("button", { name: "New conversation", exact: false })
			.click();
		assert.equal(
			await page.getByLabel("Shopping city").inputValue(),
			"Seinäjoki",
		);
		await page.getByRole("button", { name: /Look a little closer/ }).click();
		const draft = await page.locator("#message").inputValue();
		assert.ok(!draft.includes("Seinäjoki") && !draft.includes("60100"));
		await page.getByLabel("Shopping city").fill("Helsinki");
		await page.locator("#model").selectOption("gpt-6.1-terra");
		await page
			.getByRole("button", { name: "Send message", exact: true })
			.click();
		await page.locator("#error").waitFor({ state: "visible" });
		assert.equal(
			requests[0].city,
			"Helsinki",
			"Sending saves a pending city edit before the message.",
		);
		assert.equal(requests[0].model, "gpt-6.1-terra");
		assert.equal(await page.locator("#message").inputValue(), draft);
		assert.equal(
			await page.evaluate(
				() => document.documentElement.scrollWidth > innerWidth,
			),
			false,
		);
		assert.deepEqual(errors, []);
		return "PASS city validation, reload/new-chat persistence, city edit before send, model selection, draft recovery and mobile reflow";
	} finally {
		await page.close();
	}
}

export async function checkPresentation(
	browser,
	base = `http://127.0.0.1:${config.port}`,
) {
	const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const products = [
		{
			name: "Persikka",
			source: { url: "https://example.com/peach" },
			imageUrl: "https://images.example.com/peach.png",
			store: { name: "Prisma Seinäjoki" },
			availability: { inStore: true, online: false, stock: "unknown" },
			otherOffers: [
				{
					source: {
						url: "https://example.com/peach",
						fetchedAt: "2026-11-02T10:00:00Z",
					},
					store: { name: "Päivölä" },
					availability: { inStore: false, online: false, stock: "unknown" },
				},
				{
					source: { url: "https://example.com/other-shop" },
					imageUrl: "https://images.example.com/other-shop.png",
				},
			],
		},
		{
			name: "Mustikka",
			source: { url: "https://example.com/blueberry" },
			imageUrl: "https://images.example.com/missing.png",
		},
		{
			name: "Unsafe",
			source: { url: "https://example.com/unsafe" },
			imageUrl: "javascript:alert(1)",
		},
	];
	const text = `Tarkistetuista jogurteista **persikka** sisältää eniten proteiinia.

| Jogurtti | Proteiini / 100 g | Sokerit / 100 g | Hinta |
|---|---:|---:|---:|
| [Persikka](https://example.com/peach) | 4,9 g | 12 g | 1,25 € (8,33 €/kg) |
| [Mustikka](https://example.com/blueberry) | 4,8 g | 11 g | 1,25 € (8,33 €/kg) |

Hinnat: **Prisma Seinäjoki**. [Unsafe](https://example.com/unsafe)
[Other shop](https://example.com/other-shop) [Prepared label](https://example.com/prepared) [Leader](https://example.com/leader)
<img src=x onerror=alert(1)> [Bad](javascript:alert)

Name | Note
--- | ---
Plain | A \\| B`;
	const trace = [
		{
			type: "tool_start",
			id: "comparison",
			name: "compare_groceries",
			arguments: "{}",
		},
		{
			type: "tool_end",
			id: "comparison",
			name: "compare_groceries",
			durationMs: 50,
			output: JSON.stringify({
				data: {
					products: [],
					leaders: [
						{
							product: {
								source: { url: "https://example.com/leader" },
								imageUrl: "https://images.example.com/leader.png",
							},
						},
					],
					coverage: {
						complete: false,
						evaluated: 115,
						distinctProducts: 115,
						listings: 173,
						labelsReused: 100,
						labelsFetched: 15,
						labelRequests: 2,
						unresolved: 4,
						frontier: 11,
					},
					needsPriority: true,
					rule: {
						mode: "tradeoffs",
						sort: [{ metric: "price", direction: "asc" }],
					},
				},
			}),
		},
		{ type: "tool_start", id: "c1", name: "find_groceries", arguments: "{}" },
		{
			type: "tool_end",
			id: "c1",
			name: "find_groceries",
			durationMs: 100,
			output: JSON.stringify({
				data: {
					products,
					unverified: [
						{
							source: { url: "https://example.com/prepared" },
							imageUrl: "https://images.example.com/prepared.png",
						},
					],
				},
			}),
		},
	];
	await page.route("https://images.example.com/**", (route) =>
		route.request().url().endsWith("missing.png")
			? route.fulfill({ status: 404, body: "Missing" })
			: route.fulfill({
					contentType: "image/svg+xml",
					body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="green"/></svg>',
				}),
	);
	await page.route("**/api/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/api/config")
			return route.fulfill({
				json: {
					city: "Seinäjoki",
					apiKeyConfigured: true,
					defaultModel: "gpt-6.1-terra",
					models: ["gpt-6.1-terra"],
				},
			});
		if (path === "/api/cities") return route.fulfill({ json: ["Seinäjoki"] });
		if (path === "/api/chats") return route.fulfill({ json: [] });
		return route.fulfill({
			json: {
				id: "presentation",
				model: "gpt-6.1-terra",
				turns: [
					{
						user_text: "Vertaa jogurtteja",
						assistant_text: text,
						trace,
						status: "complete",
						model: "gpt-6.1-terra",
					},
				],
			},
		});
	});
	try {
		await page.goto(`${base}/#presentation`);
		await page.locator("table").first().waitFor();
		assert.equal(await page.locator("table").count(), 2);
		assert.equal(
			await page.locator("table").first().locator("th[scope=col]").count(),
			4,
		);
		assert.equal(
			await page.locator("table").first().locator("tbody tr").count(),
			2,
		);
		assert.equal(
			await page.locator("table").last().locator("td").last().textContent(),
			"A | B",
		);
		assert.equal(
			await page.locator('a[href="https://example.com/peach"]').count(),
			1,
		);
		await page.waitForFunction(
			() => document.querySelector('img[src$="peach.png"]')?.naturalWidth > 0,
		);
		await page.waitForFunction(
			() => !document.querySelector('img[src$="missing.png"]'),
		);
		assert.equal(await page.locator(".answer img").count(), 4);
		assert.match(
			await page.locator(".comparison-coverage summary").textContent(),
			/115\/115 products evaluated.*173 store listings.*4 unresolved/,
		);
		await page.locator(".comparison-coverage summary").click();
		assert.match(
			await page.locator(".comparison-coverage").textContent(),
			/2 retailer detail requests/,
		);
		assert.match(
			await page.locator(".comparison-coverage").textContent(),
			/package price, lowest first/,
		);
		assert.match(
			await page.locator(".comparison-coverage").textContent(),
			/11 products trade advantages/,
		);
		await page.locator(".offer-status summary").click();
		assert.match(
			await page.locator(".offer-status").textContent(),
			/Prisma Seinäjoki: In store: available/,
		);
		assert.match(
			await page.locator(".offer-status").textContent(),
			/Päivölä: In store: unavailable/,
		);
		assert.match(
			await page.locator(".offer-status").textContent(),
			/Online: unavailable/,
		);
		assert.equal(
			await page
				.locator('a[href="https://example.com/other-shop"] img')
				.count(),
			1,
		);
		assert.equal(
			await page.locator('a[href="https://example.com/prepared"] img').count(),
			1,
		);
		assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
		assert.ok(
			(await page.locator(".answer").textContent()).includes(
				"<img src=x onerror=alert(1)>",
			),
		);
		for (const width of [320, 390, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			assert.equal(
				await page.evaluate(
					() => document.documentElement.scrollWidth > innerWidth,
				),
				false,
			);
		}
		assert.deepEqual(errors, []);
		return "PASS saved comparison tables, escaped pipes, source-backed images, failed-image fallback, safe text and responsive overflow";
	} finally {
		await page.close();
	}
}

export async function checkProgress(
	browser,
	base = `http://127.0.0.1:${config.port}`,
) {
	const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	let state = "empty",
		release;
	const finished = {
		user_text: "Find chicken",
		assistant_text: "Here is the comparison.",
		model: "gpt-6.1-terra",
		status: "complete",
		trace: [{ type: "timing", durationMs: 125000 }],
	};
	await page.route("**/api/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/api/config")
			return route.fulfill({
				json: {
					city: "Seinäjoki",
					apiKeyConfigured: true,
					defaultModel: "gpt-6.1-terra",
					models: ["gpt-6.1-terra"],
				},
			});
		if (path === "/api/cities") return route.fulfill({ json: ["Seinäjoki"] });
		if (path === "/api/chats")
			return route.fulfill({
				json: route.request().method() === "POST" ? { id: "progress" } : [],
			});
		if (path.endsWith("/messages")) {
			await new Promise((resolve) => {
				release = resolve;
			});
			state = "complete";
			return route.fulfill({
				contentType: "text/event-stream",
				body: [
					{ type: "status", text: "Checking selected labels…" },
					{ type: "delta", text: finished.assistant_text },
					{ type: "timing", durationMs: 125000 },
					{ type: "done", text: finished.assistant_text },
				]
					.map((e) => `data: ${JSON.stringify(e)}\n\n`)
					.join(""),
			});
		}
		return route.fulfill({
			json: {
				id: "progress",
				model: "gpt-6.1-terra",
				turns:
					state === "complete"
						? [finished]
						: state === "running"
							? [
									{
										...finished,
										status: "running",
										assistant_text: "",
										trace: [],
										created_at: new Date(Date.now() - 65000).toISOString(),
									},
								]
							: [],
			},
		});
	});
	try {
		await page.goto(base);
		await page.locator("#message").fill("Find chicken");
		await page
			.getByRole("button", { name: "Send message", exact: true })
			.click();
		await page.waitForFunction(() =>
			document.querySelector(".progress-time")?.textContent.includes("0m 1s"),
		);
		assert.equal(await page.locator(".turn .turn-progress").count(), 1);
		assert.equal(
			await page.locator(".composer-area .turn-progress, #activity").count(),
			0,
		);
		assert.equal(
			await page.locator(".user-message").textContent(),
			"Find chicken",
		);
		release();
		await page.waitForFunction(() =>
			document
				.querySelector(".turn-progress")
				?.textContent.includes("Completed · 2m 5s"),
		);
		await page.reload();
		await page.getByText("Completed · 2m 5s", { exact: true }).waitFor();
		state = "running";
		await page.reload();
		await page.waitForFunction(() =>
			document.querySelector(".progress-time")?.textContent.includes("1m 5s"),
		);
		await page.getByRole("button", { name: /New conversation/ }).click();
		assert.equal(await page.locator(".turn-progress").count(), 0);
		state = "empty";
		await page.locator("#message").fill("Find chicken");
		await page
			.getByRole("button", { name: "Send message", exact: true })
			.click();
		await page.getByRole("button", { name: /Stop/ }).click();
		await page
			.getByRole("button", { name: "Send message", exact: true })
			.waitFor();
		assert.equal(await page.locator("#message").inputValue(), "Find chicken");
		assert.equal(await page.locator(".turn-progress").count(), 0);
		release?.();
		assert.deepEqual(errors, []);
		return "PASS in-chat live timer, completed duration persistence, running-reply reload, navigation and stop recovery";
	} finally {
		release?.();
		await page.close();
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	const require = createRequire(resolve(config.mcpDir, "package.json"));
	const browser = await require("playwright").chromium.launch({
		headless: true,
	});
	try {
		console.log(await checkUi(browser));
		console.log(await checkPresentation(browser));
		console.log(await checkProgress(browser));
	} finally {
		await browser.close();
	}
}
