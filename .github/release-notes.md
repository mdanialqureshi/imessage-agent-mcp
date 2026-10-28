**Download `imessage-agent-*.dmg`**, open it, and drag **imessage-agent** into Applications. (The `.zip` has the same app.)

The first time you open it, macOS says it can't verify the app, because it isn't notarized by Apple (that needs a paid developer account). To open it:

1. Click **Done** in that message.
2. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to "imessage-agent was blocked".
3. Confirm, and enter your password if asked.

The app then walks you through setup. It needs [Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex) signed in with your subscription.

**Updating:** replace the app in Applications with the new one and open it. The new version's reader is a new program to macOS, so the setup window asks you to switch on Full Disk Access for it again.

`SHA256SUMS.txt` lists the files' checksums. The app is built from this tag by the workflow in `.github/workflows/release.yml`; you can also build it yourself with `npm run build:app`.
