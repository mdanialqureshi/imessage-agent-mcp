// Updates for the Mac app: finds a newer release on GitHub, downloads it and checks it before
// the app swaps it in. Nothing installs without the user's click (the app asks), and nothing
// is sent but the request itself: no identifiers, no message data.
//
// What's checked: the release's SHA256SUMS.txt carries a signature from the project's release
// key (UPDATE_PUBLIC_KEY; the private half is a secret only the release workflow can use), so
// replacing a release's files on GitHub isn't enough to ship an update. The zip must match
// those checksums, hold only the app (no links, nothing outside it), and the app must be
// intact (its signature verifies), with this app's identifier, the release's version and a
// reader with the reader's identifier and protections. The app re-checks the exact bundle it
// installs against the code hash printed here.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO = 'mdanialqureshi/imessage-agent-mcp';
export const APP_NAME = 'Messages Agent';
export const APP_ID = 'com.imessage-agent-mcp.app';
const READER_ID = 'com.imessage-agent-mcp.reader';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Where release downloads may come from (github.com redirects assets to these hosts). */
const ASSET_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const MAX_ZIP_BYTES = 400 << 20;
/** The release key's public half (Ed25519, DER SPKI, base64): what SHA256SUMS.txt.sig must verify with. */
export const UPDATE_PUBLIC_KEY = 'MCowBQYDK2VwAyEA61fQbEFHu4XHsNYzdfneqhkSC/MGLNqr04LaAvEJMDU=';

export interface Release {
  version: string;
  url: string;
  zip: { name: string; url: string; size: number };
  sums: { url: string };
  sig: { url: string };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** a > b for x.y.z versions. */
export function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

const VERSION = /^v?(\d{1,4}\.\d{1,4}\.\d{1,4})$/;

/** The latest release, or null when there is none (or it's not newer than current). */
export async function latestRelease(current: string, fetcher: Fetch = fetch): Promise<Release | null> {
  const res = await fetcher(API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${APP_NAME.replace(' ', '-')}/${current}` },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null; // No releases yet (or the repo is private).
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  const tag = typeof body.tag_name === 'string' ? VERSION.exec(body.tag_name) : null;
  if (!tag || body.draft || body.prerelease) return null;
  const version = tag[1];
  if (!newer(version, current)) return null;
  const prefix = `https://github.com/${REPO}/releases/download/v${version}/`;
  const assets = Array.isArray(body.assets) ? (body.assets as { name?: unknown; browser_download_url?: unknown; size?: unknown }[]) : [];
  const asset = (name: string) => assets.find((a) => a.name === name && a.browser_download_url === prefix + name);
  const zipName = `${APP_NAME.replace(/ /g, '-')}-${version}.zip`;
  const zip = asset(zipName);
  const sums = asset('SHA256SUMS.txt');
  const sig = asset('SHA256SUMS.txt.sig');
  if (!zip || !sums || !sig) throw new Error(`release v${version} is missing ${!zip ? zipName : !sums ? 'SHA256SUMS.txt' : 'its signature'}`);
  const size = Number(zip.size);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_ZIP_BYTES) throw new Error(`release v${version} has an unexpected download size`);
  return {
    version,
    url: `https://github.com/${REPO}/releases/tag/v${version}`,
    zip: { name: zipName, url: String(zip.browser_download_url), size },
    sums: { url: String(sums.browser_download_url) },
    sig: { url: String(sig.browser_download_url) },
  };
}

/** Downloads from GitHub only, following its redirects to its own asset hosts. */
async function download(url: string, maxBytes: number, fetcher: Fetch): Promise<Buffer> {
  let next = url;
  for (let hops = 0; hops < 5; hops++) {
    const u = new URL(next);
    if (u.protocol !== 'https:' || !ASSET_HOSTS.has(u.hostname)) throw new Error(`refusing to download from ${u.hostname}`);
    const res = await fetcher(next, { redirect: 'manual', signal: AbortSignal.timeout(300_000) });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error('download redirect without a location');
      next = new URL(location, next).toString();
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > maxBytes) throw new Error('download is larger than expected');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('too many download redirects');
}

const plistValue = (file: string, key: string) =>
  spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8' }).stdout?.trim() ?? '';
const signature = (target: string) => spawnSync('/usr/bin/codesign', ['-dvvv', target], { encoding: 'utf8' }).stderr ?? '';
const cdhash = (target: string) => /^CDHash=([0-9a-f]{40,64})$/m.exec(signature(target))?.[1] ?? null;

/**
 * Checks a zip's own listing before anything is unpacked: every entry inside the app's folder,
 * no "..", no absolute paths, and no links (the app has none), so unpacking can't write
 * anywhere else. Each entry's local header (the name ditto actually uses) must say the same
 * as the central directory, and the entries must tile the file exactly: one disk, no Zip64,
 * nothing hidden between them.
 */
export function checkZipListing(zip: Buffer, top: string): void {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  const layout = () => new Error('the update has an unexpected zip layout');
  if (end < 0) throw new Error("the update isn't a zip file");
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  const cdStart = p;
  if (count === 0xffff || p === 0xffffffff || p >= end) throw layout();
  // One disk, one end record that closes the file, no Zip64.
  if (zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) || zip.readUInt16LE(end + 8) !== count) throw layout();
  if (end + 22 + zip.readUInt16LE(end + 20) !== zip.length) throw layout();
  if (end >= 20 && zip.readUInt32LE(end - 20) === 0x07064b50) throw layout();
  if (cdStart + zip.readUInt32LE(end + 12) !== end) throw layout();
  const locals: number[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || zip.readUInt32LE(p) !== 0x02014b50) throw layout();
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const mode = zip.readUInt32LE(p + 38) >>> 16;
    const local = zip.readUInt32LE(p + 42);
    const nameBytes = zip.subarray(p + 46, p + 46 + nameLen);
    if (local + 30 + nameLen > cdStart || zip.readUInt32LE(local) !== 0x04034b50) throw layout();
    if (zip.readUInt16LE(local + 26) !== nameLen || !zip.subarray(local + 30, local + 30 + nameLen).equals(nameBytes)) {
      throw new Error("the update's zip names a file differently in two places");
    }
    locals.push(local);
    const name = nameBytes.toString('utf8');
    const parts = name.split('/');
    if (!name.startsWith(`${top}/`) || name.includes('\\') || parts.includes('..') || parts.includes('.') || name.includes('\0')) {
      throw new Error(`the update has an unexpected file: ${JSON.stringify(name.slice(0, 200))}`);
    }
    if ((mode & 0o170000) === 0o120000) throw new Error(`the update has a link in it: ${JSON.stringify(name.slice(0, 200))}`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== end) throw layout();
  // Entries in order, starting at the top of the file, each after the one before.
  if (locals.length && locals[0] !== 0) throw layout();
  for (let i = 1; i < locals.length; i++) if (locals[i] <= locals[i - 1]) throw layout();
}

