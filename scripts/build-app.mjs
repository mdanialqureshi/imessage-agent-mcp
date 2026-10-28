#!/usr/bin/env node
// Builds imessage-agent.app, the downloadable Mac app: a menu bar app (app/Sources) that
// bundles Node, this project's source and a prebuilt reader, so nothing else needs installing.
//
//   node scripts/build-app.mjs [--out dist] [--arch universal|native] [--no-package]
//
// Writes <out>/imessage-agent.app and, unless --no-package, a .dmg, a .zip and SHA256SUMS.txt
// for a GitHub release. Needs macOS with Apple's Command Line Tools (Swift and clang), and
// downloads the pinned Node release once, checking its SHA-256.
//
// The app is ad-hoc signed (no Apple Developer account), so people opening a download confirm
// it once in System Settings → Privacy & Security → Open Anyway.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileReader } from '../src/messages/mirror.ts';

/** Node bundled into the app: an LTS release, pinned by the checksums nodejs.org publishes. */
const NODE = {
  version: 'v24.22.1',
  sha256: {
    arm64: '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
    x64: 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035',
  },
};
const APP_ID = 'com.imessage-agent-mcp.app';
/** The disk image window, in points, matching app/dmg/make-background.swift. Height includes the title bar. */
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

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: ['ignore', 'pipe', 'inherit'], ...opts });
const step = (text) => console.log(`• ${text}`);

if (process.platform !== 'darwin') throw new Error('The Mac app can only be built on macOS.');

const app = path.join(out, 'imessage-agent.app');
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
  compileReader(path.join(root, 'helper/reader.c'), path.join(contents, 'Helpers/imessage-agent-reader.app'), archs.flatMap((a) => ['-arch', a]), path.join(contents, 'Resources/AppIcon.icns'));

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
  <key>CFBundleName</key><string>imessage-agent</string>
  <key>CFBundleDisplayName</key><string>imessage-agent</string>
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
    const name = `imessage-agent-${version}`;
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
 * Applications on the right, over a background. Finder saves that layout (in .DS_Store)
 * while the image is writable; then it's compressed read-only. Needs a logged-in session,
 * and the first time, permission for the terminal to control Finder.
 */
function buildDmg(dmg) {
  const staging = path.join(work, 'dmg');
  fs.mkdirSync(path.join(staging, '.background'), { recursive: true });
  run('/usr/bin/ditto', [app, path.join(staging, 'imessage-agent.app')]);
  fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
  const bgTool = path.join(work, 'make-background');
  run('/usr/bin/swiftc', ['-O', '-target', `${native}-apple-macos${MIN_MACOS}`, path.join(root, 'app/dmg/make-background.swift'), '-o', bgTool]);
  run(bgTool, [work]);
  run('/usr/bin/tiffutil', ['-cathidpicheck', path.join(work, 'background.png'), path.join(work, 'background-2x.png'), '-out', path.join(staging, '.background/background.tiff')]);

  const rw = path.join(work, 'rw.dmg');
  run('/usr/bin/hdiutil', ['create', '-volname', 'imessage-agent', '-srcfolder', staging, '-fs', 'HFS+', '-format', 'UDRW', '-ov', rw]);
  // Mounted where Finder can see it; its name may get a number if another copy is open.
  const attached = run('/usr/bin/hdiutil', ['attach', rw, '-readwrite', '-noverify', '-noautoopen', '-plist'], { encoding: 'utf8' });
  const mount = /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(attached)?.[1];
  if (!mount) throw new Error("couldn't mount the disk image");
  try {
    const disk = path.basename(mount).replace(/["\\]/g, '');
    const { window, iconSize, app: appAt, applications } = DMG_LAYOUT;
    const script = `tell application "Finder"
  tell disk "${disk}"
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
    set position of item "imessage-agent.app" of container window to {${appAt.join(', ')}}
    set position of item "Applications" of container window to {${applications.join(', ')}}
    close
    open
    update without registering applications
    delay 2
    close
  end tell
end tell`;
    for (let attempt = 1; ; attempt++) {
      try {
        run('/usr/bin/osascript', ['-e', script]);
        break;
      } catch (err) {
        // Finder sometimes times out on a freshly mounted volume.
        if (attempt === 3) throw new Error(`Finder couldn't lay out the disk image window (allow your terminal to control Finder in System Settings → Privacy & Security → Automation): ${err.message}`);
      }
    }
    for (let i = 0; i < 50 && !fs.existsSync(path.join(mount, '.DS_Store')); i++) run('/bin/sleep', ['0.2']);
    if (!fs.existsSync(path.join(mount, '.DS_Store'))) throw new Error("Finder didn't save the disk image's window layout");
    // Added after Finder is done, since Finder removes it: the volume's icon in Finder and on the desktop.
    fs.copyFileSync(path.join(contents, 'Resources/AppIcon.icns'), path.join(mount, '.VolumeIcon.icns'));
    run('/usr/bin/SetFile', ['-a', 'C', mount]);
    fs.rmSync(path.join(mount, '.fseventsd'), { recursive: true, force: true });
    run('/bin/sync');
  } finally {
    detach(mount);
  }
  run('/usr/bin/hdiutil', ['convert', rw, '-format', 'ULMO', '-o', dmg]);

  // Check the result: the layout, the background and the app all made it in.
  const check = run('/usr/bin/hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-noautoopen', '-plist'], { encoding: 'utf8' });
  const at = /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(check)?.[1];
  try {
    for (const f of ['.DS_Store', '.background/background.tiff', '.VolumeIcon.icns', 'imessage-agent.app/Contents/Info.plist']) {
      if (!at || !fs.existsSync(path.join(at, f))) throw new Error(`the disk image is missing ${f}`);
    }
    if (fs.readlinkSync(path.join(at, 'Applications')) !== '/Applications') throw new Error('the disk image has no Applications link');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(at, 'imessage-agent.app')]);
  } finally {
    if (at) detach(at);
  }
}

function detach(mount) {
  for (let attempt = 1; ; attempt++) {
    try {
      run('/usr/bin/hdiutil', ['detach', mount, ...(attempt > 3 ? ['-force'] : [])]);
      return;
    } catch (err) {
      if (attempt === 5) throw err;
      run('/bin/sleep', ['1']);
    }
  }
}
