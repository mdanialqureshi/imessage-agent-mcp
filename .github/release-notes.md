**Download `Messages-Agent-*.dmg`**, open it, and drag **Messages Agent** into Applications. (The `.zip` has the same app.)

The first time you open it, macOS says it can't verify the app, because it isn't notarized by Apple (that needs a paid developer account). To open it:

1. Click **Done** in that message.
2. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to "Messages Agent was blocked".
3. Confirm, and enter your password if asked.

The app then walks you through setup. It needs [Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex) signed in with your subscription.

**Updating:** once installed, the app checks for new versions daily (you can switch that off in Settings) and shows **Install Update** in its menu. It installs only signed releases from this repo, and only when you click. You can also replace the app in Applications by hand. Full Disk Access stays on unless a release changes the reader; then the setup window asks you to switch it on for the new one.

`SHA256SUMS.txt` lists the files' checksums. The app is built from this tag by the workflow in `.github/workflows/release.yml`; you can also build it yourself with `npm run build:app`.
