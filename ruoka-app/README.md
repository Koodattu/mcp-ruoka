# Ruoka chat

A local grocery-chat POC: one Node server, a plain HTML/CSS/JS frontend, SQLite history and the sibling grocery MCP over stdio. No login, Docker, bundler, or new dependencies. It reuses the MCP project's installed SDK and browser.

## Run

Requires Node **24.4+** and the sibling `../mcp-ruoka` project with its dependencies and Playwright Chromium installed. If that project has not been set up, run `bun install --frozen-lockfile` and `bunx playwright install chromium` in that folder once.

In `ruoka-app/.env`, set:

```dotenv
OPENAI_API_KEY=your-key
OPENAI_MODEL=gpt-6-luna
```

Then, from this directory:

```powershell
node server.mjs
```

Open **http://localhost:3210**. `bun run start` is equivalent and still launches Node. Stop with Ctrl+C. `bun run dev` enables Node watch mode for backend changes; refresh the browser for frontend changes.

The model picker includes the `.env` default, `gpt-6-luna`, and `gpt-6.1-terra`. Set `OPENAI_MODELS` to a comma-separated list to change the choices. Luna uses **high** reasoning effort with a 16,000-token output cap; Terra and other models use **low** with a 5,000-token cap. These per-response caps include reasoning and visible text, not just the answer. Models must support Responses function calling and the configured effort, and be available to your API key. Changing the picker applies to the next message; past replies retain their model labels. Restart after editing `.env`. `PORT` defaults to `3210`.

Choose your **Shopping city** above the chat. Suggestions come from the existing Finnish municipality data; local and Swedish names such as Hyllykallio and Helsingfors resolve to their municipality when unambiguous. The choice is saved in SQLite across reloads/restarts and reused in new chats. A city explicitly requested in a message overrides the default for that search; no postcode or store ID is needed. Changing the selected city changes the default for the next message, including in existing chats.

Try: **Etsi laktoosittomia proteiinijogurtteja. Vertaa proteiinia ja sokeria per 100 g sekä hintaa.** Then **Entä Prismasta?** or **Jotain halvempaa.** Example cards fill the input without a hardcoded location. With no selected or mentioned city, Ruoka asks for one.

## Small by design

