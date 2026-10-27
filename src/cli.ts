#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBrief, formatItem } from './brief.ts';
import { type Config, configPath, ensureStateDir, INTERPRETERS, type InterpreterName, loadConfig, loadConfigDefaults, paths, saveConfig } from './config.ts';
import { interpretNow } from './interpret/run.ts';
import { ChatDb, sweepSnapshots } from './messages/chatdb.ts';
import { Contacts } from './messages/contacts.ts';
import { Conversations } from './messages/conversations.ts';
import { compileReader, READER_BUILD, READER_LABEL, readerBinary, readerStatus, STALE_MS } from './messages/mirror.ts';
import { APPS, which } from './apps.ts';
import { bridge, callTool, type ServiceHealth, serviceHealth } from './bridge.ts';
import { serveSocket, socketPath } from './server.ts';
import { Store } from './store.ts';

const LABEL = 'com.imessage-agent-mcp';
const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const readerPlistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${READER_LABEL}.plist`);
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

/** What desktop apps launch: the permission-less bridge to the background service. */
function bridgeCommand(): string[] {
  // The stable Homebrew/nvm symlink survives Node upgrades better than the versioned binary.
  return [which('node') ?? process.execPath, cliPath, 'connect'];
}

function fdaHelp(): string {
  return `Give imessage-agent's reader Full Disk Access (macOS requires you to do this yourself):
  1. System Settings → Privacy & Security → Full Disk Access
  2. Click +, press ⌘⇧G, paste the path below, press Return, then Open:
     ${readerBinary()}
  3. Make sure its switch is on.
  The reader only copies Messages and Contacts into imessage-agent's private folder; it takes no
  input and can't be pointed at anything else. Node, your terminal and your apps don't need access.
  If you gave node Full Disk Access for this earlier, you can turn that off.`;
}

const readerSource = path.join(path.dirname(cliPath), '..', 'helper', 'reader.c');

/**
 * Compiles the reader with Apple's Command Line Tools, only when its source changed: a new
 * build has a new signature, so macOS asks for Full Disk Access again. Returns true if built.
 */
function buildReader(): boolean {
  const bin = readerBinary();
  const stamp = `${bin}.sha256`;
  const hash = createHash('sha256').update(fs.readFileSync(readerSource)).update(JSON.stringify(READER_BUILD)).digest('hex');
  if (fs.existsSync(bin) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === hash) return false;
  if (spawnSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' }).status !== 0) {
    throw new Error("its reader is built with Apple's Command Line Tools: run `xcode-select --install`, then setup again");
  }
  ensureStateDir();
  fs.mkdirSync(path.dirname(bin), { recursive: true, mode: 0o700 });
  const tmp = `${bin}.new`;
  compileReader(readerSource, tmp);
  fs.renameSync(tmp, bin);
  fs.writeFileSync(stamp, hash + '\n');
  return true;
}

async function doctor(): Promise<void> {
  const config = loadConfig();
  console.log('This Mac (everything runs here; no network port is opened)');
  const health = await serviceHealth(socketPath());
  check('Background service', () => {
    if (!fs.existsSync(plistPath)) throw new Error('not installed (run: node src/cli.ts setup)');
    if (!health) throw new Error(`installed but not responding; see ${path.join(paths.stateDir, 'logs/service.log')}`);
    return `running, listening only on ${socketPath()}`;
  });
  if (health) {
    const ok = check('Full Disk Access', () => {
      if (!fs.existsSync(readerBinary())) throw new Error('the reader is missing (run: node src/cli.ts setup)');
      if (!health.canReadMessages) {
        const status = readerStatus();
        const log = path.join(paths.stateDir, 'logs/reader.log');
        throw new Error(status?.ok && Date.now() - status.at >= STALE_MS
          ? `the reader isn't answering, so the service's copy of Messages is out of date; see ${log}`
          : status?.error === 'EFAIL'
            ? `the reader couldn't copy Messages; see ${log}`
            : "the reader doesn't have it yet, so the service can't read Messages");
      }
      return `only the reader has it, and the service can read its copy (${health.messages.toLocaleString()} messages, ${health.contacts} contact handles)`;
    });
    if (!ok) console.log(fdaHelp().replace(/^/gm, '   '));
  }
  for (const name of INTERPRETERS) {
    const active = name === config.interpreter;
    const ok = check(`Interpreter ${name}${active ? ' (active)' : ''}`, () => interpreterStatus(name));
    if (!ok && active) console.log(`   Fix: sign in (\`${name === 'claude' ? 'claude' : 'codex login'}\`) or switch: node src/cli.ts use ${name === 'claude' ? 'codex' : 'claude'}`);
  }
  check('State', () => {
    const store = Store.open();
    const open = store.listItems({ status: ['open'] }).length;
    const last = store.getMeta('last_interpreted_at');
    store.close();
    return `${open} open items, last interpreted ${last ?? 'never'} (${configPath()})`;
  });
  console.log('\nApps that can use it (they launch the local bridge; cloud agents reach your Mac through them)');
  for (const app of APPS) {
    if (!app.installed()) console.log(`➖ ${app.name}: not installed`);
    else if (app.registered()) console.log(`✅ ${app.name}: connected. ${app.reach}`);
    else console.log(`➖ ${app.name}: installed, not connected (optional: node src/cli.ts setup --apps ${app.id})`);
  }
  console.log(`\nAgents that run commands but don't list the imessage tools (e.g. Dot, for now) can use:\n   ${callCommand()}            lists the tools\n   ${callCommand()} <tool> '<json args>'`);
}

