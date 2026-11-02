const $ = (selector) => document.querySelector(selector);
const productImages = new Map();
const productOffers = new Map();
const progressTimers = new Set();
let activeTurn;
function clearProgressTimers() {
	for (const timer of progressTimers) clearInterval(timer);
	progressTimers.clear();
}
function duration(ms) {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function setActivity(text) {
	activeTurn?.setStatus(text);
}

function rememberProductImages(result) {
	if (result.isError) return;
	const data = result.data;
	const products = Array.isArray(data?.products)
		? [...data.products]
		: [data?.product ?? data];
	if (Array.isArray(data?.unverified)) products.push(...data.unverified);
	for (const product of products) {
		if (Array.isArray(product?.otherOffers))
			products.push(...product.otherOffers);
		try {
			const source = new URL(product.source.url);
			if (source.protocol === "https:" && product.availability) {
				const offers = productOffers.get(source.href) ?? new Map();
				offers.set(
					`${product.store?.chain ?? product.chain}:${product.store?.id ?? product.storeId ?? product.store?.name ?? ""}`,
					product,
				);
				productOffers.set(source.href, offers);
			}
			const image = new URL(product.imageUrl);
			if (source.protocol === "https:" && image.protocol === "https:")
				productImages.set(source.href, image.href);
		} catch {
			// Missing or invalid retailer images leave an ordinary product link.
		}
	}
}
const ui = {
	list: $("#chat-list"),
	welcome: $("#welcome"),
	messages: $("#messages"),
	model: $("#model"),
	input: $("#message"),
	error: $("#error"),
	scroll: $("#scroll-area"),
	city: $("#city"),
};
let currentId = null,
	busy = false,
	controller,
	settings,
	citySave,
	loadVersion = 0;
const toolLabels = {
	discover_groceries: "Browsing product candidates",
	inspect_groceries: "Checking selected product labels",
	get_product_availability: "Checking store availability",
	find_groceries: "Finding products and checking labels",
	get_preferences: "Reading your store preferences",
	get_capabilities: "Checking grocery sources",
	get_stores: "Finding stores",
	get_nearby_stores: "Finding nearby stores",
	search_products: "Searching products",
	get_product: "Reading a product label",
	compare_products: "Comparing products and prices",
	get_price_history: "Checking price observations",
	get_provider_health: "Checking source status",
	get_lidl_leaflets: "Checking Lidl leaflets",
	get_manufacturer_label: "Reading a manufacturer label",
	discover_manufacturer_label: "Finding a manufacturer label",
};

function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

// A deliberately small Markdown renderer. All model/user text becomes text nodes;
// only http(s) links are enabled, and raw HTML is never interpreted.
function inline(text, parent) {
	const pattern =
		/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		parent.append(document.createTextNode(text.slice(last, match.index)));
		if (match[1]) {
			const link = element("a", "", match[1]);
			link.href = match[2];
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			const imageUrl = productImages.get(link.href);
			if (imageUrl) {
				const image = element("img", "product-thumbnail");
				image.src = imageUrl;
				image.alt = "";
				image.width = image.height = 64;
				image.loading = "lazy";
				image.decoding = "async";
				image.referrerPolicy = "no-referrer";
				link.className = "product-link";
				link.replaceChildren(image, element("span", "", match[1]));
				image.addEventListener(
					"error",
					() => {
						image.remove();
						link.classList.remove("product-link");
					},
					{ once: true },
				);
			}
			parent.append(link);
			const offers = [...(productOffers.get(link.href)?.values() ?? [])];
			if (offers.length) {
				const offer = offers[0];
				const info = element("details", "offer-status");
				const available = offer.availability.inStore;
				const store = offer.store?.name;
				const label =
					available === true
						? "Retailer: available"
						: available === false
							? "Retailer: unavailable"
							: "Availability not reported";
				info.append(
					element(
						"summary",
						"",
						offers.length > 1
							? `Availability · ${offers.length} stores`
							: `${store ? `${store} · ` : ""}${label}`,
					),
				);
				for (const offer of offers) {
					const checked = new Date(offer.source.fetchedAt);
					const online = offer.availability.online;
					info.append(
						element(
							"span",
							"",
							`${offer.store?.name ? `${offer.store.name}: ` : ""}In store: ${offer.availability.inStore === true ? "available" : offer.availability.inStore === false ? "unavailable" : "not reported"}. Checked ${Number.isNaN(checked.getTime()) ? "at an unknown time" : checked.toLocaleString()}. Online: ${online === true ? "available" : online === false ? "unavailable" : "not reported"}. Retailer listing information, not a live shelf count.`,
						),
					);
				}
				parent.append(info);
			}
		} else
			parent.append(
				element(match[3] ? "strong" : "code", "", match[3] || match[4]),
			);
		last = match.index + match[0].length;
	}
	parent.append(document.createTextNode(text.slice(last)));
}

