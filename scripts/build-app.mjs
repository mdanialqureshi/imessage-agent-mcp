#!/usr/bin/env node
// Builds Messages Agent.app, the downloadable Mac app: a menu bar app (app/Sources) that
// bundles Node, this project's source and a prebuilt reader, so nothing else needs installing.
//
//   node scripts/build-app.mjs [--out dist] [--arch universal|native] [--no-package]
//
// Writes <out>/Messages Agent.app and, unless --no-package, a .dmg, a .zip and SHA256SUMS.txt
// for a GitHub release. Needs macOS with Apple's Command Line Tools (Swift and clang), and
// downloads the pinned Node release once, checking its SHA-256.
//
// The app is ad-hoc signed (no Apple Developer account), so people opening a download confirm
// it once in System Settings → Privacy & Security → Open Anyway.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileReader } from '../src/messages/mirror.ts';
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
const CARBON_PATH_TAG = 2;
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

const app = path.join(out, `${APP_NAME}.app`);
const contents = path.join(app, 'Contents');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'imessage-agent-build-'));
fs.rmSync(app, { recursive: true, force: true });
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
  compileReader(path.join(root, 'helper/reader.c'), path.join(contents, 'Helpers/Messages Agent Reader.app'), archs.flatMap((a) => ['-arch', a]), path.join(contents, 'Resources/AppIcon.icns'));

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

  if (!args.includes('--no-package')) {
    step('Packaging');
    const name = `${APP_NAME.replace(/ /g, '-')}-${version}`;
    const dmg = path.join(out, `${name}.dmg`);
    const zip = path.join(out, `${name}.zip`);
    fs.rmSync(dmg, { force: true });
    fs.rmSync(zip, { force: true });
    buildDmg(dmg);
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
    const sums = [dmg, zip].map((f) => `${createHash('sha256').update(fs.readFileSync(f)).digest('hex')}  ${path.basename(f)}`);
    fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
    console.log(sums.join('\n'));
  }
  console.log(`Built ${app}`);
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
  // The rest happens out of Finder's sight (-nobrowse), so it can't rewrite the layout again.
  const hidden = attach(rw, ['-readwrite', '-noverify', '-noautoopen', '-nobrowse']);
  try {
    const store = path.join(hidden.mount, '.DS_Store');
    fs.writeFileSync(store, cleanLayout(fs.readFileSync(store), layoutName));
    // Added after Finder is done, since Finder removes it: the volume's icon in Finder and on the desktop.
    fs.copyFileSync(path.join(contents, 'Resources/AppIcon.icns'), path.join(hidden.mount, '.VolumeIcon.icns'));
    run('/usr/bin/SetFile', ['-a', 'C', hidden.mount]);
    fs.rmSync(path.join(hidden.mount, '.fseventsd'), { recursive: true, force: true });
    run('/usr/sbin/diskutil', ['rename', hidden.mount, DMG_VOLUME]);
    run('/bin/sync');
  } finally {
    detach(hidden.device);
  }
  run('/usr/bin/hdiutil', ['convert', rw, '-format', 'ULMO', '-o', dmg]);

  // Check the result: the layout, the background and the app all made it in, and nothing about this Mac did.
  const check = attach(dmg, ['-readonly', '-nobrowse', '-noautoopen']);
  try {
    for (const f of ['.DS_Store', '.background/background.tiff', '.VolumeIcon.icns', `${APP_NAME}.app/Contents/Info.plist`]) {
      if (!fs.existsSync(path.join(check.mount, f))) throw new Error(`the disk image is missing ${f}`);
    }
    if (fs.readlinkSync(path.join(check.mount, 'Applications')) !== '/Applications') throw new Error('the disk image has no Applications link');
    assertLayoutIsClean(fs.readFileSync(path.join(check.mount, '.DS_Store')), layoutName);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(check.mount, `${APP_NAME}.app`)]);
  } finally {
    detach(check.device);
  }
}

/** Mounts a disk image, returning its mount point and its own device (what's detached later). */
function attach(image, flags) {
  const plist = run('/usr/bin/hdiutil', ['attach', image, ...flags, '-plist'], { encoding: 'utf8' });
  // Its plist holds binary data too, so the two strings needed are read from the XML.
  const strings = (key) =>
    [...plist.matchAll(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, 'g'))].map((m) =>
      m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'),
    );
  const device = strings('dev-entry').filter((d) => /^\/dev\/disk\d+$/.test(d))[0];
  const mount = strings('mount-point')[0];
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
function cleanAlias(alias, layoutName) {
  if (alias.readUInt16BE(6) !== 2) throw new Error('unexpected background alias version');
  const header = Buffer.from(alias.subarray(0, 150));
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
function cleanLayout(buf, layoutName) {
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
    { name: '.', code: 'icvp', type: 'blob', value: blob(plistOf(options, { backgroundImageAlias: cleanAlias(alias, layoutName) })) },
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
  const text = buf.toString('latin1') + Buffer.from(buf).swap16().toString('utf16le');
  const dataVolume = /Volume UUID:\s+([0-9A-F-]{36})/.exec(run('/usr/sbin/diskutil', ['info', '/System/Volumes/Data'], { encoding: 'utf8' }))?.[1];
  const forbidden = ['/var/folders', ':var:folders', '/Users/', ':Users:', 'rw.dmg', 'imessage-agent-build', 'Macintosh HD', layoutName, os.userInfo().username, os.homedir(), dataVolume].filter(Boolean);
  const found = forbidden.filter((s) => text.includes(s));
  if (found.length) throw new Error(`the disk image layout mentions this Mac (${found.length} item(s)); not packaging it`);
}
