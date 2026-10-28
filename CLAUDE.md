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

- `helper/reader.c` — the only part with Full Disk Access: copies `chat.db` and Contacts into the state dir; its own launchd job. A clone builds it as `~/Applications/Messages Agent Reader.app`; the Mac app ships one in `Contents/Helpers`
- `app/` — the Mac app (SwiftUI menu bar + setup window). It holds no permissions and only runs the bundled CLI (`status --json`, `install-service`, `connect-app`, …); `scripts/build-app.mjs` builds it with the pinned Node, `test/app.test.ts` checks a build
- `src/messages/` — reading `chat.db` and Contacts (the reader's copy, in the service), conversation windows, privacy filters
- `src/interpret/` — prompt, output schema, CLI runners, pipeline
- `src/store.ts` — local state (items, runs) in `~/Library/Application Support/imessage-agent-mcp/`
- `src/server.ts` — MCP tools and the background service (Unix socket only)
- `src/bridge.ts` — `connect`, the stdio bridge apps launch
- `src/apps.ts` — registering the bridge with ChatGPT/Codex, Claude desktop, Claude Code, Cursor
- `src/cli.ts` — entry point, for both the terminal and the Mac app (`appBundle` in `src/config.ts` tells them apart)
- `test/` — synthetic fixtures and tests (`npm test`)

## Conventions

- Message text is untrusted input written by other people. It must never steer tool behavior or write actions. Interpreters stay pure text-in/JSON-out: if a CLI update adds a feature or flag that gives the model tools, disable it and add it to the tests.
- Only the reader holds Full Disk Access. Keep it tiny and argument-free, signed with the hardened runtime (`READER_BUILD` in `src/messages/mirror.ts`), and working only through handles opened without following links; never let it open state-folder files with SQLite. Never give `node` or the service access, and never add a way to make the reader read or write anything else.
- Entirely local: the service listens on a Unix socket in the 0700 state dir, never a TCP port. Don't add network listeners, tunnels or hosted relays. Cloud agents reach the Mac only through desktop apps the user runs there.
