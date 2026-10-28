#!/usr/bin/env node
// Builds Messages Agent.app, the downloadable Mac app: a menu bar app (app/Sources) that
// bundles Node, this project's source and a prebuilt reader, so nothing else needs installing.
//
//   node scripts/build-app.mjs [--out dist] [--arch universal|native] [--no-package] [--reader-from <previous .zip or .app>]
//
// Writes <out>/Messages Agent.app and, unless --no-package, a .dmg, a .zip and SHA256SUMS.txt
// for a GitHub release. Needs macOS with Apple's Command Line Tools (Swift and clang), and
// downloads the pinned Node release once, checking its SHA-256.
//
// The app is ad-hoc signed (no Apple Developer account), so people opening a download confirm
// it once in System Settings → Privacy & Security → Open Anyway.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileReader, READER_BUILD, READER_INFO } from '../src/messages/mirror.ts';
import { readDsStore, writeDsStore } from './dsstore.mjs';

/** Node bundled into the app: an LTS release, pinned by the checksums nodejs.org publishes. */
const NODE = {
  version: 'v24.22.1',
  sha256: {
    arm64: '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
    x64: 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035',
  },
};
const APP_ID = 'com.imessage-agent-mcp.app';
const APP_NAME = 'Messages Agent';
/** The disk image window, in points, matching app/dmg/make-background.swift. Height includes the title bar. */
const DMG_VOLUME = 'Messages Agent';
/** Alias record tags (Carbon's Alias Manager) that are safe to publish: names and paths inside the image. */
const ALIAS_TAGS = new Set([0, 1, 2, 14, 15, 16, 17, 18]);
const FOLDER_IDS_TAG = 1;
const CARBON_PATH_TAG = 2;
const VOLUME_DATE_TAG = 16;
const FILE_DATE_TAG = 17;
const VOLUME_NAME_TAG = 15;
const MOUNT_POINT_TAG = 19;
const DMG_LAYOUT = { window: { width: 640, height: 428 }, iconSize: 112, app: [170, 190], applications: [470, 190] };
const MIN_MACOS = '13.0';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const out = path.resolve(opt('out', path.join(root, 'dist')));
const native = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
const archs = opt('arch', 'universal') === 'native' ? [native] : ['arm64', 'x86_64'];
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const cache = path.join(os.homedir(), 'Library/Caches/imessage-agent-mcp-build');

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'], ...opts });
const step = (text) => console.log(`• ${text}`);

if (process.platform !== 'darwin') throw new Error('The Mac app can only be built on macOS.');
// Disk image dates are stored in local time; UTC keeps the builder's time zone out of them.
process.env.TZ = 'UTC';

// Everything is built in a work folder and moved into <out> only at the end, so a failed or
// interrupted build leaves the previous one there.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'imessage-agent-build-'));
const app = path.join(work, `${APP_NAME}.app`);
const contents = path.join(app, 'Contents');
/** Disk images this build has attached, detached if it's interrupted. */
const attached = new Set();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    for (const device of attached) spawnSync('/usr/bin/hdiutil', ['detach', device, '-force'], { stdio: 'ignore' });
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(130);
  });
}
for (const dir of ['MacOS', 'Helpers', 'Resources/app']) fs.mkdirSync(path.join(contents, dir), { recursive: true });

