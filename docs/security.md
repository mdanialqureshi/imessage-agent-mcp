# Privacy and security

imessage-agent-mcp reads your private message history, so this page spells out exactly what it does with it.

## What leaves your Mac

| Data | Where it goes | When |
|---|---|---|
| New conversation windows (after filtering) | Anthropic or OpenAI, through the interpreter CLI you choose, under your plan's terms | Each background run (every 2 hours by default; with the Mac app, only while it's open) |
| Tool results (the brief, items, messages you ask about) | The agent you asked (Dot, Claude, …) | Only when that agent calls a tool |
| Update check and download (Mac app) | `api.github.com` and `github.com`; the request carries only the app's version | Once a day unless switched off in Settings; downloads only when you click **Install Update** |
| Everything else: your databases, the item list, logs | Nowhere | Never |

Verification codes (a code word near 4–8 digits, also when split like `123-456`, and in common languages; dates and phone numbers aren't codes), business senders (short codes, Apple business chats and named senders like a bank's) and anyone in `privateContacts` are dropped on the Mac before any model sees them. Marking someone private also removes the items already noted from their chats, at the next run. The filter is a pattern match, so an unusually worded code can still get through.

## Local only

- The service listens on a Unix socket (`0600`, inside a `0700` folder), never on a network port, not even localhost. There's no tunnel, relay or hosted component.
- When an agent runs the bridge with a home folder of its own (a sandbox's), the Mac app's `connect` and `call` also look for the socket in your account's real home folder, and nowhere else.
- Cloud agents reach your Mac only through desktop apps you run and sign in to yourself (the ChatGPT or Claude desktop app). You can turn that off there, e.g. **Revoke access** on your Dot's profile.
- State lives in `~/Library/Application Support/imessage-agent-mcp/`: the item list, short evidence quotes, run history, and the reader's copy of Messages. Every data file is `0600`.

## Full Disk Access: only the reader

macOS grants Full Disk Access per program. Here it goes to one small C program, `helper/reader.c`, run by launchd as its own job. It's packaged as a tiny app so it's easy to find and shows by name in the list, at `~/Applications/Messages Agent Reader.app`. The command line builds it there; the Mac app ships one (in `Contents/Helpers`) and copies it there when it installs the service and each time it opens, if the copy there is missing or isn't exactly the reader it ships (it checks the copy's signature first). It can't run from inside the Mac app: macOS counts a program run from inside an app as that app, so it would only work with Full Disk Access for all of Messages Agent. Because it lives outside the app, trashing the app doesn't remove it or its launchd job: uninstall first (Settings → Uninstall…), then remove Messages Agent Reader from Full Disk Access. The Mac app, the service, the bridge, `node`, your terminal and your other apps hold no special permissions. The Mac app warns you if it was given Full Disk Access by mistake.

The reader does one thing: copy the Messages and Contacts databases into the private folder. Anything that runs it gets only what the service already exposes, not Mail, Safari, Photos or other apps' data. To keep it that way:

- It takes no arguments and gets its home folder from the system, not the environment.
- It's signed with Apple's hardened runtime, so injected libraries (`DYLD_INSERT_LIBRARIES`) and debuggers can't run code inside it. Replacing its program changes its signature, so macOS stops honoring the access, and nothing else in its folder can load code into it. Its files can't be changed by other users.
- `setup` and `doctor` check its signature, and rebuild or flag a reader that isn't exactly what was built. In the Mac app, installing and every launch replace a missing or changed copy with the app's own reader.
- **Re-granting.** macOS ties the access to the reader's exact code, so an update that changes the reader means switching it on again (releases reuse the previous reader when it didn't change). The app and `doctor` remember which reader had access and warn when a different one asks for it: if you didn't just update, don't grant it; quit and reopen Messages Agent instead (or, from a clone, run `setup` again). (A reader you build from a clone is signed ad-hoc, which can't prove who built it, so this check is a warning, not a guarantee.)
- **If you give the app itself access by mistake**, it refuses to run anything (its shell, Node or the CLI would inherit the access) and asks you to switch it off.
- **Its folder.** `~/Applications` must be a real folder you own that other accounts can't write to.
- **Who can change what it runs.** Before installing the background service, `setup` and the app check that Node, the server code, the reader and the Claude or Codex program, and every folder on the way to them, belong to you or the system and can't be changed by other accounts. Otherwise another account on a shared Mac could swap one and have it run as you.
- It reaches the private folder without following links. It refuses the folder if any part of the way is a link or on another drive, or if the folder itself is owned by someone else or open to other users, including through an access-control list.
- It reaches Messages and Contacts the same way, and only copies regular files, so a link, pipe or device planted there is skipped rather than followed or waited on.
- Inside its private folder it never follows a link, never opens a file with SQLite, and only changes a file after checking it's its own.
- launchd opens no log file for it (its output goes to `/dev/null`), so nothing opens files on its behalf. Its result goes to `reader-status`.
- It holds a read lock on the live Messages database only while copying, so the copy is consistent. A two-minute deadline ends it if it stalls.
- It's read-only: nothing is ever sent, edited or deleted.

Don't give `node` Full Disk Access. That would give it to every Node program launchd starts.

## The Mac app

- **When it runs.** The service and its reader run only while Messages Agent is open. Quitting stops both launchd jobs and switches them off, so logging in doesn't start them either; opening the app starts them again. To keep agents connected after a restart, turn on **Open at login** in Settings. An update's relaunch leaves the service running for the new copy.
- **What's in it:** the menu bar app (Swift), Node (an official LTS release, pinned by checksum), this project's source and dependencies, and the prebuilt reader. The app only runs the bundled CLI, the same code as a clone, and shows its JSON status.
- **Signed and notarized.** Releases are signed with the maintainer's Developer ID, with the hardened runtime, and notarized by Apple, so Gatekeeper checks who made a download and that Apple scanned it (`spctl -a -vv "/Applications/Messages Agent.app"` should say `source=Notarized Developer ID`). The bundled Node's only exception to the hardened runtime is JIT compilation (`app/node.entitlements`); the app and reader have none. A copy you build yourself with `npm run build:app` is signed ad-hoc on your Mac: that proves it's intact, not who made it. Download only from this repo's Releases.
- **Updates.** Once a day (unless switched off in Settings), the app asks `api.github.com` for this repo's latest release; the request carries no identifiers beyond the app's version in its User-Agent (and, like any web request, your IP address). An update installs only when you click **Install Update**. It's downloaded over HTTPS from github.com and GitHub's own asset hosts only. The release's `SHA256SUMS.txt` must have a valid Ed25519 signature (`SHA256SUMS.txt.sig`) from the project's release key, whose public half is built into the app (`UPDATE_PUBLIC_KEY` in `src/update.ts`); the private half is a secret of the protected `release` environment, which only the publishing job uses, or stays on the maintainer's Mac for a release built, notarized and signed there (the workflow then leaves that tag's release alone), so replacing a release's files on GitHub isn't enough to ship an update. The zip must match those checksums and hold only the app (no links, nothing outside it; its listing and each listed file's local header are checked before unpacking, it's unpacked without any attributes or permission lists, and every unpacked path must be a file or folder the listing names; the app's signature then covers every file's contents), and the app inside must have an intact signature, this app's identifier, the release's version and an intact reader with its protections. The app then checks the exact bundle again, with macOS's code-signing API, right before and after it replaces itself. An update is downloaded by the app itself, so macOS's Gatekeeper doesn't check it the way it checked the first download; the release-key signature takes that role.
- **The release key.** It lives outside the repo (never committed) and, for releases, in the `UPDATE_SIGNING_KEY` secret of a `release` environment (Settings → Environments): set that environment to allow only tags matching `v*` and to require a reviewer, and never make the key a repository secret, which every workflow on every branch could read. The publishing job signs with the runner's own OpenSSL. Releases fail without it. If it's ever exposed, generate a new pair, put the new public half in `src/update.ts` and ship that release by hand: apps that have the old key won't accept updates signed with the new one.
- **What the signature doesn't cover.** It proves a release came through the publishing job, not that the build it signed was clean: a compromised dependency in the build job could change the app before it's signed (pinned actions, `npm ci` from the lockfile and `--ignore-scripts` narrow that). And whoever controls the GitHub release can hold updates back, or offer an older signed release that's still newer than yours; never an older one than you have.
- **How releases are made.** `.github/workflows/release.yml` builds and tests the app from the tagged source in a job that can't write to the repo; a separate job, which runs only pinned GitHub actions and the runner's own tools, checks the tag is on `master` and matches the version in `package.json`, checks the files arrived intact and publishes them. (Who may push tags is the real control: only the repo owner.) For a public repo it also attaches build provenance, so `gh attestation verify <file> -R mdanialqureshi/imessage-agent-mcp` shows a download was built there. A release reuses the previous release's reader (so Full Disk Access stays on) only if that release's provenance shows this workflow built it and the reader's inputs are unchanged; otherwise it builds a fresh one.
- **The download flag.** Once you've approved and opened it, the app removes macOS's download flag (`com.apple.quarantine`) from its own files, so launchd can start the Node inside it. (The reader is copied to `~/Applications` without the flag.) Its signature still covers every file.
- **Its environment.** It passes only `PATH` (read from your login shell, so `claude` and `codex` are found) plus `HOME`, `USER`, `LANG` and `TMPDIR` to what it runs. Nothing else from your shell, such as API keys, reaches the service.
- **Moving it.** The service and app connections point into the app. If you move it, opening it again repoints them. It won't install from a disk image, or from a downloaded copy macOS is running from a temporary read-only location.

