import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appBundle, paths } from '../config.ts';

/**
 * The background service never opens Messages or Contacts itself. imessage-agent-reader
 * (helper/reader.c) is a separate launchd job and the only thing holding Full Disk Access;
 * it copies both databases into <state>/mirror, and the service reads those copies.
 */
export const READER_LABEL = 'com.imessage-agent-mcp.reader';

export const usingMirror = () => process.env.IMESSAGE_AGENT_MIRROR === '1';

/**
 * The reader is a small app. The Mac app ships one prebuilt inside it; a clone builds one in
 * ~/Applications, where Finder and the Full Disk Access file picker can find it (~/Library is
 * hidden). A new build has a new signature, so macOS asks for access again.
 */
export const readerApp = () =>
  appBundle ? path.join(appBundle, 'Contents/Helpers/imessage-agent-reader.app') : path.join(os.homedir(), 'Applications', 'imessage-agent-reader.app');
export const readerBinary = (app = readerApp()) => path.join(app, 'Contents/MacOS/imessage-agent-reader');

/**
 * How the reader is built and signed. The hardened runtime is essential: without it, anything
 * running as the user could inject a library into the reader and inherit its Full Disk Access.
 * Part of setup's rebuild check, so changing it rebuilds existing installs.
 */
export const READER_BUILD = {
  cc: ['-O2', '-Wall', '-lsqlite3'],
  codesign: ['--force', '--sign', '-', '--options', 'runtime', '--identifier', READER_LABEL],
};

/** The app's Info.plist: a background-only app, so opening it by hand just runs one copy. */
export const READER_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${READER_LABEL}</string>
  <key>CFBundleName</key><string>imessage-agent-reader</string>
  <key>CFBundleExecutable</key><string>imessage-agent-reader</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
`;

/**
 * Compiles the reader into a new app at `app` and signs it. Tests pass `-DREADER_HOME=…` to
 * aim it at a fake home. The Mac app's build gives it the app's icon, so it's easy to spot in
 * the Full Disk Access list.
 */
export function compileReader(source: string, app: string, defines: string[] = [], icon?: string): void {
  fs.mkdirSync(path.dirname(readerBinary(app)), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), READER_INFO);
  if (icon) {
    fs.mkdirSync(path.join(app, 'Contents/Resources'), { mode: 0o755 });
    fs.copyFileSync(icon, path.join(app, 'Contents/Resources/AppIcon.icns'));
    fs.chmodSync(path.join(app, 'Contents/Resources'), 0o755);
    fs.chmodSync(path.join(app, 'Contents/Resources/AppIcon.icns'), 0o644);
  }
  execFileSync('/usr/bin/cc', [...defines, ...READER_BUILD.cc, '-o', readerBinary(app), source], { stdio: ['ignore', 'pipe', 'pipe'] });
  // Explicit modes, whatever the umask: nobody else may be able to swap the program out.
  for (const dir of [app, path.join(app, 'Contents'), path.dirname(readerBinary(app))]) fs.chmodSync(dir, 0o755);
  fs.chmodSync(path.join(app, 'Contents/Info.plist'), 0o644);
  fs.chmodSync(readerBinary(app), 0o755);
  execFileSync('/usr/bin/codesign', [...READER_BUILD.codesign, app], { stdio: 'ignore' });
}

/**
 * The reader's code hash when its signature is intact, else null. macOS ties Full Disk Access
 * to this hash, so a changed or damaged reader shows up here.
 */
export function readerCdHash(app = readerApp()): string | null {
  if (spawnSync('/usr/bin/codesign', ['--verify', '--strict', app], { stdio: 'ignore' }).status !== 0) return null;
  const info = spawnSync('/usr/bin/codesign', ['-dvvv', app], { encoding: 'utf8' });
  return /^CDHash=([0-9a-f]+)$/m.exec(info.stderr ?? '')?.[1] ?? null;
}

/** A clone's reader, which the Mac app replaces with its own. */
export const CLI_READER_APP = path.join(os.homedir(), 'Applications', 'imessage-agent-reader.app');

/**
 * Makes sure the reader is in place. The app ships its own, so a reader left by a clone is
 * removed. A clone compiles one with Apple's Command Line Tools, only when its source changed
 * or the installed one isn't exactly what was built: a new build has a new signature, so macOS
 * asks for Full Disk Access again. Returns true if it built one.
 */
export function installReader(
  source: string,
  { app = readerApp(), stateDir = paths.stateDir, inApp = Boolean(appBundle), cliReader = CLI_READER_APP } = {},
): boolean {
  fs.rmSync(path.join(stateDir, 'bin'), { recursive: true, force: true }); // Where older versions kept it.
  if (inApp) {
    if (!readerCdHash(app)) throw new Error('the reader inside imessage-agent.app is missing or damaged; download the app again');
    fs.rmSync(cliReader, { recursive: true, force: true });
    return false;
  }
  const stamp = path.join(stateDir, 'reader.sha256'); // Outside the app: changing the app breaks its signature.
  const hash = createHash('sha256').update(fs.readFileSync(source)).update(JSON.stringify(READER_BUILD)).update(READER_INFO).digest('hex');
  const [built, cdhash] = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim().split(' ') : [];
  if (built === hash && cdhash && readerCdHash(app) === cdhash) return false;
  if (spawnSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' }).status !== 0) {
    throw new Error("its reader is built with Apple's Command Line Tools: run `xcode-select --install`, then setup again");
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  privateApplicationsDir(path.dirname(app));
  const tmp = path.join(stateDir, 'reader-build.app'); // Usually the same disk as ~/Applications, so the move is a rename.
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    compileReader(source, tmp);
    const fresh = readerCdHash(tmp);
    if (!fresh) throw new Error("the reader's signature didn't verify after building it");
    fs.rmSync(app, { recursive: true, force: true });
    fs.renameSync(tmp, app);
    fs.writeFileSync(stamp, `${hash} ${fresh}\n`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return true;
}

/** ~/Applications must be a real folder of ours that nobody else can write to. */
function privateApplicationsDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
  }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid!() || st.mode & 0o022) {
    throw new Error(`${dir} must be a folder you own that other users can't write to (try: chmod go-w "${dir}")`);
  }
}