try {
  step(`Node ${NODE.version} (${archs.join(' + ')})`);
  const nodes = [];
  for (const arch of archs) {
    const dist = `node-${NODE.version}-darwin-${arch === 'x86_64' ? 'x64' : 'arm64'}`;
    const tarball = path.join(cache, `${dist}.tar.gz`);
    if (!fs.existsSync(tarball)) {
      fs.mkdirSync(cache, { recursive: true });
      const res = await fetch(`https://nodejs.org/dist/${NODE.version}/${dist}.tar.gz`);
      if (!res.ok) throw new Error(`downloading ${dist}: HTTP ${res.status}`);
      fs.writeFileSync(`${tarball}.part`, Buffer.from(await res.arrayBuffer()));
      fs.renameSync(`${tarball}.part`, tarball);
    }
    const sum = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
    if (sum !== NODE.sha256[arch === 'x86_64' ? 'x64' : 'arm64']) {
      fs.rmSync(tarball);
      throw new Error(`${dist}.tar.gz doesn't match its pinned SHA-256; deleted it, try again`);
    }
    run('/usr/bin/tar', ['-xzf', tarball, '-C', work, `${dist}/bin/node`, `${dist}/LICENSE`]);
    nodes.push(path.join(work, dist, 'bin/node'));
    fs.copyFileSync(path.join(work, dist, 'LICENSE'), path.join(contents, 'Resources/node-LICENSE'));
  }
  const node = path.join(contents, 'Helpers/node');
  run('/usr/bin/lipo', ['-create', ...nodes, '-output', node]);
  fs.chmodSync(node, 0o755);
  // Re-signed after merging. Not with the hardened runtime: V8 needs to generate code, and Node
  // holds no special permissions anyway.
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.imessage-agent-mcp.node', node]);

  step('Icon');
  const iconTool = path.join(work, 'make-icon');
  run('/usr/bin/swiftc', ['-O', '-target', `${native}-apple-macos${MIN_MACOS}`, path.join(root, 'app/icon/make-icon.swift'), '-o', iconTool]);
  run(iconTool, [path.join(work, 'AppIcon.iconset')]);
  run('/usr/bin/iconutil', ['-c', 'icns', path.join(work, 'AppIcon.iconset'), '-o', path.join(contents, 'Resources/AppIcon.icns')]);

  step('Reader (the only part that gets Full Disk Access)');
  // macOS ties Full Disk Access to the reader's exact code, so a release reuses the previous
  // release's reader when nothing that goes into it changed (a newer compiler on the build
  // machine alone would otherwise make every update ask for access again).
  const readerArgs = archs.flatMap((a) => ['-arch', a]);
  const readerInputs = createHash('sha256')
    .update(fs.readFileSync(path.join(root, 'helper/reader.c')))
    .update(JSON.stringify(READER_BUILD))
    .update(READER_INFO)
    .update(JSON.stringify(readerArgs))
    .update(fs.readFileSync(path.join(root, 'app/icon/make-icon.swift')))
    .digest('hex');
  const readerDest = path.join(contents, 'Helpers/Messages Agent Reader.app');
  const previous = opt('reader-from', null) && previousReader(opt('reader-from'), readerInputs);
  if (previous) {
    run('/usr/bin/ditto', [previous, readerDest]);
    console.log('  reusing the previous release\'s reader (unchanged)');
  } else {
    compileReader(path.join(root, 'helper/reader.c'), path.join(contents, 'Helpers/Messages Agent Reader.app'), archs.flatMap((a) => ['-arch', a]), path.join(contents, 'Resources/AppIcon.icns'));
  }
  fs.writeFileSync(path.join(contents, 'Resources/reader-inputs.sha256'), readerInputs + '\n');

  step('Server source and its dependencies');
  const res = path.join(contents, 'Resources/app');
  for (const f of ['package.json', 'package-lock.json', 'LICENSE']) fs.copyFileSync(path.join(root, f), path.join(res, f));
  fs.cpSync(path.join(root, 'src'), path.join(res, 'src'), { recursive: true });
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: res, stdio: ['ignore', 'ignore', 'inherit'] });
  // Everything in Resources is data the app's signature seals; native code there would need its own.
  const nativeCode = fs.readdirSync(res, { recursive: true }).filter((f) => /\.(node|dylib|so)$/.test(f));
  if (nativeCode.length) throw new Error(`unexpected native code in dependencies: ${nativeCode.join(', ')}`);

  step('Menu bar app');
  const binaries = archs.map((arch) => {
    const bin = path.join(work, `imessage-agent-${arch}`);
    const sources = fs.readdirSync(path.join(root, 'app/Sources')).filter((f) => f.endsWith('.swift')).map((f) => path.join(root, 'app/Sources', f));
    run('/usr/bin/swiftc', ['-swift-version', '5', '-parse-as-library', '-O', '-target', `${arch}-apple-macos${MIN_MACOS}`, ...sources, '-o', bin]);
    return bin;
  });
  run('/usr/bin/lipo', ['-create', ...binaries, '-output', path.join(contents, 'MacOS/imessage-agent')]);

  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${APP_ID}</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleExecutable</key><string>imessage-agent</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>${MIN_MACOS}</string>
  <key>LSUIElement</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHumanReadableCopyright</key><string>MIT License</string>
