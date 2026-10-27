# Roadmap

## Design decisions

- **Local only.** Messages, items and state stay on the Mac. No cloud store.
- **No API billing.** Interpretation uses subscription CLIs: `claude -p` (default) or `codex exec`, switchable with `use`, config, or env.
- **Smart server, thin clients.** All interpretation happens here, so every agent gets the same results. Agents only read the brief and update statuses.
- **Agents own cadence and actions.** The server doesn't notify or create calendar events. The connected agent does, after asking the user.
- **Read-only first.** Core tools are read-only so restricted background agents can use them. Writes are limited to item status.

## Milestones

### ✅ M1: core pipeline
- Read-only `chat.db` reader: `attributedBody` decoding, tapbacks, replies, edits, unsends; Contacts names
- Conversation windows with context, a re-check of unanswered 1:1 chats, privacy filters
- Interpreter prompt and strict schema; Codex and Claude runners; create, update, done and cancel ops with dedupe
- Local store, brief, MCP tools over stdio and localhost HTTP (token + host/origin checks)
- launchd service with wall-clock catch-up after sleep
- Synthetic fixture tests; public-repo safety scanner and pre-commit hook

### M2: real-data tuning
- Grant Full Disk Access, run on real history, label ~50 conversations together
- Extend the synthetic eval (`npm run eval`, 23 scenarios × both interpreters) with real-data cases; measure precision and recall per kind; tune the prompt; add few-shot examples learned from `dismissed` items
- Call history (`CallHistoryDB`) to auto-close `call` items

### M3: remote access for cloud agents (ChatGPT / Dots, claude.ai)
- Opt-in tunnel (Tailscale Funnel, ngrok static domain, or a Cloudflare named tunnel)
- OAuth 2.1 authorization server with dynamic client registration, single-user consent
- A test that a Dot's scheduled run can call `get_brief` and notify the user
- Separate tool exposure for remote clients (e.g. raw `get_conversation` and `search_messages` off by default)

### Hardening
- A dedicated, single-purpose helper binary holds Full Disk Access instead of `node`, so other Node scripts can't inherit it
- Optional Keychain storage for the HTTP token

### M4: assistant layer
- Person profiles: last contact, usual cadence, topics, open items both ways → `get_person`
- Drifting-friend nudges, weekly review tool
- Attachment and voice-note awareness

### M5: drafted replies (opt-in)
- `draft_reply` → outbox that needs explicit approval; sent via Messages.app AppleScript when approved
