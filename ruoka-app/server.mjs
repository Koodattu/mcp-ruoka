import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runAgent } from "./agent.mjs";
import { cities, resolveCity } from "./cities.mjs";
import { appDir, config, publicError } from "./config.mjs";
import { openStore } from "./db.mjs";
import { createMcp } from "./mcp.mjs";

const assets = new Map([
	["/", ["index.html", "text/html; charset=utf-8"]],
	["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
	["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

function json(res, status, data) {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(data));
}

async function readJson(req) {
	let size = 0;
	const chunks = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 32_000) throw new Error("Request is too large.");
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("Expected a JSON request.");
	}
}

export function createApp({ store, mcp, settings = config, agent = runAgent }) {
	let active;
	const server = createServer(async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
		);
		const host = req.headers.host;
		const port = server.address()?.port;
		if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host))
			return json(res, 403, { error: "Open this app through localhost." });
		if (req.headers.origin && req.headers.origin !== `http://${host}`)
			return json(res, 403, {
				error: "Cross-origin requests are not allowed.",
			});
		const path = new URL(req.url, `http://${host}`).pathname;
		try {
			if (req.method === "GET" && assets.has(path)) {
				const [file, type] = assets.get(path);
				res.writeHead(200, { "Content-Type": type });
				return res.end(readFileSync(resolve(appDir, "public", file)));
			}
			if (req.method === "GET" && path === "/api/config")
				return json(res, 200, {
					defaultModel: settings.defaultModel,
					models: settings.models,
					apiKeyConfigured: Boolean(settings.apiKey),
					city: store.getCity(),
				});
			if (req.method === "GET" && path === "/api/cities")
				return json(res, 200, cities);
			if (req.method === "POST" && path === "/api/settings/city") {
				if (!req.headers["content-type"]?.startsWith("application/json"))
					return json(res, 415, { error: "Use application/json." });
				const body = await readJson(req);
				const city = resolveCity(body?.city);
				store.setCity(city);
				return json(res, 200, { city });
			}
			if (req.method === "GET" && path === "/api/chats")
				return json(res, 200, store.list());
			if (req.method === "POST" && path === "/api/chats") {
				if (!req.headers["content-type"]?.startsWith("application/json"))
					return json(res, 415, { error: "Use application/json." });
				const body = await readJson(req);
				if (!body || !settings.models.includes(body.model))
					return json(res, 400, { error: "Choose an available model." });
				return json(res, 201, store.create(body.model));
			}
			const match = /^\/api\/chats\/([\w-]+)(\/messages)?$/.exec(path);
			if (!match) return json(res, 404, { error: "Not found." });
			const chat = store.get(match[1]);
			if (!chat) return json(res, 404, { error: "Conversation not found." });
			if (req.method === "GET" && !match[2]) return json(res, 200, chat);
			if (req.method !== "POST" || !match[2])
				return json(res, 405, { error: "Method not allowed." });
			if (!req.headers["content-type"]?.startsWith("application/json"))
				return json(res, 415, { error: "Use application/json." });
			const body = await readJson(req);
			if (
				!body ||
				typeof body.message !== "string" ||
				!body.message.trim() ||
				body.message.length > 8000
			)
				return json(res, 400, {
					error: "Enter a message between 1 and 8,000 characters.",
				});
			if (!settings.models.includes(body.model))
				return json(res, 400, { error: "Choose an available model." });
			if (!settings.apiKey)
				return json(res, 503, {
					error: "Set OPENAI_API_KEY in ruoka-app/.env, then restart the app.",
				});
			// The grocery browser is single-client. Keep one active turn across all tabs/chats.
			if (active)
				return json(res, 409, {
					error:
						"Another reply is still running. Wait for it to finish or stop it in the other tab.",
				});
			const controller = new AbortController();
			const turnId = store.start(chat.id, body.message.trim(), body.model);
			active = controller;
			const deadline = setTimeout(
				() =>
					controller.abort(
						new Error(
							"The search reached the four-minute demo limit. Try a narrower request.",
						),
					),
				240_000,
			);
			let text = "";
			const startedAt = Date.now();
			const trace = [];
			res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			res.flushHeaders();
			res.on("close", () => {
				if (!res.writableEnded)
					controller.abort(
						new Error("Reply stopped. You can send another message."),
					);
			});
			const heartbeat = setInterval(() => {
				if (!res.destroyed) res.write(": keepalive\n\n");
			}, 15_000);
			const emit = (event) => {
				if (event.type === "delta") text += event.text;
				if (["tool_start", "tool_end", "timing"].includes(event.type))
					trace.push(event);
				if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
			};
			emit({ type: "start", turnId });
			try {
				const result = await agent({
					model: body.model,
					apiKey: settings.apiKey,
					history: store.history(chat.id),
					message: body.message.trim(),
					city: store.getCity(),
					mcp,
					emit,
					signal: controller.signal,
				});
				controller.signal.throwIfAborted();
				emit({ type: "timing", durationMs: Date.now() - startedAt });
				store.finish(turnId, { ...result, trace });
				emit({ type: "done", text: result.text });
			} catch (error) {
				const message = publicError(
					controller.signal.aborted ? controller.signal.reason : error,
				);
				emit({ type: "timing", durationMs: Date.now() - startedAt });
				store.finish(turnId, {
					text,
					trace,
					status: controller.signal.aborted ? "cancelled" : "error",
					error: message,
				});
				emit({ type: "error", error: message });
			} finally {
				clearInterval(heartbeat);
				clearTimeout(deadline);
				// The provider does not cooperatively abort every browser operation; closing its
				// dedicated process prevents a cancelled search overlapping the next request.
				if (controller.signal.aborted) await mcp.close().catch(() => {});
				active = undefined;
				res.end();
			}
		} catch (error) {
			if (!res.headersSent) json(res, 400, { error: publicError(error) });
			else res.end();
		}
	});
	return {
		server,
		abort: () => active?.abort(new Error("The app is shutting down.")),
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	mkdirSync(config.dataDir, { recursive: true });
	const store = openStore(resolve(config.dataDir, "chat.sqlite"));
	const mcp = createMcp();
	const app = createApp({ store, mcp });
	app.server.listen(config.port, "127.0.0.1", () =>
		console.log(`Ruoka is ready at http://localhost:${config.port}`),
	);
	app.server.on("error", (error) => {
		console.error(publicError(error));
		process.exitCode = 1;
		store.close();
	});
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		app.abort();
		app.server.close();
		await mcp.close().catch(() => {});
		app.server.closeAllConnections();
		// Let an aborted turn finish its SQLite write before closing the store.
		setTimeout(() => {
			store.close();
			process.exit(0);
		}, 100).unref();
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}
