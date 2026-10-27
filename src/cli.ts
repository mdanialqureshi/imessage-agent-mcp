#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBrief, formatItem } from './brief.ts';
import { configPath, loadConfig, paths } from './config.ts';
import { interpretNow } from './interpret/run.ts';
import { ChatDb, sweepSnapshots } from './messages/chatdb.ts';
import { Contacts } from './messages/contacts.ts';
import { Conversations } from './messages/conversations.ts';
import { httpToken, serveHttp, serveStdio } from './server.ts';
import { Store } from './store.ts';

const LABEL = 'com.imessage-agent-mcp';
const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const cliPath = fileURLToPath(import.meta.url);

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);
const option = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

function check(label: string, fn: () => string): boolean {
  try {
    console.log(`✅ ${label}: ${fn()}`);
    return true;
  } catch (err: any) {
    console.log(`❌ ${label}: ${err.message.split('\n')[0]}`);
    return false;
  }
}

function doctor(): void {
  const config = loadConfig();
  check('Config', () => configPath());
  check('Messages database', () => {
    const db = ChatDb.open();
    const n = db.maxRowid();
    db.close();
    return `${paths.chatDb} (${n.toLocaleString()} messages)`;
  });
  check('Contacts', () => {
    const n = Contacts.load().size;
    if (!n) throw new Error('no contacts readable — names will show as phone numbers');
    return `${n} phone numbers/emails`;
  });
  check(`Interpreter (${config.interpreter})`, () => {
    const out =
      config.interpreter === 'codex'
        ? execFileSync('codex', ['login', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        : execFileSync('claude', ['--version'], { encoding: 'utf8' });
    return out.trim().split('\n')[0];
  });
  check('State', () => {
    const store = Store.open();
    const open = store.listItems({ status: ['open'] }).length;
    const last = store.getMeta('last_interpreted_at');
    store.close();
    return `${open} open items, last interpreted ${last ?? 'never'}`;
  });
  check('Background service', () => {
    if (!fs.existsSync(plistPath)) throw new Error('not installed (run: install-service)');
    return plistPath;
  });
}

/** Prints what the interpreter would see, for review and labeling. */
function exportConversations(): void {
  const config = loadConfig();
  const days = Number(option('days') ?? 7);
  const db = ChatDb.open();
  const conv = new Conversations(db, Contacts.load(), config);
  const windows = conv.windowsForNew(db.newMessages(0, new Date(Date.now() - days * 86400_000)));
  windows.forEach((w, i) => (w.ref = `C${i + 1}`));
  const out = windows.map((w) => conv.render(w)).join('\n\n---\n\n');
  const file = option('out');
  if (file) {
    // Transcripts are private: created fresh, readable only by this user.
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, out + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`Wrote ${windows.length} conversations to ${file}`);
  } else console.log(out);
  db.close();
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Absolute path of a CLI on the current PATH, pinned into the service so PATH lookups can't be hijacked. */
function which(name: string): string | null {
  try {
    // Not realpath'd: self-updating CLIs keep a stable symlink while the versioned binary moves.
    return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function plist(): string {
  const config = loadConfig();
  const logDir = path.join(paths.stateDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const interpreterBin = which(config.interpreter);
  if (!interpreterBin) throw new Error(`${config.interpreter} not found on PATH; install and sign in first.`);
  // The CLIs need node (and git for codex) on PATH; system dirs only besides node's own.
  const env: Record<string, string> = {
    PATH: [path.dirname(fs.realpathSync(process.execPath)), '/usr/bin', '/bin'].join(':'),
    [`IMESSAGE_AGENT_${config.interpreter.toUpperCase()}_BIN`]: interpreterBin,
  };
  const envXml = Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('');
  const args = [process.execPath, cliPath, 'serve', '--http'].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const log = xml(path.join(logDir, 'service.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>${envXml}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

function installService(): void {
  const uid = process.getuid!();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' });
  } catch {
    // Not loaded yet.
  }
  fs.writeFileSync(plistPath, plist());
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  const node = fs.realpathSync(process.execPath);
  console.log(`Installed and started ${LABEL}.
Logs: ${path.join(paths.stateDir, 'logs/service.log')}

One manual step: give the background service Full Disk Access.
  System Settings → Privacy & Security → Full Disk Access → + → press ⌘⇧G and paste:
  ${node}
Then restart it:  launchctl kickstart -k gui/${uid}/${LABEL}
(Re-do this after upgrading Node, since the binary path changes.)`);
}

function uninstallService(): void {
  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid!()}`, plistPath], { stdio: 'ignore' });
  } catch {
    // Already stopped.
  }
  fs.rmSync(plistPath, { force: true });
  console.log(`Removed ${LABEL}.`);
}

async function main(): Promise<void> {
  sweepSnapshots();
  switch (command) {
    case 'doctor':
      return doctor();
    case 'export':
      return exportConversations();
    case 'interpret': {
      const res = await interpretNow({ dryRun: flag('dry-run') });
      if (res.prompts) console.log(res.prompts.join('\n\n=========== next batch ===========\n\n'));
      else console.log(JSON.stringify(res, null, 2));
      return;
    }
    case 'brief': {
      const store = Store.open();
      console.log(buildBrief(store, { since: option('since'), includeLowConfidence: flag('all') }));
      return store.close();
    }
    case 'items': {
      const store = Store.open();
      const items = store.listItems({ status: flag('all') ? undefined : ['open'] });
      console.log(items.map((i) => `${formatItem(i)}\n  status: ${i.status}`).join('\n') || 'No items.');
      return store.close();
    }
    case 'serve':
      if (flag('http')) await serveHttp({ autoInterpret: !flag('no-auto') });
      else await serveStdio();
      return;
    case 'token':
      return console.log(httpToken());
    case 'install-service':
      return installService();
    case 'uninstall-service':
      return uninstallService();
    default:
      console.log(`imessage-agent-mcp — iMessage commitments for any AI agent

Usage: node src/cli.ts <command>

  doctor               Check permissions, contacts, interpreter and service
  export [--days 7] [--out file]
                       Print conversations exactly as the interpreter sees them
  interpret [--dry-run]
                       Interpret new messages now (--dry-run prints the prompt only)
  brief [--since ISO] [--all]
                       Print the brief agents receive
  items [--all]        List tracked items
  serve                MCP over stdio (Claude Code/Desktop, Codex, Cursor)
  serve --http [--no-auto]
                       MCP over HTTP on localhost, interpreting in the background
  token                Print the bearer token HTTP clients must send
  install-service      Run "serve --http" at login via launchd
  uninstall-service    Remove the launchd service`);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