function tableCells(line) {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/(?<!\\)\|$/, "")
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim().replaceAll("\\|", "|"));
}

function markdown(text, target) {
	target.replaceChildren();
	target.style.whiteSpace = "";
	let paragraph, list;
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!line.trim()) {
			paragraph = list = null;
			continue;
		}
		const headers = tableCells(line);
		const separators = tableCells(lines[index + 1] ?? "");
		if (
			line.includes("|") &&
			headers.length === separators.length &&
			separators.every((cell) => /^:?-{3,}:?$/.test(cell))
		) {
			const region = element("div", "comparison-scroll");
			region.tabIndex = 0;
			region.setAttribute("role", "region");
			region.setAttribute("aria-label", "Product comparison");
			const table = element("table", "comparison-table");
			const head = element("thead"),
				body = element("tbody");
			const addRow = (cells, parent, heading = false) => {
				const row = element("tr");
				headers.forEach((_, column) => {
					const cell = element(heading ? "th" : "td");
					if (heading) cell.scope = "col";
					if (separators[column].endsWith(":"))
						cell.className = separators[column].startsWith(":")
							? "align-center"
							: "align-right";
					inline(cells[column] ?? "", cell);
					row.append(cell);
				});
				parent.append(row);
			};
			addRow(headers, head, true);
			index++;
			while (
				index + 1 < lines.length &&
				lines[index + 1].includes("|") &&
				lines[index + 1].trim()
			)
				addRow(tableCells(lines[++index]), body);
			table.append(head, body);
			region.append(table);
			target.append(region);
			paragraph = list = null;
			continue;
		}
		const heading = /^(#{1,4})\s+(.+)$/.exec(line);
		const item = /^(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
		if (heading) {
			const node = element("h3");
			inline(heading[2], node);
			target.append(node);
			paragraph = list = null;
		} else if (item) {
			if (!list) {
				list = element(/^\d/.test(line) ? "ol" : "ul");
				target.append(list);
			}
			const node = element("li");
			inline(item[1], node);
			list.append(node);
			paragraph = null;
		} else {
			list = null;
			if (!paragraph) {
				paragraph = element("p");
				target.append(paragraph);
			} else paragraph.append(element("br"));
			inline(line, paragraph);
		}
	}
}

function showError(message = "") {
	ui.error.textContent = message;
	ui.error.hidden = !message;
}
function scrollDown(force = false) {
	if (
		force ||
		ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 160
	)
		ui.scroll.scrollTop = ui.scroll.scrollHeight;
}
function setBusy(value) {
	busy = value;
	$("#send").hidden = value;
	$("#stop").hidden = !value;
	ui.model.disabled = value;
	ui.city.disabled = value || Boolean(citySave);
	$("#new-chat").disabled = value;
	ui.messages.setAttribute("aria-busy", String(value));
	document
		.querySelectorAll(".chat-link, .suggestions button")
		.forEach((button) => {
			button.disabled = value;
		});
	if (!value) activeTurn = null;
}

