// Checks a built imessage-agent.app: `npm run test:app` builds one and runs this.
// Skipped unless IMESSAGE_AGENT_APP points at the app.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildFixture } from './fixture.ts';

const app = process.env.IMESSAGE_AGENT_APP ? path.resolve(process.env.IMESSAGE_AGENT_APP) : undefined;
const skip = !app ? 'set IMESSAGE_AGENT_APP (npm run test:app)' : false;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const contents = app ? path.join(app, 'Contents') : '';
const node = path.join(contents, 'Helpers/node');
const cli = path.join(contents, 'Resources/app/src/cli.ts');
const reader = path.join(contents, 'Helpers/imessage-agent-reader.app');

const plist = (file: string, key: string) => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8' }).trim();
const signature = (target: string) => spawnSync('/usr/bin/codesign', ['-dv', target], { encoding: 'utf8' }).stderr;

/** A fresh, empty home folder, so nothing touches the real one. */
function fakeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'imessage-agent-home-'));
  fs.mkdirSync(path.join(home, 'Library/LaunchAgents'), { recursive: true });
  return home;
}
const env = (home: string, extra: NodeJS.ProcessEnv = {}) => ({ HOME: home, PATH: '/usr/bin:/bin', ...extra });
const runCli = (home: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
  spawnSync(node, [cli, ...args], { encoding: 'utf8', env: env(home, extra), timeout: 60_000 });

test('the app and everything in it is signed, and the reader keeps its protections', { skip }, () => {
  assert.equal(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app!]).status, 0, 'signature verifies');
  assert.match(signature(app!), /Identifier=com\.imessage-agent-mcp\.app\n/);
  const r = signature(reader);
  assert.match(r, /Identifier=com\.imessage-agent-mcp\.reader\n/);
  assert.match(r, /flags=0x\w+\([^)]*runtime/, 'the reader has the hardened runtime');
  assert.equal(plist(path.join(reader, 'Contents/Info.plist'), 'LSBackgroundOnly'), 'true');
  // The reader's Info.plist must stay minimal: no keys that change how it's launched or what it loads.
  const keys = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(reader, 'Contents/Info.plist')], { encoding: 'utf8' });
  assert.deepEqual(Object.keys(JSON.parse(keys)).sort(), ['CFBundleExecutable', 'CFBundleIconFile', 'CFBundleIdentifier', 'CFBundleName', 'CFBundlePackageType', 'CFBundleVersion', 'LSBackgroundOnly']);
  // Nobody but the owner can change anything inside it.
  for (const f of fs.readdirSync(reader, { recursive: true }) as string[]) {
    assert.equal(fs.statSync(path.join(reader, f)).mode & 0o022, 0, `${f} isn't writable by others`);
  }
});

test('Info.plist makes it a menu bar app with the right version', { skip }, () => {
  const info = path.join(contents, 'Info.plist');
  assert.equal(plist(info, 'CFBundleIdentifier'), 'com.imessage-agent-mcp.app');
  assert.equal(plist(info, 'LSUIElement'), 'true');
  assert.equal(plist(info, 'CFBundleShortVersionString'), JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
  assert.ok(fs.existsSync(path.join(contents, 'Resources/AppIcon.icns')));
  assert.ok(fs.existsSync(path.join(contents, 'Resources/node-LICENSE')), "Node's license ships with it");
});

test('it bundles the pinned Node and exactly the source in this repo', { skip }, () => {
  const build = fs.readFileSync(path.join(root, 'scripts/build-app.mjs'), 'utf8');
  const pinned = /version: '(v[\d.]+)'/.exec(build)![1];
  assert.equal(execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(), pinned);
  const hash = (dir: string) =>
    (fs.readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => fs.statSync(path.join(dir, f)).isFile())
      .sort()
      .map((f) => `${f} ${createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')}`);
  assert.deepEqual(hash(path.join(contents, 'Resources/app/src')), hash(path.join(root, 'src')));
});

test('nothing private or unexpected is in the bundle', { skip }, () => {
  const files = fs.readdirSync(app!, { recursive: true }) as string[];
  const bad = files.filter((f) => /(\.db|\.sqlite3?|\.abcddb|\.log|\.env|config\.json|\.sock)$/.test(f) && !f.includes('node_modules/'));
  assert.deepEqual(bad, []);
  assert.ok(!files.some((f) => f.includes('/Users/')), 'no home paths in file names');
  // The only native code is the app, Node and the reader.
  const machO = files.filter((f) => {
    const p = path.join(app!, f);
    if (!fs.statSync(p).isFile()) return false;
    const magic = fs.readFileSync(p).subarray(0, 4).toString('hex');
    return ['cafebabe', 'cffaedfe', 'cefaedfe'].includes(magic);
  });
  assert.deepEqual(machO.sort(), ['Contents/Helpers/imessage-agent-reader.app/Contents/MacOS/imessage-agent-reader', 'Contents/Helpers/node', 'Contents/MacOS/imessage-agent']);
});

test('the menu bar app runs the bundled CLI and understands its status', { skip }, () => {
  const res = spawnSync(path.join(contents, 'MacOS/imessage-agent'), ['--self-test'], { encoding: 'utf8', env: env(fakeHome()), timeout: 60_000 });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /^self-test ok: .* mode app, reader signed, install none/m);
});

