import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore } from "../db.mjs";

test("SQLite survives restart, preserves model/tool history, and excludes failed turns", () => {
	const dir = mkdtempSync(join(tmpdir(), "ruoka-chat-test-"));
	const path = join(dir, "test.sqlite");
	let store = openStore(path);
	try {
		const chat = store.create("gpt-6-luna");
		assert.equal(store.getCity(), null);
		store.setCity("Seinäjoki");
		const first = store.start(chat.id, "Find yogurt", "gpt-6-luna");
		const input = [
			{ role: "user", content: "Find yogurt" },
			{ type: "function_call", call_id: "1" },
			{ type: "function_call_output", call_id: "1", output: "{}" },
		];
		store.finish(first, {
			text: "A pick.",
			input,
			trace: [{ type: "tool_end", name: "search_products" }],
		});
		const failed = store.start(chat.id, "Broken request", "gpt-6.1-terra");
		store.finish(failed, { status: "error", error: "Offline" });
		store.start(chat.id, "Interrupted request", "gpt-6.1-terra");
		store.close();
		store = openStore(path);
		assert.equal(store.getCity(), "Seinäjoki");
		const saved = store.get(chat.id);
		assert.equal(saved.title, "Find yogurt");
		assert.equal(saved.model, "gpt-6.1-terra");
		assert.equal(saved.turns[0].model, "gpt-6-luna");
		assert.equal(saved.turns[0].trace[0].name, "search_products");
		assert.equal(saved.turns[2].status, "error");
		assert.match(saved.turns[2].error, /restarted/);
		assert.deepEqual(store.history(chat.id), input);
		assert.equal("input_json" in saved.turns[0], false);
		assert.equal(store.list().length, 1);
	} finally {
		store.close();
		rmSync(dir, { recursive: true });
	}
});
