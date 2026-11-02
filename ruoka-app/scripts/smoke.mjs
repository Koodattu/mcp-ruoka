import { parseSse } from "../agent.mjs";
import { config } from "../config.mjs";

const base = `http://127.0.0.1:${config.port}`;
const chatResponse = await fetch(`${base}/api/chats`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ model: config.defaultModel }),
});
if (!chatResponse.ok)
	throw new Error(
		`Create chat failed (${chatResponse.status}). Is the app running?`,
	);
const chat = await chatResponse.json();
let tools = 0;
for (const message of [
	"Etsi Prisma Seinäjoesta (S-kaupat, kauppatunnus 516242633) vaniljajogurtti. Tee vain pieni haku (enintään 5 hakutulosta) ja tarkista yhden sopivan tuotteen tiedot. Kerro hinta, sokeri per 100 g, ja lähdelinkki. Älä tee laajaa vertailua.",
	"Mikä oli juuri löytämäsi tuotteen nimi? Vastaa lyhyesti aiempien tulosten perusteella; älä tee uutta hakua.",
]) {
	const started = Date.now();
	const response = await fetch(`${base}/api/chats/${chat.id}/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model: config.defaultModel, message }),
	});
	if (!response.ok)
		throw new Error(
			`Chat request failed (${response.status}): ${await response.text()}`,
		);
	let answer = "";
	for await (const event of parseSse(response.body)) {
		if (event.type === "tool_start") {
			tools++;
			console.log(`MCP: ${event.name}`);
		}
		if (event.type === "tool_end") {
			const output = JSON.parse(event.output);
			if (output.isError) throw new Error(`MCP tool failed: ${event.name}`);
		}
		if (event.type === "done") answer = event.text;
		if (event.type === "error") throw new Error(event.error);
	}
	if (!answer) throw new Error("No final answer received.");
	console.log(
		JSON.stringify({
			elapsedSeconds: Math.round((Date.now() - started) / 1000),
			answer,
		}),
	);
}
if (!tools) throw new Error("The model did not use MCP.");
const saved = await (await fetch(`${base}/api/chats/${chat.id}`)).json();
if (
	saved.turns.length !== 2 ||
	saved.turns.some((turn) => turn.status !== "complete")
)
	throw new Error("Conversation persistence failed.");
console.log(
	`PASS: ${tools} MCP calls, 2 saved turns. Open ${base}/#${chat.id}`,
);