## The interpreter has no tools

Message text is written by other people, so the interpreter is a pure text-in, JSON-out call. It never loads the `imessage` connection that `setup` adds to your apps.

- **No file mentions.** Both CLIs treat `@path` in a prompt as "attach this file", even with every tool off, so a message saying `@~/.ssh/id_ed25519` would have attached that file. Every `@` in a prompt is replaced with a look-alike (＠) before it reaches either CLI, and Claude Code also runs with file mentions turned off (`CLAUDE_CODE_DISABLE_FILE_MENTIONS`). A test checks exactly what the CLI receives.

- **`claude -p`** (the most locked-down option): `--tools ""`, an empty `--strict-mcp-config`, no setting sources, `--no-session-persistence`. The model has no callable tools at all.
- **`codex exec`**: every Codex feature that's on by default is turned off, read from `codex features list` at runtime: shell and exec, ChatGPT connectors (apps and plugins), code mode, browser and computer use, memories. It also runs with `--ignore-user-config`, `--ephemeral` and a read-only sandbox.
  - Codex 0.164 still *lists* a few tools that no flag removes: "collaboration" (sub-agent) tools, code mode's `exec`, `wait` and `request_user_input`. The ones that could act fail: `--ephemeral` sessions can't spawn agents, and `exec` errors because the code-mode host is off.
  - **Fail closed:** Codex logs every tool call it makes, including ones its `--json` output omits. If the log shows any tool call, or the event stream has anything beyond a plain text answer, that batch's output is thrown away.

## How messages are handled

- **Size limits.** Each message is capped at 2,000 characters and each conversation window at 40,000, and cut before any other processing, so a huge message can't slow the service down.
- **Malformed data.** A damaged or unusual message record decodes to nothing instead of failing the run. Dates from the model must be real dates, and text in the brief can't fake bold text or item ids.
- **Retries.** A chat that fails 3 runs in a row is skipped instead of stalling every run. If the interpreter is unavailable (signed out, offline, usage limit), the run is retried later; outages never count toward that limit.
- **Strangers are isolated.** A chat with anyone not in your Contacts is interpreted on its own, and if its output is unusable, only that chat is dropped. Every change must cite messages from its own chat, and closing an item needs a new message. *Residual risk:* chats with saved contacts are batched together, so one contact's message could still steer how the model reads another's chat in the same batch.
- **No forged structure.** Embedded newlines are collapsed everywhere (messages, group names, model output), so text can't fake transcript lines or brief sections. Interpreter output is never logged.

## Prompt injection reaches your agent too

Tool results contain text other people wrote. The tool descriptions, the brief and the `call` command all tell agents to treat it as data, but agents like Codex, Claude Code and Dot have their own tools (shell, files, web). Anyone can text you, so assume a message may be written to steer your agent.

- **Keep your agent's approval prompts on.** Don't connect an agent that runs commands without asking (Claude Code's `--dangerously-skip-permissions`, Codex's full-access or "yolo" modes), especially for the scheduled check-ins nobody watches.
- **Strangers' quotes and details stay out of the brief.** Items from chats with anyone not in your Contacts are marked "not in Contacts", named by their people (names or numbers), never by a group name someone chose, and the brief leaves out their quotes and details; `get_item` shows them, labelled, when someone looks on purpose. A chat whose person is later removed from Contacts is marked the same way at the next run. (Without any Contacts, nothing is marked: everyone would count as a stranger.) Invisible characters (zero-width, direction overrides, Unicode tags, variation selectors, blank fillers) are removed from all message text, so nothing can hide in it.
- **Limits.** A stranger's chat costs its own interpreter call, so at most 20 are read per run; the rest are read on later runs. `refresh` reads again at most once a minute.
- Don't let an agent act on instructions that appear in a message. If Dot asks to run a command, approve only the exact `call` command setup shows (`…/node …/cli.ts call`), not shell access in general.

## Clones and updates

`node src/cli.ts update` moves a clone to the newest release tag on `master`. Tags aren't signed, so this trusts the GitHub repo itself (the Mac app's updates are checked against the release key instead). To check before you run it, read what changed: `git fetch --tags && git log HEAD..$(git describe --tags --abbrev=0 origin/master)`.

## Threat model

This protects against other people (through the messages they send you), the network, web pages, and other macOS users.

The reader's hardened runtime (no injected libraries or debuggers) is enforced by macOS only while System Integrity Protection is on, as it is by default.

It **can't** protect against malware already running as *your* user. That could talk to the socket, read the state files (including the copy of Messages), or run the reader. It would get Messages and Contacts, but not the rest of what Full Disk Access covers.