async function api(path, options) {
	const response = await fetch(path, options);
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || "The request failed.");
	return data;
}

function saveCity() {
	if (citySave) return citySave;
	ui.city.disabled = true;
	citySave = api("/api/settings/city", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ city: ui.city.value }),
	})
		.then((result) => {
			settings.city = result.city;
			ui.city.value = result.city;
			ui.city.removeAttribute("aria-invalid");
			$("#city-help").textContent =
				`Saved: ${result.city}. You can name a different city in a message.`;
		})
		.finally(() => {
			citySave = null;
			ui.city.disabled = busy;
		});
	return citySave;
}

async function commitCity(event) {
	event.preventDefault();
	if (busy || !settings) return;
	try {
		await saveCity();
		showError();
	} catch (error) {
		ui.city.setAttribute("aria-invalid", "true");
		$("#city-help").textContent = error.message;
		showError(error.message);
	}
}
$("#city-form").addEventListener("submit", commitCity);
ui.city.addEventListener("change", commitCity);

async function refreshList() {
	const chats = await api("/api/chats");
	ui.list.replaceChildren();
	if (!chats.length)
		ui.list.append(
			element("p", "history-empty", "Your conversations will appear here."),
		);
	for (const chat of chats) {
		const button = element(
			"button",
			`chat-link${chat.id === currentId ? " active" : ""}`,
			chat.title,
		);
		button.title = chat.title;
		button.disabled = busy;
		if (chat.id === currentId) button.setAttribute("aria-current", "page");
		button.addEventListener("click", () => {
			if (!busy) loadChat(chat.id).catch((error) => showError(error.message));
		});
		ui.list.append(button);
	}
}

function addTurn(turn) {
	const node = element("article", "turn");
	node.append(element("div", "user-message", turn.user_text));
	const assistant = element("div", "assistant");
	const heading = element("div", "assistant-heading");
	heading.append(
		element("span", "mini-mark", "r."),
		document.createTextNode("Ruoka"),
		element("small", "", turn.model),
	);
	const trace = element("details", "tool-trace");
	trace.hidden = true;
	const summary = element("summary", "", "Grocery search");
	const items = element("div", "trace-items");
	trace.append(summary, items);
	const answer = element("div", "answer");
	const progress = element("div", "turn-progress");
	const status = element("span", "progress-status", "Working…");
	status.setAttribute("role", "status");
	const elapsed = element("span", "progress-time");
	progress.append(status, elapsed);
	const startedAt = turn.created_at ? Date.parse(turn.created_at) : Date.now();
	const timing = turn.trace?.find((event) => event.type === "timing");
	let timer;
	const stop = (label = "Completed", ms = Date.now() - startedAt) => {
		clearInterval(timer);
		progressTimers.delete(timer);
		status.textContent = label;
		elapsed.textContent = ` · ${duration(ms)}`;
		progress.classList.add("finished");
	};
	if (turn.status === "running") {
		const tick = () => {
			elapsed.textContent = `Working for ${duration(Date.now() - startedAt)}`;
		};
		tick();
		timer = setInterval(tick, 1000);
		progressTimers.add(timer);
	} else if (timing)
		stop(
			turn.status === "complete" ? "Completed" : "Stopped",
			timing.durationMs,
		);
	else progress.hidden = true;
	assistant.append(heading, progress, trace, answer);
	node.append(assistant);
	ui.messages.append(node);
	const rows = new Map();
	const addEvent = (event) => {
		if (event.type === "timing") {
			stop("Finishing", event.durationMs);
			return;
		}
		trace.hidden = false;
		if (event.type === "tool_start") {
			const row = element("details", "tool-row");
			const label = element(
				"summary",
				"",
				`${toolLabels[event.name] || event.name}…`,
			);
			const content = element("pre", "", event.arguments);
			row.append(label, content);
			items.append(row);
			rows.set(event.id, { row, label, content, name: event.name });
			summary.textContent = `Grocery search · ${rows.size} ${rows.size === 1 ? "step" : "steps"}`;
		} else if (event.type === "tool_end") {
			const row = rows.get(event.id);
			if (!row) return;
			let result;
			try {
				result = JSON.parse(event.output);
			} catch {
				result = { data: event.output };
			}
			rememberProductImages(result);
			row.label.textContent = `${result.isError ? "Issue" : "Done"} · ${toolLabels[event.name] || event.name} · ${(event.durationMs / 1000).toFixed(1)}s`;
			if (result.data?.cache)
				row.label.textContent += ` · ${result.data.cache.hits} cache hits, ${result.data.cache.misses} misses`;
			row.content.textContent += `\n\n${JSON.stringify(result, null, 2)}`;
		}
	};
	for (const event of turn.trace || [])
		if (event.type !== "timing") addEvent(event);
	if (turn.assistant_text) markdown(turn.assistant_text, answer);
	if (turn.error) {
		assistant.append(element("div", "turn-error", turn.error));
		const retry = element("button", "retry", "Use this message again");
		retry.addEventListener("click", () => {
			if (!busy) {
				ui.input.value = turn.user_text;
				ui.input.focus();
			}
		});
		assistant.append(retry);
	}
	return {
		node,
		answer,
		addEvent,
		stop,
		setStatus: (text) => {
			status.textContent = text;
		},
	};
}

