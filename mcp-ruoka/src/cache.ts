// TTL + in-flight deduplication follows Jameshooper/mcp-ruoka's memoizedLookup.
// Bound memory and do not cache failed requests or silently return stale prices.
export function memoizedLookup<T>(ttlMs: number, capacity = 100) {
	const entries = new Map<string, { value: T; expires: number }>();
	const pending = new Map<string, Promise<T>>();
	return (key: string, load: () => Promise<T>): Promise<T> => {
		const cached = entries.get(key);
		if (cached && cached.expires > Date.now())
			return Promise.resolve(structuredClone(cached.value));
		entries.delete(key);
		let promise = pending.get(key);
		if (!promise) {
			promise = load()
				.then((value) => {
					while (entries.size >= capacity) {
						const oldest = entries.keys().next().value;
						if (oldest === undefined) break;
						entries.delete(oldest);
					}
					entries.set(key, { value: structuredClone(value), expires: Date.now() + ttlMs });
					return value;
				})
				.finally(() => pending.delete(key));
			pending.set(key, promise);
		}
		return promise.then((value) => structuredClone(value));
	};
}
