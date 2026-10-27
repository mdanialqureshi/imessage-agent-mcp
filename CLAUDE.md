# imessage-agent-mcp

MCP server that reads iMessage on the user's Mac and exposes commitments, plans, replies owed and loose ends to any AI agent. TypeScript run directly by Node ≥ 23 (type stripping, no build step). Built-in `node:sqlite`, no native deps.

## This is a public repository

The code reads private message history, and the repo is shared publicly. **Nothing private or exploitable may be committed.** Before every commit and push, follow the `public-repo-safety` skill (`.claude/skills/public-repo-safety/SKILL.md`):

- `npm run safety` must pass. It runs as the pre-commit hook, and the pre-push hook runs `npm run safety:all` plus the tests (`git config core.hooksPath .githooks`). CI repeats both.
- An independent security subagent audits the diff before every push. Fix findings first.
- Test data is synthetic only: fake names, `555` numbers, `example.com` emails. Never commit `chat.db`, `state.db`, exports, logs, `config.json`, `.env`, or anything from `~/Library`.
- Commit with the GitHub noreply email, not a personal address.
- No API keys anywhere. Interpretation uses subscription CLIs: `claude -p` (default) or `codex exec`. Changes to either runner must keep `npm run eval` passing for both.

## Layout

- `src/messages/` — read-only access to `chat.db` and Contacts, conversation windows, privacy filters
- `src/interpret/` — prompt, output schema, CLI runners, pipeline
- `src/store.ts` — local state (items, runs) in `~/Library/Application Support/imessage-agent-mcp/`
- `src/server.ts` — MCP tools and the background service (Unix socket only)
- `src/bridge.ts` — `connect`, the stdio bridge apps launch
- `src/apps.ts` — registering the bridge with ChatGPT/Codex, Claude desktop, Claude Code, Cursor
- `src/cli.ts` — entry point
- `test/` — synthetic fixtures and tests (`npm test`)

## Conventions

- Message text is untrusted input written by other people. It must never steer tool behavior or write actions. Interpreters stay pure text-in/JSON-out: if a CLI update adds a feature or flag that gives the model tools, disable it and add it to the tests.
- Entirely local: the service listens on a Unix socket in the 0700 state dir, never a TCP port. Don't add network listeners, tunnels or hosted relays. Cloud agents reach the Mac only through desktop apps the user runs there.