async function loadChat(id) {
	const version = ++loadVersion;
	const chat = await api(`/api/chats/${id}`);
	if (version !== loadVersion) return;
	currentId = id;
	history.replaceState(null, "", `#${id}`);
	if ([...ui.model.options].some((option) => option.value === chat.model))
		ui.model.value = chat.model;
	ui.welcome.hidden = chat.turns.length > 0;
	clearProgressTimers();
	ui.messages.replaceChildren();
	productImages.clear();
	productOffers.clear();
	chat.turns.forEach(addTurn);
	await refreshList();
	scrollDown(true);
	if (chat.turns.some((turn) => turn.status === "running") && !busy) {
		setTimeout(() => {
			if (currentId === id && !busy)
				loadChat(id).catch((error) => showError(error.message));
		}, 1000);
	}
}

async function streamEvents(response, receive) {
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "",
		ended = false;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		while (true) {
			const boundary = buffer.indexOf("\n\n");
			if (boundary < 0) break;
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			for (const line of block.split("\n")) {
				if (!line.startsWith("data: ")) continue;
				const event = JSON.parse(line.slice(6));
				if (event.type === "done" || event.type === "error") ended = true;
				receive(event);
			}
		}
	}
	if (!ended)
		throw new Error(
			"The connection ended before the reply finished. Your message is saved; try again.",
		);
}