</dict>
</plist>
`);

  step('Signing');
  // Nested code is signed first (above); this seals the rest, including the server source.
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--identifier', APP_ID, app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);

  const results = [app];
  if (!args.includes('--no-package')) {
    step('Packaging');
    const name = `${APP_NAME.replace(/ /g, '-')}-${version}`;
    const dmg = path.join(work, `${name}.dmg`);
    const zip = path.join(work, `${name}.zip`);
    buildDmg(dmg);
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
    const sums = [dmg, zip].map((f) => `${createHash('sha256').update(fs.readFileSync(f)).digest('hex')}  ${path.basename(f)}`);
    fs.writeFileSync(path.join(work, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
    console.log(sums.join('\n'));
    results.push(dmg, zip, path.join(work, 'SHA256SUMS.txt'));
  }
  fs.mkdirSync(out, { recursive: true });
  for (const file of results) {
    const dest = path.join(out, path.basename(file));
    fs.rmSync(dest, { recursive: true, force: true });
    // ditto keeps the app's signature intact; a rename is enough on the same disk.
    try {
      fs.renameSync(file, dest);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      run('/usr/bin/ditto', [file, dest]);
    }
  }
  console.log(`Built ${path.join(out, `${APP_NAME}.app`)}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

/**
 * The disk image opens as the usual install window: the app on the left, an arrow, and
 * Applications on the right, over a background. Finder records that layout (in .DS_Store)
 * while the image is writable; then it's compressed read-only. Needs a logged-in session,
 * and the first time, permission for the terminal to control Finder.
 *
 * Finder's .DS_Store also records where the build ran (the temporary image's path, which
 * includes a per-account folder, and this Mac's disk name and id), so the build rewrites it
 * with only the window settings, icon positions and a background reference, and checks it.
 */
