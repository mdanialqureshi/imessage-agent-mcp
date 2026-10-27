# Roadmap

## Design decisions

- **Entirely local.** Messages, items and state stay on the Mac. No cloud store, no tunnel, no network port: the service listens on a private Unix socket. Cloud agents (Dot, Claude) reach it only through desktop apps the user runs on the Mac.
- **No API billing.** Interpretation uses subscription CLIs: `claude -p` (default) or `codex exec`, switchable with `use`, config, or env.
- **Smart server, thin clients.** All interpretation happens here, so every agent gets the same results. Agents only read the brief and update statuses.
- **Agents own cadence and actions.** The server doesn't notify or create calendar events. The connected agent does, after asking the user.
- **Read-only first.** Core tools are read-only so restricted background agents can use them. Writes are limited to item status.

## Milestones

### ✅ M1: core pipeline
- Read-only `chat.db` reader: `attributedBody` decoding, tapbacks, replies, edits, unsends; Contacts names
- Conversation windows with context, a re-check of unanswered 1:1 chats, privacy filters
- Interpreter prompt and strict schema; Codex and Claude runners; create, update, done and cancel ops with dedupe
- Local store, brief, MCP tools
- launchd service with wall-clock catch-up after sleep
- Unix-socket service plus a permission-less stdio bridge; `setup` connects ChatGPT/Codex (for Dot), Claude desktop, Claude Code and Cursor
- Synthetic fixture tests; public-repo safety scanner and pre-commit hook

### M2: real-data tuning
- Grant Full Disk Access, run on real history, label ~50 conversations together
- Extend the synthetic eval (`npm run eval`, 23 scenarios × both interpreters) with real-data cases; measure precision and recall per kind; tune the prompt; add few-shot examples learned from `dismissed` items
- Call history (`CallHistoryDB`) to auto-close `call` items

### M3: verify every front door
- Confirm with a real Dot that work routed through the ChatGPT desktop app can call `get_brief`, including scheduled runs that notify the user
  - First test (2026-10-27): the ChatGPT app launched the bridge and Dot's Mac task reached the service, but the `imessage` tools weren't in that task's tool list. `call` covers it meanwhile. Next: find out whether a fresh Dot task, or a setting, exposes them natively.
- Confirm the same for Claude from the phone through the Claude desktop app
- Clear "your Mac is offline" behavior in each agent

### Hardening
- A dedicated, single-purpose helper binary holds Full Disk Access instead of `node`, so other Node scripts can't inherit it

### M4: assistant layer
- Person profiles: last contact, usual cadence, topics, open items both ways → `get_person`
- Drifting-friend nudges, weekly review tool
- Attachment and voice-note awareness

### M5: drafted replies (opt-in)
- `draft_reply` → outbox that needs explicit approval; sent via Messages.app AppleScript when approved

## Non-goals

- A public endpoint, tunnel or hosted relay. Access stays behind apps the user runs on their own Mac.