$("#composer").addEventListener("submit", async (event) => {
	event.preventDefault();
	const message = ui.input.value.trim();
	if (busy || !message || !settings) return;
	showError();
	setBusy(true);
	controller = new AbortController();
	const model = ui.model.value;
	ui.welcome.hidden = true;
	ui.input.value = "";
	const turn = addTurn({ user_text: message, model, status: "running" });
	activeTurn = turn;
	scrollDown(true);
	let accepted = false,
		replyError = false;
	try {
		if (ui.city.value.trim() && ui.city.value.trim() !== settings.city)
			await saveCity();
		if (!currentId) {
			const chat = await api("/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model }),
			});
			currentId = chat.id;
			history.replaceState(null, "", `#${chat.id}`);
		}
		setActivity("Connecting…");
		const response = await fetch(`/api/chats/${currentId}/messages`, {
			method: "POST",
			signal: controller.signal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message, model }),
		});
		if (!response.ok)
			throw new Error(
				(await response.json()).error || "Could not send the message.",
			);
		accepted = true;
		let answer = "";
		await refreshList();
		scrollDown(true);
		await streamEvents(response, (event) => {
			if (event.type === "status") setActivity(event.text);
			if (event.type === "timing") turn.addEvent(event);
			if (event.type === "tool_start" || event.type === "tool_end") {
				turn.addEvent(event);
				if (event.type === "tool_start")
					setActivity(`${toolLabels[event.name] || "Searching"}…`);
			}
			if (event.type === "delta") {
				answer += event.text;
				turn.answer.style.whiteSpace = "pre-wrap";
				turn.answer.textContent = answer;
			}
			if (event.type === "done") markdown(event.text, turn.answer);
			if (event.type === "error") {
				replyError = true;
				showError(event.error);
			}
			scrollDown();
		});
	} catch (error) {
		replyError = true;
		showError(
			error.name === "AbortError"
				? "Reply stopped. Your conversation is saved."
				: error.message,
		);
	} finally {
		turn.stop(replyError ? "Stopped" : "Completed");
		if (replyError && !ui.input.value) ui.input.value = message;
		if (!accepted) {
			turn.node.remove();
			ui.welcome.hidden = ui.messages.children.length > 0;
		}
		if (accepted && currentId) {
			// Let the server persist an interrupted stream before refreshing its saved state.
			if (controller.signal.aborted)
				await new Promise((resolve) => setTimeout(resolve, 350));
			try {
				await loadChat(currentId);
			} catch (error) {
				showError(error.message);
			}
		}
		setBusy(false);
		ui.input.focus();
		// A cancellation may still be closing the MCP process. A subsequent reload
		// will show the saved terminal state instead of leaving a permanent spinner.
		if (currentId && controller.signal.aborted)
			loadChat(currentId).catch((error) => showError(error.message));
	}
});

$("#stop").addEventListener("click", () => controller?.abort());
ui.input.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		if (!busy) $("#composer").requestSubmit();
	}
});
function newChat() {
	if (busy) return;
	++loadVersion;
	currentId = null;
	history.replaceState(null, "", location.pathname);
	ui.messages.replaceChildren();
	clearProgressTimers();
	productImages.clear();
	productOffers.clear();
	ui.welcome.hidden = false;
	ui.input.value = "";
	showError();
	refreshList().catch((error) => showError(error.message));
	ui.input.focus();
}
$("#new-chat").addEventListener("click", newChat);
window.addEventListener("hashchange", () => {
	if (busy) {
		history.replaceState(null, "", `#${currentId}`);
		return;
	}
	const id = location.hash.slice(1);
	if (!id) newChat();
	else if (/^[\w-]+$/.test(id) && id !== currentId) {
		loadChat(id).catch((error) => showError(error.message));
	}
});
document.querySelectorAll("[data-prompt]").forEach((button) => {
	button.addEventListener("click", () => {
		ui.input.value = button.dataset.prompt;
		ui.input.focus();
	});
});

async function init() {
	try {
		settings = await api("/api/config");
		const cityNames = await api("/api/cities");
		$("#city-options").replaceChildren(
			...cityNames.map((city) => {
				const option = element("option");
				option.value = city;
				return option;
			}),
		);
		ui.city.value = settings.city ?? "";
		if (settings.city) {
			$("#city-help").textContent =
				`Saved: ${settings.city}. You can name a different city in a message.`;
		}
		ui.model.replaceChildren(
			...settings.models.map((model) => {
				const option = element("option", "", model);
				option.value = model;
				return option;
			}),
		);
		ui.model.value = settings.defaultModel;
		if (!settings.apiKeyConfigured)
			showError(
				"Add OPENAI_API_KEY to ruoka-app/.env and restart to start chatting.",
			);
		const id = location.hash.slice(1);
		if (/^[\w-]+$/.test(id)) await loadChat(id);
		else await refreshList();
	} catch (error) {
		showError(error.message);
	}
}
await init();