- OpenAI [Responses function calling](https://developers.openai.com/api/docs/guides/function-calling) with streamed text. MCP `tools/list` supplies schemas; calls run locally through the official SDK. No public MCP endpoint is needed.
- Read-only grocery tools; no account changes or ordering. The UI writes only the app's city setting, leaving the MCP project's preferences untouched. Other preferences remain in the conversation.
- [discover_groceries](workflow.mjs) resolves the selected city and returns compact candidates from up to two stores, normally one Prisma and one Citymarket. Names, category paths, price/availability summaries, weak-search warnings and per-store pagination reach the model before any detail requests. This is not a nearest-store or city-wide search.
- The model selects relevant IDs, then calls `inspect_groceries` for at most eight labels per batch. The underlying MCP tools `discover_products` and `get_products` are reusable by other clients. The model verifies dietary requirements, cut/category, ingredients and numeric comparisons against the inspected labels; discovery itself does not certify eligibility. The older deterministic search helper remains available to regression fixtures, but is no longer the chat's search tool.
- The prompt preserves requirements across follow-ups, considers naming variants such as fileepihvi/ohutleike, rejects off-category matches, and asks a short priority question only for genuinely open requests. Failure, partial results and weak matches remain explicit. K-Ruoka's category paths are included; a separate category browser has not been added.
- MCP SQLite caches searches and details for five minutes, K/S directories for 24 hours, and explicit K availability checks for one minute. Query whitespace/case is normalized. Detail and availability tools accept `refresh` for explicit current checks. Cache hit/miss counts appear in the expandable tool trace, and provider-health reports live load counts. Product labels still share the detail cache's five-minute lifetime; no background catalog crawl is introduced.
- `get_product_availability` checks a selected K store and optionally nearby alternatives, retaining the retailer's radius and timestamps. An unavailable store's supplied price is not advertised as a purchase offer. Product links show availability with expandable check time and explanation; the answer does not repeat routine shelf-stock disclaimers.
- Maximum 8 model tool rounds / 16 model tool calls plus a final synthesis; four-minute turn deadline. Discovery requests 50 candidates per store/page. Inspection batches are capped at eight products and deduplicate repeated references. Individual MCP calls time out at 150 seconds. Outputs over 60,000 characters are explicitly marked truncated. Context over 450,000 characters requests a new chat rather than silently dropping evidence.
- Full completed response items (including encrypted reasoning) and tool outputs are replayed for follow-ups, with `store: false` at OpenAI. SQLite lives at `data/chat.sqlite`. Failed/interrupted turns remain visible but are excluded from model context. A stopped request must be resent to complete it.
- One active reply across browser tabs, matching the grocery provider's single-client design. Stop/disconnect aborts OpenAI and closes the dedicated MCP process to stop remaining browser work. A later request reconnects it. MCP browser state is isolated in `data/browser`.
- Progress appears inside the active reply with a live “Working for Xm Ys” timer. Completed/stopped duration is saved in the turn trace; reloads restore it without a database migration. Drafts survive failures and cancellation.
- Server listens only on `127.0.0.1`, checks Host/Origin, and serves only three static assets. The API key stays on the backend and is not passed to the MCP child. `.env`, SQLite, and browser data are ignored by Git. Chat text and relevant tool results are sent to OpenAI; grocery requests contact the retailers.
- Source links, Markdown comparison tables (scrollable on mobile), retailer product thumbnails, expandable tool inputs/results, saved conversations, errors and retry are supported. Images come only from tool-provided HTTPS URLs associated with linked products, load directly from retailers without a referrer, and disappear if unavailable. Older searches that did not save image URLs remain text-only until a new search. No accounts, background jobs, or server-side chat deletion in this demo.

The grocery MCP still owns product observations in its existing data directory. Provider failures, missing nutrition, partial searches and store-specific prices are surfaced, not hidden. AI recommendations can be wrong; source links let you check them.

Search results retain original nutrition tables and normalization warnings. A retailer table marked prepared (including some K-Ruoka yogurts), an unsupported basis or conflicting values is distinct from absent nutrition: the model can report the labelled values, but automatic as-sold rankings still exclude them. Follow-up comparisons refresh reused products to obtain current prices, labels and photos.

## Verify

```powershell
bun run test
```

Tests use a temporary SQLite file, mocked OpenAI responses, and a real local MCP connection for tool discovery/capabilities. No API credit or retailer calls are needed.

Search regression fixtures cover the original protein-yogurt failure, broader-search recovery, label-based lactose checks, missing ingredients, category separation, protein and litre-price ranking, provider failures, city aliases and detail budgets. They do not prove retailer coverage.

With the app running, `bun run test:ui` checks city persistence, model choice, draft recovery, comparison tables/images, per-store availability, live/completed timers, reloads, cancellation and mobile reflow. Every API request is intercepted; it does not change saved settings or spend API credit.

After selecting a city, run the opt-in natural-language evaluation with the app running:

```powershell
bun run eval
```

This spends API credit and contacts retailers. It checks discovery/inspection, the protein-yogurt request, “Entä Prismasta?”, “Jotain halvempaa.” and “Paras jogurtti?”. `node scripts/eval.mjs --chicken` checks plain chicken breast and the Pirkka follow-up. Assertions check observed IDs, bounded inspection and cited product evidence, not merely whether the model used the expected words. Changing retailer availability can make the live regression fail. Resulting chats remain available for manual review.

With the app running, this optional live check uses your configured model/key and real retailer data, creates one saved chat, and reports only a compact result:

```powershell
bun run smoke
```

The live script asks for a small yogurt search, verifies MCP activity and an answer, then sends a follow-up to check history replay. It spends API credit. For a manual UI check, exercise a sample prompt, switch models, reload a saved chat, and stop a running request. Tool details expose the evidence used for a recommendation without displaying private model reasoning.