/**
 * Refuses a program (or anything on the way to it) that another account could change:
 * everything must belong to you or the system, with no write access for other users.
 */
export function assertOnlyYoursToChange(file: string): void {
  // Every link on the way (its own folders decide who can repoint it) and where it all leads.
  for (const p of pathsOnTheWay(file)) checkChain(p);
}

/** Each link met while resolving file, one hop at a time, then the resolved path. */
function pathsOnTheWay(file: string): string[] {
  const found: string[] = [];
  let pending = path.resolve(file);
  for (let hops = 0; hops < 40; hops++) {
    const parts = pending.split('/').filter(Boolean);
    let prefix = '/';
    let i = 0;
    for (; i < parts.length; i++) {
      const next = path.join(prefix, parts[i]);
      if (fs.lstatSync(next).isSymbolicLink()) break;
      prefix = next;
    }
    if (i === parts.length) return [...found, pending];
    const link = path.join(prefix, parts[i]);
    found.push(link);
    pending = path.join(path.resolve(prefix, fs.readlinkSync(link)), ...parts.slice(i + 1));
  }
  throw new Error(`${file} goes through too many links`);
}

function checkChain(start: string): void {
  const me = process.getuid!();
  let p = start;
  for (;;) {
    const st = fs.lstatSync(p);
    if (process.platform === 'darwin' && sharedByAcl(p)) {
      throw new Error(`${p} could be changed by another account on this Mac (an access-control list lets others write to it), and the background service would run it as you.`);
    }
    // Group write is fine for wheel and admin (like /Applications or Homebrew's folders): their members can change anything anyway.
    const systemGroupWrite = st.gid === 0 || st.gid === 80;
    if ((st.uid !== me && st.uid !== 0) || st.mode & 0o002 || (st.mode & 0o020 && !systemGroupWrite)) {
      throw new Error(`${p} could be changed by another account on this Mac, and the background service would run it as you. Install it somewhere only you (or the system) can change.`);
    }
    if (p === '/') return;
    p = path.dirname(p);
  }
}

