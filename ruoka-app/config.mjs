import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

export const appDir = import.meta.dirname;
const envFile = resolve(appDir, ".env");
if (existsSync(envFile)) loadEnvFile(envFile);

export const config = {
	apiKey: process.env.OPENAI_API_KEY?.trim() || "",
	defaultModel: process.env.OPENAI_MODEL?.trim() || "gpt-6-luna",
	port: Number(process.env.PORT || 3210),
	mcpDir: resolve(appDir, "../mcp-ruoka"),
	dataDir: resolve(appDir, "data"),
};
config.models = [
	...new Set([
		config.defaultModel,
		...(process.env.OPENAI_MODELS || "gpt-6-luna,gpt-6.1-terra")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	]),
];
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
	throw new Error("PORT must be between 1 and 65535.");

export function publicError(error) {
	let message =
		error instanceof Error
			? error.message
			: "Something went wrong. Please try again.";
	if (config.apiKey) message = message.replaceAll(config.apiKey, "[redacted]");
	return message.replace(/sk-[\w-]+/g, "[redacted]").slice(0, 600);
}
