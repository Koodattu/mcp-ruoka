import assert from "node:assert/strict";
import test from "node:test";
import { getProviderHealth, observeProvider } from "../src/health.ts";

test("provider health records a failed load and subsequent recovery without losing failure evidence", async () => {
	await assert.rejects(
		observeProvider("k-ruoka", async () => {
			throw new Error("Temporary failure");
		}),
	);
	assert.equal(getProviderHealth().providers["k-ruoka"]?.consecutiveFailures, 1);
	assert.equal(await observeProvider("k-ruoka", async () => "recovered"), "recovered");
	const state = getProviderHealth().providers["k-ruoka"];
	assert.equal(state?.requests, 2);
	assert.equal(state?.failed, 1);
	assert.equal(state?.succeeded, 1);
	assert.equal(state?.consecutiveFailures, 0);
	assert.equal(state?.inFlight, 0);
	assert.ok(state?.lastFailureAt);
	assert.ok(state?.lastSuccessAt);
});