/** The exact `call` command for this install, to paste into an agent's instructions. */
const callCommand = () => [which('node') ?? process.execPath, cliPath].map(shellQuote).join(' ') + ' call';
const shellQuote = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

function waitForService(ms: number): Promise<ServiceHealth | null> {
  const until = Date.now() + ms;
  const attempt = async (): Promise<ServiceHealth | null> => {
    const h = await serviceHealth(socketPath());
    if (h || Date.now() > until) return h;
    await new Promise((r) => setTimeout(r, 500));
    return attempt();
  };
  return attempt();
}

/** One command: interpreter, background service, app connections, permission check. */
async function setup(): Promise<void> {
  const chosen = option('interpreter');
  if (chosen) useInterpreter(chosen);
  if (process.exitCode) return;
  const config = loadConfig();

  console.log(`\n1. Interpreter: ${config.interpreter}`);
  try {
    console.log(`   ✅ ${interpreterStatus(config.interpreter)}`);
  } catch (err: any) {
    console.log(`   ❌ ${err.message}`);
    console.log(`   Sign in, then run setup again. To use the other one: node src/cli.ts setup --interpreter ${config.interpreter === 'claude' ? 'codex' : 'claude'}`);
    process.exitCode = 1;
    return;
  }

  console.log('\n2. Background service (runs on this Mac at login; Unix socket only, no network port)');
  try {
    if (buildReader()) console.log(`   Built its reader, the only part that will hold Full Disk Access: ${readerBinary()}`);
  } catch (err: any) {
    console.log(`   ❌ ${err.message.split('\n')[0]}`);
    process.exitCode = 1;
    return;
  }
  installService();
  const health = await waitForService(15_000);
  if (!health) {
    console.log(`   ❌ didn't start; see ${path.join(paths.stateDir, 'logs/service.log')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`   ✅ running: ${socketPath()}`);

  console.log('\n3. Connecting your apps (each launches a local bridge to the service)');
  const only = option('apps')?.split(',');
  const command = bridgeCommand();
  for (const app of APPS) {
    if (only && !only.includes(app.id)) continue;
    if (!app.installed()) {
      console.log(`   ➖ ${app.name}: not installed, skipped`);
      continue;
    }
    try {
      app.register(command);
      console.log(`   ✅ ${app.name}`);
    } catch (err: any) {
      console.log(`   ❌ ${app.name}: ${err.message.split('\n')[0]}`);
    }
  }

  console.log('\n4. Permission to read Messages');
  let access = health;
  if (!access.canReadMessages) {
    console.log(fdaHelp().replace(/^/gm, '   '));
    if (!flag('no-open')) {
      const pane = spawnSync('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles']).status === 0;
      const shown = spawnSync('/usr/bin/open', ['-R', readerBinary()]).status === 0; // Finder hides ~/Library.
      if (pane && shown) console.log('   Opened Full Disk Access in System Settings and showed the reader in Finder: drag it into the list.');
    }
    if (process.stdout.isTTY && !flag('no-wait')) {
      console.log('\n   Waiting for access (Ctrl-C to finish later with: node src/cli.ts doctor)…');
      for (let i = 0; i < 120 && !access?.canReadMessages; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        access = await waitForService(20_000); // Each check runs the reader again.
      }
    }
  }
  if (access?.canReadMessages) {
    console.log(`   ✅ the service can read Messages (${access.messages.toLocaleString()} messages)`);
    console.log(`   It's reading the last ${config.firstRunLookbackDays} days now, then every ${config.autoInterpretMinutes} minutes. Preview: node src/cli.ts brief`);
  } else {
    console.log('\n   After granting access, check with: node src/cli.ts doctor');
  }

  console.log(`
Done. How it fits together:
  Messages ─► reader (the only part with Full Disk Access) ─► private copy ─► background service ─► local bridge
    ─► ChatGPT / Claude desktop app ─► your agent
  Nothing listens on the network. Cloud agents (like Dot on your phone) can only reach the data through a desktop
  app running on this Mac, so the Mac needs to be on and awake. (Dot reaches the Mac this way, but doesn't list the
  imessage tools natively yet; it can use \`${callCommand()}\` meanwhile.)

Next steps (also in the README, "Connect your agents"):
  • Restart Claude desktop and ChatGPT desktop so they load the new connection.
  • Dot: in the ChatGPT desktop app, open your Dot's profile → Computers → Allow access.
  • Tell Dot: "For my texts, use the imessage tools on my Mac. If they aren't in your tool list, run
    \`${callCommand()}\` to list them and \`${callCommand()} <tool> '<json args>'\` to use one."
  • Ask your agent: "Use the imessage tools: what did I commit to in my texts this week?"
  • Set your cadence: "Every day at 9am and 6pm, check my imessage brief and tell me what needs attention."`);
}

function uninstall(): void {
  for (const app of APPS) {
    try {
      if (app.installed() && app.registered()) {
        app.unregister();
        console.log(`Disconnected ${app.name}`);
      }
    } catch (err: any) {
      console.log(`Couldn't disconnect ${app.name}: ${err.message.split('\n')[0]}`);
    }
  }
  uninstallService();
  if (flag('delete-data')) {
    fs.rmSync(paths.stateDir, { recursive: true, force: true });
    console.log(`Deleted ${paths.stateDir}`);
  } else console.log(`Kept your items in ${paths.stateDir} (add --delete-data to remove them).`);
  console.log('You can also remove imessage-agent-reader from Full Disk Access in System Settings.');
}

/**
 * Whether an interpreter CLI is installed and signed in with a subscription. Only the
 * auth method is read; account details (like the email) are never printed.
 */
function interpreterStatus(name: InterpreterName): string {
  if (name === 'claude') {
    if (process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is set in this shell, so terminal runs would bill the API; unset it');
    const status = JSON.parse(execFileSync('claude', ['auth', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    if (!status.loggedIn) throw new Error('not signed in (run: claude)');
    if (status.authMethod !== 'claude.ai') throw new Error(`signed in via ${status.authMethod}: this would bill API usage, sign in with your Claude plan instead`);
    return 'signed in with a Claude plan';
  }
  // codex prints its login status on stderr.
  const res = spawnSync('codex', ['login', 'status'], { encoding: 'utf8' });
  if (res.error) throw new Error('not installed');
  // Never echo the status line: for API-key logins it contains part of the key.
  if (res.status !== 0 || !/ChatGPT/i.test(`${res.stdout}${res.stderr}`)) {
    throw new Error('not signed in with a ChatGPT plan; run `codex login` to avoid API billing');
  }
  for (const key of ['CODEX_API_KEY', 'OPENAI_API_KEY']) {
    if (process.env[key]) throw new Error(`${key} is set in this shell, so terminal runs would bill the API; unset it`);
  }
  return 'signed in with a ChatGPT plan';
}

function useInterpreter(name: string | undefined): void {
  if (!INTERPRETERS.includes(name as InterpreterName)) {
    console.log(`Usage: node src/cli.ts use <${INTERPRETERS.join('|')}>`);
    process.exitCode = 1;
    return;
  }
  // Read the raw file so `use` can also repair a config with an invalid interpreter.
  let current: Partial<Config> = {};
  if (fs.existsSync(configPath())) {
    try {
      current = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    } catch {
      // Never fall back to defaults here: that would silently drop settings like privateContacts.
      console.log(`${configPath()} isn't valid JSON. Fix it (or delete it to start over), then run this again.`);
      process.exitCode = 1;
      return;
    }
  }
  saveConfig({ ...loadConfigDefaults(), ...current, interpreter: name as InterpreterName });
  console.log(`Interpreter set to ${name}. The background service uses it from its next run.`);
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

function plist(): string {
  const config = loadConfig();
  // Both CLIs are pinned when installed (not realpath'd: self-updating CLIs keep a stable
  // symlink), so `use codex` / `use claude` works without reinstalling.
  const env: Record<string, string> = {
    PATH: [path.dirname(fs.realpathSync(process.execPath)), '/usr/bin', '/bin'].join(':'),
    IMESSAGE_AGENT_MIRROR: '1', // Read the reader's copy; node itself holds no special access.
  };
  for (const name of INTERPRETERS) {
    const found = which(name);
    if (found) env[`IMESSAGE_AGENT_${name.toUpperCase()}_BIN`] = found;
  }
  if (!env[`IMESSAGE_AGENT_${config.interpreter.toUpperCase()}_BIN`]) {
    throw new Error(`${config.interpreter} not found on PATH; install and sign in first, or: node src/cli.ts use <claude|codex>`);
  }
  const envXml = Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('');
  const args = [process.execPath, cliPath, 'serve'].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return launchdPlist(LABEL, 'service.log', `  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>${envXml}</dict>
  <key>KeepAlive</key><true/>`);
}

/**
 * The reader is its own launchd job, so macOS attributes its file access to it alone and
 * node never needs Full Disk Access. It runs at login and whenever the service asks
 * (`launchctl kickstart`), with no arguments or environment of ours.
 */
function readerPlist(): string {
  return launchdPlist(READER_LABEL, 'reader.log', `  <key>Program</key><string>${xml(readerBinary())}</string>
  <key>ProcessType</key><string>Background</string>`);
}

function launchdPlist(label: string, logName: string, body: string): string {
  const logDir = path.join(paths.stateDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const log = xml(path.join(logDir, logName));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
${body}
  <key>RunAtLoad</key><true/>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

const bootout = (file: string) => {
  try {
    execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid!()}`, file], { stdio: 'ignore' });
  } catch {
    // Not loaded.
  }
};

function installService(): void {
  if (!fs.existsSync(readerBinary())) throw new Error('the reader is missing; run: node src/cli.ts setup');
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  for (const [file, content] of [[readerPlistPath, readerPlist()], [plistPath, plist()]]) {
    bootout(file);
    fs.writeFileSync(file, content);
    execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid!()}`, file]);
  }
  console.log(`   Installed ${READER_LABEL} and ${LABEL} (logs: ${path.join(paths.stateDir, 'logs')})`);
}

/** Also deletes the reader and its copy of Messages, which setup recreates. */
function uninstallService(): void {
  for (const file of [plistPath, readerPlistPath]) {
    bootout(file);
    fs.rmSync(file, { force: true });
  }
  fs.rmSync(socketPath(), { force: true });
  for (const name of ['mirror', 'reader-status', 'bin']) fs.rmSync(path.join(paths.stateDir, name), { recursive: true, force: true });
  console.log(`Removed the background service (${LABEL}), its reader and its copy of Messages.`);
}

async function main(): Promise<void> {
  sweepSnapshots();
  switch (command) {
    case 'setup':
      return setup();
    case 'connect':
      return bridge(socketPath());
    case 'call': {
      const usage = `Arguments must be one JSON object, e.g. call search_messages '{"query":"tuesday"}'`;
      if (rest.length > 2) throw new Error(usage);
      let args: unknown = {};
      if (rest[1]) {
        try {
          args = JSON.parse(rest[1]);
        } catch {
          throw new Error(usage);
        }
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error(usage);
      const res = await callTool(socketPath(), rest[0], args as Record<string, unknown>);
      // Exit as soon as the answer is out; agents wait on the process, not the output.
      process.stdout.write(res.text + '\n', () => process.exit(res.isError ? 1 : 0));
      return;
    }
    case 'uninstall':
      return uninstall();
    case 'doctor':
      return doctor();
    case 'export':
      return exportConversations();
    case 'interpret': {
      const override = option('interpreter') as InterpreterName | undefined;
      if (override && !INTERPRETERS.includes(override)) throw new Error(`--interpreter must be ${INTERPRETERS.join(' or ')}`);
      const config = loadConfig();
      const res = await interpretNow({ dryRun: flag('dry-run'), config: override ? { ...config, interpreter: override } : config });
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
      await serveSocket({ autoInterpret: !flag('no-auto') });
      return;
    case 'use':
      return useInterpreter(rest[0]);
    case 'install-service':
      buildReader();
      return installService();
    case 'uninstall-service':
      return uninstallService();
    default:
      console.log(`imessage-agent-mcp: your iMessage commitments for any AI agent, running only on this Mac.

Usage: node src/cli.ts <command>

Setup
  setup [--interpreter claude|codex] [--apps chatgpt,claude-desktop,claude-code,cursor]
                       Install the background service and connect your apps
  doctor               Check the service, permissions, interpreter and connected apps
  use <claude|codex>   Choose which subscription CLI reads your messages
  uninstall [--delete-data]
                       Disconnect apps and remove the service

Everyday
  brief [--since ISO] [--all]
                       Print the brief agents receive
  items [--all]        List tracked items
  call [tool] [json]   Call an MCP tool through the service, for agents that run commands
                       instead of loading MCP servers (no tool lists them)

Plumbing
  connect              The local bridge apps launch (MCP over stdio → the service)
  serve [--no-auto]    The background service (what launchd runs)
  install-service | uninstall-service
                       Just the launchd service
  interpret [--dry-run] [--interpreter claude|codex]
  export [--days 7] [--out file]
                       Debugging from a terminal; these need Full Disk Access for the terminal itself`);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
