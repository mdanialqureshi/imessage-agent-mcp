# Privacy and security

imessage-agent-mcp reads your private message history, so this page spells out exactly what it does with it.

## What leaves your Mac

| Data | Where it goes | When |
|---|---|---|
| New conversation windows (after filtering) | Anthropic or OpenAI, through the interpreter CLI you choose, under your plan's terms | Each background run (every 2 hours by default) |
| Tool results (the brief, items, messages you ask about) | The agent you asked (Dot, Claude, …) | Only when that agent calls a tool |
| Everything else: your databases, the item list, logs | Nowhere | Never |

Verification codes, short-code senders (banks, 2FA, deliveries) and anyone in `privateContacts` are dropped on the Mac before any model sees them.

## Local only

- The service listens on a Unix socket (`0600`, inside a `0700` folder), never on a network port, not even localhost. There's no tunnel, relay or hosted component.
- Cloud agents reach your Mac only through desktop apps you run and sign in to yourself (the ChatGPT or Claude desktop app). You can turn that off there, e.g. **Revoke access** on your Dot's profile.
- State lives in `~/Library/Application Support/imessage-agent-mcp/`: the item list, short evidence quotes, run history, and the reader's copy of Messages. Every data file is `0600`.

## Full Disk Access: only the reader

macOS grants Full Disk Access per program. Here it goes to one small C program, `helper/reader.c`, which launchd runs as its own job. The service, the bridge, `node`, your terminal and your apps hold no special permissions.

The reader does one thing: copy the Messages and Contacts databases into the private folder. Anything that runs it gets only what the service already exposes, not Mail, Safari, Photos or other apps' data. To keep it that way:

- It takes no arguments and gets its home folder from the system, not the environment.
- It's signed with Apple's hardened runtime, so injected libraries (`DYLD_INSERT_LIBRARIES`) and debuggers can't run code inside it.
- It reaches the private folder without following links. It refuses the folder if any part of the way is a link or on another drive, or if the folder itself is owned by someone else or open to other users.
- Inside that folder it never follows a link, never opens a file with SQLite, and only changes a file after checking it's its own.
- It holds a read lock on the live Messages database only while copying, so the copy is consistent. A two-minute deadline ends it if it stalls.
- It's read-only: nothing is ever sent, edited or deleted.

Don't give `node` Full Disk Access. That would give it to every Node program launchd starts.

## The interpreter has no tools

Message text is written by other people, so the interpreter is a pure text-in, JSON-out call. It never loads the `imessage` connection that `setup` adds to your apps.

- **`claude -p`** (the most locked-down option): `--tools ""`, an empty `--strict-mcp-config`, no setting sources, `--no-session-persistence`. The model has no callable tools at all.
- **`codex exec`**: every Codex feature that's on by default is turned off, read from `codex features list` at runtime: shell and exec, ChatGPT connectors (apps and plugins), code mode, browser and computer use, memories. It also runs with `--ignore-user-config`, `--ephemeral` and a read-only sandbox.
  - Codex 0.164 still *lists* a few tools that no flag removes: "collaboration" (sub-agent) tools, code mode's `exec`, `wait` and `request_user_input`. The ones that could act fail: `--ephemeral` sessions can't spawn agents, and `exec` errors because the code-mode host is off.
  - **Fail closed:** Codex logs every tool call it makes, including ones its `--json` output omits. If the log shows any tool call, or the event stream has anything beyond a plain text answer, that batch's output is thrown away.

## How messages are handled

- **Size limits.** Each message is capped at 2,000 characters and each conversation window at 40,000.
- **Retries.** A chat that fails 3 runs in a row is skipped instead of stalling every run. If the interpreter is unavailable (signed out, offline, usage limit), the run is retried later; outages never count toward that limit.
- **Strangers are isolated.** A chat with anyone not in your Contacts is interpreted on its own, and if its output is unusable, only that chat is dropped. Every change must cite messages from its own chat, and closing an item needs a new message. *Residual risk:* chats with saved contacts are batched together, so one contact's message could still steer how the model reads another's chat in the same batch.
- **No forged structure.** Embedded newlines are collapsed everywhere (messages, group names, model output), so text can't fake transcript lines or brief sections. Interpreter output is never logged.

## Prompt injection reaches your agent too

Tool results contain text other people wrote. The tool descriptions, the brief and the `call` command all tell agents to treat it as data, but agents like Codex, Claude Code and Dot have their own tools (shell, files, web). Keep their approval prompts on, and don't let an agent act on instructions that appear in a message. If Dot asks to run a command, approve only `node … cli.ts call`, not shell access in general.

## Threat model

This protects against other people (through the messages they send you), the network, web pages, and other macOS users.

It **can't** protect against malware already running as *your* user. That could talk to the socket, read the state files (including the copy of Messages), or run the reader. It would get Messages and Contacts, but not the rest of what Full Disk Access covers.
