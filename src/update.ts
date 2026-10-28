// Updates for the Mac app: finds a newer release on GitHub, downloads it and checks it before
// the app swaps it in. Nothing installs without the user's click (the app asks), and nothing
// is sent but the request itself: no identifiers, no message data.
//
// What's checked: the release comes from this repo over HTTPS, the zip matches the release's
// SHA256SUMS.txt, and the app inside is intact (its signature verifies), has this app's
// identifier, the version the release says, and a reader with the reader's identifier and
// protections. What can't be checked without a paid Apple Developer ID: who built it. An
// update is trusted exactly as much as the first download from this repo's Releases.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

export interface Release {
  version: string;
  url: string;
  zip: { name: string; url: string; size: number };
  sums: { url: string };
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
  const asset = (name: string) => assets.find((a) => a.name === name && a.browser_download_url === prefix + encodeURIComponent(name).replace(/%20/g, '%20'));
  const zipName = `${APP_NAME.replace(/ /g, '-')}-${version}.zip`;
  const zip = asset(zipName);
  const sums = asset('SHA256SUMS.txt');
  if (!zip || !sums) throw new Error(`release v${version} is missing ${!zip ? zipName : 'SHA256SUMS.txt'}`);
  const size = Number(zip.size);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_ZIP_BYTES) throw new Error(`release v${version} has an unexpected download size`);
  return {
    version,
    url: `https://github.com/${REPO}/releases/tag/v${version}`,
    zip: { name: zipName, url: String(zip.browser_download_url), size },
    sums: { url: String(sums.browser_download_url) },
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
const signature = (target: string) => spawnSync('/usr/bin/codesign', ['-dv', target], { encoding: 'utf8' }).stderr ?? '';

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

/**
 * Downloads and checks a release, then unpacks its app into a private folder and returns the
 * app's path. The Mac app swaps it in and relaunches.
 */
export async function downloadUpdate(release: Release, fetcher: Fetch = fetch, cacheDir = path.join(os.homedir(), 'Library/Caches/imessage-agent-mcp')): Promise<string> {
  const [zip, sums] = await Promise.all([download(release.zip.url, release.zip.size, fetcher), download(release.sums.url, 64 << 10, fetcher)]);
  const expected = sums
    .toString('utf8')
    .split('\n')
    .map((line) => /^([0-9a-f]{64})  (.+)$/.exec(line.trim()))
    .find((m) => m?.[2] === release.zip.name)?.[1];
  if (!expected) throw new Error(`SHA256SUMS.txt doesn't list ${release.zip.name}`);
  if (createHash('sha256').update(zip).digest('hex') !== expected) throw new Error("the download doesn't match its checksum");

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(cacheDir, 0o700);
  const dir = path.join(cacheDir, 'update');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { mode: 0o700 });
  const zipPath = path.join(dir, release.zip.name);
  fs.writeFileSync(zipPath, zip, { mode: 0o600 });
  const unpacked = path.join(dir, 'unpacked');
  fs.mkdirSync(unpacked, { mode: 0o700 });
  execFileSync('/usr/bin/ditto', ['-x', '-k', zipPath, unpacked]);
  fs.rmSync(zipPath);
  const entries = fs.readdirSync(unpacked).filter((e) => e !== '__MACOSX');
  if (entries.length !== 1 || entries[0] !== `${APP_NAME}.app`) throw new Error('the update has unexpected contents');
  const app = path.join(unpacked, entries[0]);
  verifyApp(app, release.version);
  return app;
}
