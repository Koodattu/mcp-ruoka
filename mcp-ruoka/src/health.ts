import type { GroceryChain } from "./grocery-types.ts";

interface ProviderHealth {
	requests: number;
	succeeded: number;
	failed: number;
	inFlight: number;
	consecutiveFailures: number;
	lastSuccessAt: string | null;
	lastFailureAt: string | null;
	lastError: string | null;
	lastDurationMs: number | null;
}
const providers = new Map<GroceryChain, ProviderHealth>();
const startedAt = new Date().toISOString();
export async function observeProvider<T>(
	chain: GroceryChain,
	operation: () => Promise<T>,
): Promise<T> {
	let state = providers.get(chain);
	if (!state) {
		state = {
			requests: 0,
			succeeded: 0,
			failed: 0,
			inFlight: 0,
			consecutiveFailures: 0,
			lastSuccessAt: null,
			lastFailureAt: null,
			lastError: null,
			lastDurationMs: null,
		};
		providers.set(chain, state);
	}
	state.requests++;
	state.inFlight++;
	const start = Date.now();
	try {
		const result = await operation();
		state.succeeded++;
		state.consecutiveFailures = 0;
		state.lastSuccessAt = new Date().toISOString();
		return result;
	} catch (error) {
		state.failed++;
		state.consecutiveFailures++;
		state.lastFailureAt = new Date().toISOString();
		state.lastError = error instanceof Error ? error.message : "Provider operation failed";
		throw error;
	} finally {
		state.inFlight--;
		state.lastDurationMs = Date.now() - start;
	}
}
export function getProviderHealth() {
	return {
		startedAt,
		scope: "Live search/detail loads in this process; cache hits do not mark a provider healthy.",
		providers: structuredClone(Object.fromEntries(providers)),
	};
}
