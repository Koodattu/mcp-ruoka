import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

test("public documents preserve cache timestamps, expire, and do not cache HTTP failures", async () => {
	process.env.RUOKA_DB_PATH = ":memory:";
	const { readPublicDocument } = await import("../src/public-data.ts");
	let requests = 0;
	let failing = false;
	const server = createServer((_request, response) => {
		requests++;
		response.writeHead(failing ? 503 : 200);
		response.end(`document ${requests}`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const url = `http://127.0.0.1:${address.port}`;
		const original = await readPublicDocument(`${url}/cached`);
		assert.deepEqual(await readPublicDocument(`${url}/cached`), original);
		assert.equal(requests, 1);
		await readPublicDocument(`${url}/expired`, 0);
		await readPublicDocument(`${url}/expired`, 0);
		assert.equal(requests, 3);
		failing = true;
		await assert.rejects(readPublicDocument(`${url}/failed`), /503/);
		failing = false;
		assert.equal((await readPublicDocument(`${url}/failed`)).text, "document 5");
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
