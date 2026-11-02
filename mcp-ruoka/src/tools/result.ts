import { logger } from "../logger.ts";

export async function toolResult<T extends object>(run: () => Promise<T> | T) {
	try {
		const result = await run();
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result) }],
			structuredContent: Object.fromEntries(Object.entries(result)),
		};
	} catch (error) {
		logger.error({ err: error }, "Grocery tool failed");
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
				},
			],
			isError: true,
		};
	}
}