test('in the app, the CLI uses the bundled Node and reader', { skip }, () => {
  const home = fakeHome();
  const res = runCli(home, ['status', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const status = JSON.parse(res.stdout);
  assert.equal(status.mode, 'app');
  assert.equal(status.reader.path, reader);
  assert.equal(status.reader.valid, true);
  assert.equal(status.install.state, 'none');
  assert.ok(status.callCommand.startsWith(`${node} ${cli} call`), status.callCommand);

  // Connecting an app registers the bundled Node and CLI as the bridge.
  const claudeDir = path.join(home, 'Library/Application Support/Claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  assert.equal(runCli(home, ['connect-app', 'claude-desktop']).status, 0);
  const config = JSON.parse(fs.readFileSync(path.join(claudeDir, 'claude_desktop_config.json'), 'utf8'));
  assert.deepEqual(config.mcpServers.imessage, { command: node, args: [cli, 'connect'] });
  assert.equal(runCli(home, ['disconnect-app', 'claude-desktop']).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(claudeDir, 'claude_desktop_config.json'), 'utf8')).mcpServers.imessage, undefined);

  // Settings are checked before they're saved.
  assert.equal(runCli(home, ['config', 'set', 'autoInterpretMinutes', '60']).status, 0);
  assert.notEqual(runCli(home, ['config', 'set', 'autoInterpretMinutes', '"soon"']).status, 0);
  assert.notEqual(runCli(home, ['config', 'set', 'interpreter', '"codex"']).status, 0);
  assert.equal(runCli(home, ['config', 'set', 'privateContacts', '["Sam Example"]']).status, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'Library/Application Support/imessage-agent-mcp/config.json'), 'utf8'));
  assert.equal(saved.autoInterpretMinutes, 60);
  assert.deepEqual(saved.privateContacts, ['Sam Example']);
});

test('the bundled service starts and answers MCP calls through the bridge', { skip }, async () => {
  const home = fakeHome();
  const fixture = buildFixture(path.join(home, 'fixture'));
  // Unix socket paths are limited to 104 bytes, so the state folder gets a short path.
  fs.mkdirSync(path.join(root, 'test/.tmp'), { recursive: true });
  const state = fs.mkdtempSync(path.join(root, 'test/.tmp/s-'));
  const serve = spawn(node, [cli, 'serve', '--no-auto'], { env: env(home, { ...fixture, IMESSAGE_AGENT_STATE_DIR: state }), stdio: 'ignore' });
  try {
    const sock = path.join(state, 'mcp.sock');
    for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(sock), 'the service opened its socket');
    assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
    const call = (...args: string[]) => runCli(home, ['call', ...args], { ...fixture, IMESSAGE_AGENT_STATE_DIR: state });
    const list = call();
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /get_brief/);
    const brief = call('get_brief', '{}');
    assert.equal(brief.status, 0, brief.stderr);
    assert.match(brief.stdout, /untrusted|written by other people/i);
  } finally {
    serve.kill();
  }
});

test("the repo's test suite passes under the bundled Node", { skip }, () => {
  // Not inherited: under `node --test`, NODE_TEST_CONTEXT makes a nested runner report to its parent instead of printing.
  const { NODE_TEST_CONTEXT: _, IMESSAGE_AGENT_APP: __, ...clean } = process.env;
  const res = spawnSync(node, ['--test', '--test-reporter=spec', path.join(root, 'test/pipeline.test.ts')], { encoding: 'utf8', cwd: root, env: clean, timeout: 300_000 });
  assert.equal(res.status, 0, res.stdout.slice(-3000) + res.stderr.slice(-2000));
  assert.match(res.stdout, /fail 0/);
});
