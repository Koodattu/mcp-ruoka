import * as z from "zod/v4";
import { getOriginPage } from "./session.ts";

const Envelope = z.object({
	status: z.number(),
	body: z.string(),
	retryAfter: z.string().nullable(),
});
const preferBrowserUntil = new Map<string, number>();
const tails = new Map<string, Promise<unknown>>();
const cooldowns = new Map<string, { until: number; status: number }>();

export class RetailerHttpError extends Error {
	status: number;
	constructor(host: string, status: number) {
		super(`${host} HTTP ${status}`);
		this.status = status;
	}
}

// Per-retailer serialization bounds load; every retry has its own timeout.
export async function requestJson(
	url: URL,
	origin: string,
	options: {
		browser?: boolean;
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	} = {},
): Promise<unknown> {
	const previous = tails.get(origin) ?? Promise.resolve();
	const task = previous
		.catch(() => {})
		.then(async () => {
			const cooldown = cooldowns.get(origin);
			if (cooldown && cooldown.until > Date.now())
				throw new RetailerHttpError(url.hostname, cooldown.status);
			cooldowns.delete(origin);
			let browser = options.browser || (preferBrowserUntil.get(origin) ?? 0) > Date.now();
			for (let attempt = 0; attempt < 3; attempt++) {
				let response: z.infer<typeof Envelope>;
				try {
					if (browser) {
						const page = await getOriginPage(origin);
						response = Envelope.parse(
							await page.evaluate(
								async ({ url, method, headers, body }) => {
									const res = await fetch(url, {
										method,
										headers,
										body,
										signal: AbortSignal.timeout(20_000),
									});
									return {
										status: res.status,
										body: await res.text(),
										retryAfter: res.headers.get("retry-after"),
									};
								},
								{
									url: url.toString(),
									method: options.method ?? "GET",
									headers: options.headers ?? {},
									body: options.body,
								},
							),
						);
					} else {
						const res = await fetch(url, {
							method: options.method ?? "GET",
							headers: options.headers,
							body: options.body,
							signal: AbortSignal.timeout(20_000),
						});
						response = {
							status: res.status,
							body: await res.text(),
							retryAfter: res.headers.get("retry-after"),
						};
					}
				} catch (error) {
					if (
						attempt >= 2 ||
						!(error instanceof Error) ||
						!["TypeError", "TimeoutError", "AbortError"].includes(error.name)
					)
						throw error;
					await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
					continue;
				}
				if (response.status === 403 && !browser) {
					browser = true;
					preferBrowserUntil.set(origin, Date.now() + 10 * 60_000);
					continue;
				}
				if ([429, 502, 503, 504].includes(response.status)) {
					const delay = retryDelay(response.retryAfter, attempt);
					cooldowns.set(origin, { until: Date.now() + delay, status: response.status });
					// Do not retry earlier than a long server-requested cooldown.
					if (delay > 30_000 || attempt >= 2)
						throw new RetailerHttpError(url.hostname, response.status);
					await new Promise((resolve) => setTimeout(resolve, delay));
					continue;
				}
				if (response.status < 200 || response.status >= 300)
					throw new RetailerHttpError(url.hostname, response.status);
				try {
					return JSON.parse(response.body);
				} catch {
					throw new Error(`${url.hostname} returned non-JSON data`);
				}
			}
			throw new Error(`${url.hostname} request retries exhausted`);
		});
	tails.set(origin, task);
	try {
		return await task;
	} finally {
		if (tails.get(origin) === task) tails.delete(origin);
	}
}

export function retryDelay(header: string | null, attempt: number, now = Date.now()): number {
	if (header != null) {
		if (/^\d+$/.test(header.trim())) return Number(header) * 1000;
		const time = Date.parse(header);
		if (Number.isFinite(time)) return Math.max(0, time - now);
	}
	return 1000 * (attempt + 1);
}
