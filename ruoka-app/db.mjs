import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export function openStore(path) {
	const db = new DatabaseSync(path);
	db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
      model TEXT NOT NULL, user_text TEXT NOT NULL, assistant_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL, error TEXT, trace_json TEXT NOT NULL DEFAULT '[]',
      input_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turns_chat ON turns(chat_id);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
	// A process restart must not leave a chat looking as though it is still running.
	db.prepare(
		"UPDATE turns SET status = 'error', error = 'The app restarted before this reply finished. Please send your message again.' WHERE status = 'running'",
	).run();
	return {
		close: () => db.close(),
		getCity: () =>
			db.prepare("SELECT value FROM settings WHERE key = 'city'").get()
				?.value ?? null,
		setCity(city) {
			db.prepare(
				"INSERT INTO settings VALUES ('city', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			).run(city);
		},
		list: () =>
			db
				.prepare("SELECT * FROM chats ORDER BY updated_at DESC, rowid DESC")
				.all(),
		get(id) {
			const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(id);
			if (!chat) return null;
			return {
				...chat,
				turns: db
					.prepare("SELECT * FROM turns WHERE chat_id = ? ORDER BY rowid")
					.all(id)
					.map(({ trace_json, input_json, ...turn }) => ({
						...turn,
						trace: JSON.parse(trace_json),
					})),
			};
		},
		create(model) {
			const id = randomUUID(),
				now = new Date().toISOString();
			db.prepare("INSERT INTO chats VALUES (?, ?, ?, ?, ?)").run(
				id,
				"New conversation",
				model,
				now,
				now,
			);
			return this.get(id);
		},
		history(id) {
			// Keep complete tool-call/result pairs. Failed and cancelled turns are never replayed.
			return db
				.prepare(
					"SELECT input_json FROM turns WHERE chat_id = ? AND status = 'complete' ORDER BY rowid",
				)
				.all(id)
				.flatMap((row) => JSON.parse(row.input_json));
		},
		start(id, text, model) {
			const turnId = randomUUID(),
				now = new Date().toISOString();
			db.prepare(
				"INSERT INTO turns (id, chat_id, model, user_text, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)",
			).run(turnId, id, model, text, now);
			db.prepare(
				"UPDATE chats SET model = ?, updated_at = ?, title = CASE WHEN title = 'New conversation' THEN ? ELSE title END WHERE id = ?",
			).run(model, now, text.slice(0, 64), id);
			return turnId;
		},
		finish(
			id,
			{ text = "", trace = [], input = [], status = "complete", error = null },
		) {
			db.prepare(
				"UPDATE turns SET assistant_text = ?, trace_json = ?, input_json = ?, status = ?, error = ? WHERE id = ?",
			).run(
				text,
				JSON.stringify(trace),
				JSON.stringify(input),
				status,
				error,
				id,
			);
		},
	};
}