function buildDmg(dmg) {
  const staging = path.join(work, 'dmg');
  fs.mkdirSync(path.join(staging, '.background'), { recursive: true });
  run('/usr/bin/ditto', [app, path.join(staging, `${APP_NAME}.app`)]);
  fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
  const bgTool = path.join(work, 'make-background');
  run('/usr/bin/swiftc', ['-O', '-target', `${native}-apple-macos${MIN_MACOS}`, path.join(root, 'app/dmg/make-background.swift'), '-o', bgTool]);
  run(bgTool, [work]);
  run('/usr/bin/tiffutil', ['-cathidpicheck', path.join(work, 'background.png'), path.join(work, 'background-2x.png'), '-out', path.join(staging, '.background/background.tiff')]);

  const rw = path.join(work, 'rw.dmg');
  // Finder finds disks by name, so the layout is done under a name no other disk has (another
  // copy of this image may well be open), and the volume is renamed afterwards.
  const layoutName = `${DMG_VOLUME}-${randomBytes(4).toString('hex')}`;
  run('/usr/bin/hdiutil', ['create', '-volname', layoutName, '-srcfolder', staging, '-fs', 'HFS+', '-format', 'UDRW', '-ov', rw]);
  const mounted = attach(rw, ['-readwrite', '-noverify', '-noautoopen']);
  try {
    const { window, iconSize, app: appAt, applications } = DMG_LAYOUT;
    const script = `on run argv
  tell application "Finder"
    set d to disk of (POSIX file (item 1 of argv) as alias)
    tell d
      open
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      try
        set pathbar visible of container window to false
      end try
      set the bounds of container window to {200, 120, ${200 + window.width}, ${120 + window.height}}
      set opts to the icon view options of container window
      set arrangement of opts to not arranged
      set icon size of opts to ${iconSize}
      set text size of opts to 13
      set background picture of opts to file ".background:background.tiff"
      set position of item "${APP_NAME}.app" of container window to {${appAt.join(', ')}}
      set position of item "Applications" of container window to {${applications.join(', ')}}
      close
      open
      update without registering applications
      delay 2
      close
    end tell
  end tell
end run`;
    for (let attempt = 1; ; attempt++) {
      try {
        run('/usr/bin/osascript', ['-e', script, mounted.mount]);
        break;
      } catch (err) {
        // Finder sometimes times out on a freshly mounted volume.
        if (attempt === 3) throw new Error(`Finder couldn't lay out the disk image window (allow your terminal to control Finder in System Settings → Privacy & Security → Automation): ${err.message}`);
      }
    }
    const store = path.join(mounted.mount, '.DS_Store');
    // Finder saves it in its own time: wait until it exists and stops changing.
    let last = '';
    for (let i = 0, stable = 0; i < 100 && stable < 5; i++) {
      run('/bin/sleep', ['0.2']);
      const now = fs.existsSync(store) ? `${fs.statSync(store).size} ${fs.statSync(store).mtimeMs}` : '';
      stable = now && now === last ? stable + 1 : 0;
      last = now;
    }
    if (!last) throw new Error("Finder didn't save the disk image's window layout");
  } finally {
    detach(mounted.device);
  }
  // Finder's layout is read out of its sight (-nobrowse), and that filesystem is thrown away:
  // its free space still holds Finder's original file, with where the build ran.
  const hidden = attach(rw, ['-readonly', '-noverify', '-noautoopen', '-nobrowse']);
  let finderLayout;
  try {
    finderLayout = fs.readFileSync(path.join(hidden.mount, '.DS_Store'));
  } finally {
    detach(hidden.device);
  }
  fs.rmSync(rw);

  // The image people download is a fresh filesystem that has only ever held these files.
  fs.copyFileSync(path.join(contents, 'Resources/AppIcon.icns'), path.join(staging, '.VolumeIcon.icns'));
  const fresh = path.join(work, 'fresh.dmg');
  run('/usr/bin/hdiutil', ['create', '-volname', DMG_VOLUME, '-srcfolder', staging, '-fs', 'HFS+', '-format', 'UDRW', '-ov', fresh]);
  const final = attach(fresh, ['-readwrite', '-noverify', '-noautoopen', '-nobrowse']);
  try {
    fs.writeFileSync(path.join(final.mount, '.DS_Store'), cleanLayout(finderLayout, layoutName, aliasTarget(final.mount)));
    // The volume uses its .VolumeIcon.icns in Finder and on the desktop.
    run('/usr/bin/SetFile', ['-a', 'C', final.mount]);
    fs.rmSync(path.join(final.mount, '.fseventsd'), { recursive: true, force: true });
    run('/bin/sync');
  } finally {
    detach(final.device);
  }
  // Every byte of it, free space included, is checked before it's compressed.
  assertImageIsClean(fresh, layoutName);
  run('/usr/bin/hdiutil', ['convert', fresh, '-format', 'ULMO', '-o', dmg]);

  // Check the result: the layout, the background and the app all made it in, and nothing about this Mac did.
  const check = attach(dmg, ['-readonly', '-nobrowse', '-noautoopen']);
  try {
    for (const f of ['.DS_Store', '.background/background.tiff', '.VolumeIcon.icns', `${APP_NAME}.app/Contents/Info.plist`]) {
      if (!fs.existsSync(path.join(check.mount, f))) throw new Error(`the disk image is missing ${f}`);
    }
    if (fs.readlinkSync(path.join(check.mount, 'Applications')) !== '/Applications') throw new Error('the disk image has no Applications link');
    assertLayoutIsClean(fs.readFileSync(path.join(check.mount, '.DS_Store')), layoutName);
    if (!(fs.statSync(path.join(check.mount, '.background/background.tiff')).ino > 0)) throw new Error('the disk image has no background');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(check.mount, `${APP_NAME}.app`)]);
  } finally {
    detach(check.device);
  }
  // Checking it made hdiutil tag the file with this Mac's disk id (an extended attribute, not
  // part of the file, but it travels with a local copy). Releases are uploaded from CI.
  run('/usr/bin/xattr', ['-c', dmg]);
}

