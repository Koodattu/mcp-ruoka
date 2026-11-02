import { createRequire } from "node:module";
import { resolve } from "node:path";
import { config } from "./config.mjs";

// This POC lives beside the MCP project and reuses its installed, locked SDK.
const require = createRequire(resolve(config.mcpDir, "package.json"));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
	StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
const allowed = new Set([
	"rank_products",
	"discover_products",
	"get_products",
	"get_product_availability",
	"get_capabilities",
	"get_preferences",
	"get_stores",
	"get_nearby_stores",
	"search_products",
	"get_product",
	"compare_products",
	"get_price_history",
	"get_provider_health",
	"get_lidl_leaflets",
	"get_manufacturer_label",
	"discover_manufacturer_label",
]);

export function createMcp() {
	let client, connecting;
	let toolList = [];
	async function connect() {
		if (client) return client;
		if (connecting) return connecting;
		connecting = (async () => {
			const next = new Client({ name: "ruoka-chat", version: "0.1.0" });
			const env = {
				LOG_LEVEL: "error",
				BROWSER_DATA_DIR: resolve(config.dataDir, "browser"),
			};
			// Keep the model credential out of the child process. The SDK supplies its OS defaults.
			for (const key of [
				"LOCALAPPDATA",
				"APPDATA",
				"USERPROFILE",
				"TEMP",
				"TMP",
				"PLAYWRIGHT_BROWSERS_PATH",
				"K_RUOKA_STORE_ID",
				"S_KAUPAT_STORE_ID",
			]) {
				if (process.env[key]) env[key] = process.env[key];
			}
			const transport = new StdioClientTransport({
				command: process.execPath,
				args: ["--env-file-if-exists=.env", "src/index.ts", "--stdio"],
				cwd: config.mcpDir,
				env,
				stderr: "pipe",
			});
			transport.stderr?.on("data", () => {});
			next.onclose = () => {
				if (client === next) client = undefined;
			};
			try {
				await next.connect(transport);
				toolList = (await next.listTools()).tools.filter((tool) =>
					allowed.has(tool.name),
				);
				client = next;
				return next;
			} catch (error) {
				await next.close().catch(() => {});
				throw error;
			}
		})().finally(() => {
			connecting = undefined;
		});
		return connecting;
	}
	return {
		async tools() {
			await connect();
			return toolList.map((tool) => ({
				type: "function",
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema,
				strict: false,
			}));
		},
		async call(name, args, signal, onprogress) {
			if (!allowed.has(name)) throw new Error(`Tool is not available: ${name}`);
			const current = await connect();
			return current.callTool({ name, arguments: args }, undefined, {
				signal,
				timeout: name === "rank_products" ? 210_000 : 150_000,
				onprogress,
			});
		},
		async close() {
			const current = client;
			client = undefined;
			if (current) await current.close();
		},
	};
}
