# mcp-ruoka

Library, CLI and MCP tools for Finnish groceries across K-Ruoka, S-Kaupat and the partial published Lidl catalog. Single-client personal tool — keep auth, session management, and infrastructure simple rather than building for multi-tenant scale.

## Commands

- `bun run dev` — Node MCP stdio with watch mode
- `bun run cli -- capabilities` — JSON CLI
- `bun run test` — offline Node tests
- `bun run smoke` — opt-in live checks using configured K/S default stores
- `bun run build` — bundle for production
- `bun run check` — lint, format, and auto-fix with Biome
- `bun run typecheck` — type-check without emitting

## Conventions

- Node 24 for library, CLI and MCP stdio. Bun remains the dependency manager and inherited Linux HTTP runtime. Playwright startup hangs under Bun on the tested Windows setup.
- Do not infer physical stock from a price or online availability. Preserve nutrition basis and units; unknown values stay null.
- Biome for linting and formatting (no ESLint/Prettier)
- Strict TypeScript — no `any`, no non-null assertions, no `as` type casts (use Zod parsing instead)
- Parse all I/O boundaries with Zod — API responses, JSON.parse results, external data. Never trust runtime shapes via `as` assertions; validate with `.parse()` / `.safeParse()`. (`as const` is fine — it narrows literals, doesn't assert shapes)
- All tool inputs validated with Zod schemas via MCP SDK
- Use pino for logging (`src/logger.ts`), never `console.log/warn/error` — logs must go to stderr to avoid interfering with stdio MCP transport
- Comments should explain *why*, not *what* — no section dividers, no restating what the code does
- Browser context is reused across calls — don't create new contexts per request
- Keep chain-specific browser/API logic (`src/browser/`) isolated from MCP tool definitions (`src/tools/`)
