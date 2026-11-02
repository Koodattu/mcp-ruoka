import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// Dedicated profile and local test origin; never close a user's other browser sessions.
process.env.BROWSER_DATA_DIR = fileURLToPath(
	new URL("../.cache/recovery-browser", import.meta.url),
);
const { getContext, getOriginPage, closeBrowser } = await import("../src/browser/session.ts");
const server = createServer((_req, res) => {
	res.setHeader("content-type", "text/html");
	res.end("<html><head><title>Recovery check</title></head><body>ready</body></html>");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
try {
	const first = await getOriginPage(origin);
	assert.equal(await first.locator("body").innerText(), "ready");
	await first.close();
	const second = await getOriginPage(origin);
	assert.notEqual(second, first);
	assert.equal(await second.locator("body").innerText(), "ready");
	const context = await getContext();
	await context.close();
	const recovered = await getOriginPage(origin);
	assert.notEqual(await getContext(), context);
	assert.equal(await recovered.locator("body").innerText(), "ready");
	process.stdout.write(
		`${JSON.stringify({ pageClosureRecovery: true, contextClosureRecovery: true, retailerNetworkUsed: false })}\n`,
	);
} finally {
	await closeBrowser();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}
