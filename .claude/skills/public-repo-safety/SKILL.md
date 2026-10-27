---
name: public-repo-safety
description: Required before any git commit or push in this public repo. Scans for secrets and personal data, then has an independent security subagent audit the diff. Use whenever committing, pushing, opening a PR, or adding fixtures, docs or examples.
---

# Public repo safety

This repository is public and the software reads private iMessage history. One leaked phone number, message, token or home path is a real privacy incident. Treat every commit as published permanently. Rewriting history doesn't remove forks or caches.

## Before every commit

1. **Look at exactly what's staged:** `git status` and `git diff --cached`. Unstage anything unexpected.
2. **Run the scanner:** `npm run safety`. It checks staged files for:
   - API keys and tokens (OpenAI, Anthropic, GitHub, AWS, Slack, Google, private keys, JWTs, bearer tokens)
   - email addresses outside `example.com`/`example.org`/`users.noreply.github.com`
   - phone numbers outside the fictional `555-0100`–`555-0199` range, including international ones
   - absolute home paths with a real username (`/Users/<name>/`)
   - forbidden files (`*.db`, `*.sqlite`, `.env*`, `config.json`, logs, exports, `.abcddb`)

   Fix every hit. There is no allowlist pragma. Use only reserved fakes: `example.com` emails and `555-01xx` numbers.
   CI also runs `npm run safety:all` with `--check-authors` on every push, so `--no-verify` doesn't skip it.
3. **Fixtures and examples are synthetic.** Never paste real conversation snippets, contact names, phone numbers or the user's own details. Not even "just for a test".

## Before every push: independent security audit

Spawn a fresh security subagent so the review isn't anchored on your own reasoning. Give it the diff, not your conclusions:

```
Agent(subagent_type: "general-purpose", description: "Security audit before push", prompt: """
You are auditing commits about to be pushed to a PUBLIC GitHub repository at <repo path>.
The software reads a user's private iMessage database on macOS and exposes it to AI agents over MCP.
Run `git log origin/main..HEAD --stat` (or `git log --stat` if there's no remote yet) and
`git diff origin/main..HEAD` (or `git show` for every commit), and read any new or changed files in full.

Report findings with file:line, severity, and a concrete fix for:
1. Secrets: API keys, tokens, passwords, private keys, OAuth client secrets, even in tests, docs or comments.
2. Personal data: real names, phone numbers, emails, message content, home paths with a username, machine
   identifiers, the commit author email (must be a users.noreply.github.com address).
3. Exploitable code: network listeners not bound to localhost or lacking auth; command or SQL injection;
   path traversal; unsafe child_process use; writes outside the state directory; logging of message content;
   prompt-injection paths where message text could trigger write actions or tool calls; overly broad
   permissions in launchd or sandbox flags.
4. Files that must never be committed: databases, logs, exports, .env, config.json.
Be adversarial. Say explicitly if you found nothing in a category.
""")
```

Fix every confirmed finding, commit the fix, re-run `npm run safety`, and re-audit if the fix was non-trivial. Then push.

## Cadence

Commit each working, tested milestone, and push after its audit passes. Don't batch a day of work into one unaudited push.