/**
 * The reader inside a previous release (its .zip or .app), if it was built from the same
 * inputs and is intact; otherwise null, and the reader is built fresh.
 */
function previousReader(from, inputs) {
  let prevApp = path.resolve(from);
  if (prevApp.endsWith('.zip')) {
    const dir = path.join(work, 'previous');
    fs.mkdirSync(dir);
    run('/usr/bin/ditto', ['-x', '-k', prevApp, dir]);
    prevApp = path.join(dir, `${APP_NAME}.app`);
  }
  const stamp = path.join(prevApp, 'Contents/Resources/reader-inputs.sha256');
  if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8').trim() !== inputs) return null;
  const reader = path.join(prevApp, 'Contents/Helpers/Messages Agent Reader.app');
  const sig = spawnSync('/usr/bin/codesign', ['-dv', reader], { encoding: 'utf8' }).stderr ?? '';
  const ok =
    spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', reader]).status === 0 &&
    /^Identifier=com\.imessage-agent-mcp\.reader$/m.test(sig) &&
    /flags=0x\w+\([^)]*runtime/.test(sig);
  if (!ok) throw new Error("the previous release's reader doesn't verify; not reusing it");
  return reader;
}

/** Mounts a disk image, returning its mount point and its own device (what's detached later). */
function attach(image, flags) {
  // hdiutil hands back the existing mount for an image that's already attached; that one isn't ours to detach.
  const before = new Set(run('/usr/bin/hdiutil', ['info'], { encoding: 'utf8' }).match(/\/dev\/disk\d+(?=\s)/g) ?? []);
  const plist = run('/usr/bin/hdiutil', ['attach', image, ...flags, '-plist'], { encoding: 'utf8' });
  // Its plist holds binary data too, so the two strings needed are read from the XML.
  const strings = (key) =>
    [...plist.matchAll(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, 'g'))].map((m) =>
      m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'),
    );
  const entries = strings('dev-entry');
  const device = entries.find((d) => /^\/dev\/disk\d+$/.test(d)) ?? entries.map((d) => /^(\/dev\/disk\d+)s\d+$/.exec(d)?.[1]).find(Boolean);
  const mount = strings('mount-point')[0];
  if (device && before.has(device)) throw new Error(`${path.basename(image)} was already mounted`);
  if (device) attached.add(device);
  if (!device || !mount?.startsWith('/Volumes/')) {
    if (device) detach(device);
    throw new Error(`couldn't mount ${path.basename(image)}`);
  }
  return { device, mount };
}

function detach(device) {
  for (let attempt = 1; ; attempt++) {
    try {
      run('/usr/bin/hdiutil', ['detach', device, ...(attempt > 3 ? ['-force'] : [])]);
      attached.delete(device);
      return;
    } catch (err) {
      if (attempt === 5) throw err;
      run('/bin/sleep', ['1']);
    }
  }
}