/** Access-control permissions that let someone change a file or what a folder holds. */
const ACL_WRITES = new Set(['write', 'append', 'writeextattr', 'writesecurity', 'chown', 'add_file', 'add_subdirectory', 'delete_child']);

/** Whether an access-control list lets anyone else write to, add to or delete from p. */
function sharedByAcl(p: string): boolean {
  const res = spawnSync('/bin/ls', ['-led', p], { encoding: 'utf8' });
  // Like the mode bits: you, and the groups that can change the system anyway.
  const trusted = new Set([`user:${os.userInfo().username}`, 'group:admin', 'group:wheel']);
  return (res.stdout ?? '')
    .split('\n')
    .slice(1)
    .some((line) => {
      // Parsed from the end, since a directory group's name can contain spaces.
      const m = /^\s*\d+:\s+(.+?)\s+(?:inherited\s+)?allow\s+([a-z_,]+)\s*$/.exec(line);
      if (!m || trusted.has(m[1])) return false;
      const perms = m[2].split(',');
      return !perms.includes('only_inherit') && perms.some((perm) => ACL_WRITES.has(perm));
    });
}

export interface ReaderStatus {
  ok: boolean;
  /** EPERM: no Full Disk Access. EFAIL: anything else (retried on the next read). */
  error?: 'EPERM' | 'EFAIL';
  at: number;
}

/** The reader's last result, from <state>/reader-status ("ok <ms>" or "error <code> <ms>"). */
export function readerStatus(): ReaderStatus | null {
  let line: string;
  try {
    line = fs.readFileSync(path.join(paths.stateDir, 'reader-status'), 'utf8').trim();
  } catch {
    return null;
  }
  const [state, a, b] = line.split(' ');
  if (state === 'ok' && Number(a)) return { ok: true, at: Number(a) };
  if (state === 'error' && Number(b)) return { ok: false, error: a === 'EPERM' ? 'EPERM' : 'EFAIL', at: Number(b) };
  return null;
}

export const NEEDS_ACCESS =
  "The imessage-agent service on the user's Mac can't read Messages yet: its reader needs Full Disk Access " +
  '(run `node src/cli.ts doctor` on the Mac).';

/** A copy older than this means the reader has stopped answering, so it isn't used. */
export const STALE_MS = 10 * 60_000;

/** Why the copy can't be used, for agents; null when it can. */
export function mirrorProblem(status: ReaderStatus | null): string | null {
  if (status?.ok) {
    if (Date.now() - status.at < STALE_MS) return null;
    return "The imessage-agent service's copy of Messages is out of date because its reader isn't answering (run `node src/cli.ts doctor` on the Mac).";
  }
  if (!status || status.error === 'EPERM') return NEEDS_ACCESS;
  return "The imessage-agent service on the user's Mac couldn't copy Messages just now. Try again in a minute.";
}

const kickstart = () =>
  new Promise<void>((resolve) =>
    execFile('/bin/launchctl', ['kickstart', `gui/${process.getuid!()}/${READER_LABEL}`], { timeout: 5000 }, () => resolve()),
  );

let inFlight: Promise<ReaderStatus | null> | null = null;

/**
 * A copy at most `maxAgeMs` old. Asks launchd to run the reader when the copy is older, and
 * waits up to `waitMs` for it; concurrent callers share one run.
 */
export function freshMirror({ maxAgeMs = 60_000, waitMs = 15_000, kick = kickstart } = {}): Promise<ReaderStatus | null> {
  const current = readerStatus();
  if (current?.ok && Date.now() - current.at < maxAgeMs) return Promise.resolve(current);
  inFlight ??= (async () => {
    const before = current?.at ?? 0;
    await kick();
    const until = Date.now() + waitMs;
    for (;;) {
      const status = readerStatus();
      if ((status && status.at > before) || Date.now() > until) return status;
      await new Promise((r) => setTimeout(r, 200));
    }
  })().finally(() => (inFlight = null));
  return inFlight;
}