/** Checks an unpacked app is this app, intact, at this version, with an intact reader. */
export function verifyApp(app: string, version: string): void {
  const st = fs.lstatSync(app);
  if (!st.isDirectory()) throw new Error('the update has no app in it');
  if (spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]).status !== 0) throw new Error("the update's signature doesn't verify");
  if (!new RegExp(`^Identifier=${APP_ID.replace(/\./g, '\\.')}$`, 'm').test(signature(app))) throw new Error('the update is a different app');
  const info = path.join(app, 'Contents/Info.plist');
  if (plistValue(info, 'CFBundleIdentifier') !== APP_ID) throw new Error('the update is a different app');
  if (plistValue(info, 'CFBundleShortVersionString') !== version) throw new Error("the update's version doesn't match the release");
  const reader = path.join(app, `Contents/Helpers/${APP_NAME} Reader.app`);
  const r = signature(reader);
  if (!new RegExp(`^Identifier=${READER_ID.replace(/\./g, '\\.')}$`, 'm').test(r) || !/flags=0x\w+\([^)]*runtime/.test(r)) {
    throw new Error("the update's reader isn't the expected one");
  }
}

export interface Downloaded {
  /** The checked app, in a private folder. */
  app: string;
  /** Its code hash, which the Mac app checks again on the exact bundle it installs. */
  cdhash: string;
  /** The new reader's code hash: a different one needs Full Disk Access again. */
  readerCdhash: string;
}

/**
 * Downloads and checks a release, then unpacks its app into a private folder. The Mac app
 * checks it again, swaps it in and relaunches.
 */
export async function downloadUpdate(
  release: Release,
  fetcher: Fetch = fetch,
  cacheDir = path.join(os.homedir(), 'Library/Caches/imessage-agent-mcp'),
  publicKey = UPDATE_PUBLIC_KEY,
): Promise<Downloaded> {
  const [zip, sums, sig] = await Promise.all([
    download(release.zip.url, release.zip.size, fetcher),
    download(release.sums.url, 64 << 10, fetcher),
    download(release.sig.url, 1 << 10, fetcher),
  ]);
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  if (!verify(null, sums, key, Buffer.from(sig.toString('utf8').trim(), 'base64'))) {
    throw new Error("the release's checksums aren't signed with the project's release key");
  }
  const expected = sums
    .toString('utf8')
    .split('\n')
    .map((line) => /^([0-9a-f]{64})  (.+)$/.exec(line.trim()))
    .find((m) => m?.[2] === release.zip.name)?.[1];
  if (!expected) throw new Error(`SHA256SUMS.txt doesn't list ${release.zip.name}`);
  if (createHash('sha256').update(zip).digest('hex') !== expected) throw new Error("the download doesn't match its checksum");

  checkZipListing(zip, `${APP_NAME}.app`);

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(cacheDir, 0o700);
  // Earlier downloads go; each one gets a fresh, private folder.
  for (const old of fs.readdirSync(cacheDir)) if (old === 'update' || old.startsWith('update-')) fs.rmSync(path.join(cacheDir, old), { recursive: true, force: true });
  const dir = fs.mkdtempSync(path.join(cacheDir, 'update-'));
  try {
    const zipPath = path.join(dir, release.zip.name);
    fs.writeFileSync(zipPath, zip, { mode: 0o600 });
    const unpacked = path.join(dir, 'unpacked');
    fs.mkdirSync(unpacked, { mode: 0o700 });
    execFileSync('/usr/bin/ditto', ['-x', '-k', zipPath, unpacked]);
    fs.rmSync(zipPath);
    const entries = fs.readdirSync(unpacked);
    if (entries.length !== 1 || entries[0] !== `${APP_NAME}.app`) throw new Error('the update has unexpected contents');
    const app = path.join(unpacked, entries[0]);
    verifyApp(app, release.version);
    const appHash = cdhash(app);
    const readerHash = cdhash(path.join(app, `Contents/Helpers/${APP_NAME} Reader.app`));
    if (!appHash || !readerHash) throw new Error("the update's signature doesn't verify");
    return { app, cdhash: appHash, readerCdhash: readerHash };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true }); // Nothing unchecked is left behind.
    throw err;
  }
}