/** Builds a binary plist from a JSON-like object, with plutil. */
function plistOf(object, data = {}) {
  const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<plist version="1.0"><dict>'];
  for (const [k, v] of Object.entries(object)) {
    xml.push(`<key>${k}</key>`);
    if (k in data) xml.push(`<data>${data[k].toString('base64')}</data>`);
    else if (typeof v === 'boolean') xml.push(v ? '<true/>' : '<false/>');
    else if (typeof v === 'number') xml.push(Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`);
    else xml.push(`<string>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`);
  }
  xml.push('</dict></plist>');
  return run('/usr/bin/plutil', ['-convert', 'binary1', '-o', '-', '-'], { input: xml.join('\n') });
}

function blob(data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, data]);
}


/**
 * The background alias without what points outside the image: the temporary image's own
 * path and this Mac's disk (tag 20) and where it happened to be mounted (tag 19, rewritten
 * to the volume's usual place).
 */
/**
 * What the background alias must name on the image people download: the folder's and file's
 * ids, and the volume's and file's creation dates (HFS+ keeps local time in the record's
 * header and UTC in its extra fields).
 */
function aliasTarget(mount) {
  const folder = path.join(mount, '.background');
  const file = path.join(folder, 'background.tiff');
  return { volume: fs.statSync(mount).birthtime, folder: fs.statSync(folder).ino, file: fs.statSync(file).ino, created: fs.statSync(file).birthtime };
}

/** Seconds since 1904, the HFS epoch. */
function macSeconds(date) {
  return Math.floor((date.getTime() - Date.UTC(1904, 0, 1)) / 1000);
}
function macLocalSeconds(date) {
  return macSeconds(date) - date.getTimezoneOffset() * 60;
}
function highRes(date) {
  const b = Buffer.alloc(8);
  b.writeUIntBE(macSeconds(date), 0, 6); // Then 16 bits of fraction, left at zero.
  return b;
}

function cleanAlias(alias, layoutName, target) {
  if (alias.readUInt16BE(6) !== 2) throw new Error('unexpected background alias version');
  const header = Buffer.from(alias.subarray(0, 150));
  header.writeUInt32BE(macLocalSeconds(target.volume), 38);
  header.writeUInt32BE(target.folder, 46);
  header.writeUInt32BE(target.file, 114);
  header.writeUInt32BE(macLocalSeconds(target.created), 118);
  // The volume's name, as it will be once renamed (a length byte, then up to 27 bytes).
  header.fill(0, 10, 38);
  header[10] = DMG_VOLUME.length;
  header.write(DMG_VOLUME, 11, 'latin1');
  const parts = [header];
  const tag = (id, data) => {
    const head = Buffer.alloc(4);
    head.writeInt16BE(id, 0);
    head.writeUInt16BE(data.length, 2);
    parts.push(head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0));
  };
  for (let p = 150; p + 4 <= alias.length; ) {
    const id = alias.readInt16BE(p);
    const len = alias.readUInt16BE(p + 2);
    if (id === -1) break;
    let data = Buffer.from(alias.subarray(p + 4, p + 4 + len));
    if (id === CARBON_PATH_TAG) {
      if (!data.toString('latin1').startsWith(`${layoutName}:`)) throw new Error('unexpected background alias path');
      data = Buffer.concat([Buffer.from(DMG_VOLUME, 'latin1'), data.subarray(layoutName.length)]);
    }
    if (id === VOLUME_NAME_TAG) {
      const name = Buffer.from(DMG_VOLUME, 'utf16le').swap16();
      data = Buffer.concat([Buffer.from([0, DMG_VOLUME.length]), name]);
    }
    if (id === FOLDER_IDS_TAG) data = Buffer.from(Uint32Array.of(target.folder).buffer).reverse(); // Big-endian.
    if (id === VOLUME_DATE_TAG) data = highRes(target.volume);
    if (id === FILE_DATE_TAG) data = highRes(target.created);
    if (ALIAS_TAGS.has(id)) tag(id, data);
    if (id === MOUNT_POINT_TAG) tag(id, Buffer.from(`/Volumes/${DMG_VOLUME}`, 'utf8'));
    p += 4 + len + (len & 1);
  }
  parts.push(Buffer.from([0xff, 0xff, 0, 0]));
  const out = Buffer.concat(parts);
  out.writeUInt16BE(out.length, 4);
  return out;
}

/** Finder's .DS_Store reduced to the window settings, the icon positions and the background. */
function cleanLayout(buf, layoutName, target) {
  const records = readDsStore(buf);
  const icvp = records.find((r) => r.name === '.' && r.code === 'icvp');
  if (!icvp) throw new Error("Finder didn't save the window's view settings");
  const field = (key) => {
    try {
      return run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', '-'], { input: icvp.value.subarray(4), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const alias = Buffer.from(field('backgroundImageAlias'), 'base64');
  if (field('backgroundType') !== '2' || !alias.length) throw new Error("Finder didn't save the window's background");
  const { window, iconSize } = DMG_LAYOUT;
  const options = {
    arrangeBy: 'none', backgroundColorBlue: 1, backgroundColorGreen: 1, backgroundColorRed: 1, backgroundImageAlias: '', backgroundType: 2,
    gridOffsetX: 0, gridOffsetY: 0, gridSpacing: 100, iconSize, labelOnBottom: true, showIconPreview: true, showItemInfo: false, textSize: 13, viewOptionsVersion: 1,
  };
  const browser = {
    ContainerShowSidebar: false, ShowPathbar: false, ShowSidebar: false, ShowStatusBar: false, ShowTabView: false, ShowToolbar: false,
    WindowBounds: `{{200, 120}, {${window.width}, ${window.height}}}`,
  };
  const kept = [
    { name: '.', code: 'bwsp', type: 'blob', value: blob(plistOf(browser)) },
    { name: '.', code: 'icvp', type: 'blob', value: blob(plistOf(options, { backgroundImageAlias: cleanAlias(alias, layoutName, target) })) },
    { name: '.', code: 'vSrn', type: 'long', value: Buffer.from([0, 0, 0, 1]) },
    ...records.filter((r) => r.code === 'Iloc' && [`${APP_NAME}.app`, 'Applications'].includes(r.name)),
  ];
  if (kept.filter((r) => r.code === 'Iloc').length !== 2) throw new Error("Finder didn't save the icon positions");
  return writeDsStore(kept);
}

/** Fails if the layout holds anything beyond what cleanLayout keeps, or anything about this Mac. */
function assertLayoutIsClean(buf, layoutName) {
  const allowed = new Set(['.:bwsp', '.:icvp', '.:vSrn', `${APP_NAME}.app:Iloc`, 'Applications:Iloc']);
  const extra = readDsStore(buf).filter((r) => !allowed.has(`${r.name}:${r.code}`));
  if (extra.length) throw new Error(`the disk image layout has unexpected records: ${extra.map((r) => `${r.name}:${r.code}`).join(', ')}`);
  const found = traces(['/var/folders', ':var:folders', '/Users/', ':Users:', os.userInfo().username, ...machineTraces(layoutName)], buf);
  if (found.length) throw new Error(`the disk image layout mentions this Mac (${found.length} item(s)); not packaging it`);
}

/** Strings that would identify the Mac or account that built the image. */
function machineTraces(layoutName) {
  const dataVolume = /Volume UUID:\s+([0-9A-F-]{36})/.exec(run('/usr/sbin/diskutil', ['info', '/System/Volumes/Data'], { encoding: 'utf8' }))?.[1];
  const tmp = fs.realpathSync(os.tmpdir());
  const quiet = (cmd, argv) => spawnSync(cmd, argv, { encoding: 'utf8' }).stdout?.trim() || null;
  const names = [quiet('/usr/sbin/scutil', ['--get', 'ComputerName']), quiet('/usr/sbin/scutil', ['--get', 'LocalHostName']), quiet('/usr/bin/id', ['-F'])];
  return ['rw.dmg', 'fresh.dmg', 'imessage-agent-build', 'Macintosh HD', layoutName, os.homedir(), tmp, tmp.replace(/^\/private/, ''), dataVolume, dataVolume?.toLowerCase(), ...names]
    .filter((s) => s && s.length >= 4);
}

/** Which of these strings appear in buf, as plain text or UTF-16 in either byte order, at any offset. */
function traces(strings, buf) {
  return strings.filter((s) => [Buffer.from(s, 'latin1'), Buffer.from(s, 'utf16le'), Buffer.from(s, 'utf16le').swap16()].some((b) => buf.includes(b)));
}

/** Scans a raw image file (every block, used or free) for traces of this Mac. */
function assertImageIsClean(image, layoutName) {
  const strings = machineTraces(layoutName);
  const overlap = 4096;
  const fd = fs.openSync(image, 'r');
  try {
    const chunk = Buffer.alloc(16 << 20);
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      const window = Buffer.concat([carry, chunk.subarray(0, n)]);
      const found = traces(strings, window);
      if (found.length) throw new Error(`the disk image still holds ${found.length} trace(s) of this Mac; not packaging it`);
      carry = Buffer.from(window.subarray(Math.max(0, window.length - overlap)));
    }
  } finally {
    fs.closeSync(fd);
  }
}
