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
    const dmgRoot = path.join(work, 'dmg');
    fs.mkdirSync(dmgRoot);
    run('/usr/bin/ditto', [app, path.join(dmgRoot, 'imessage-agent.app')]);
    fs.symlinkSync('/Applications', path.join(dmgRoot, 'Applications'));
    const dmg = path.join(out, `${name}.dmg`);
    const zip = path.join(out, `${name}.zip`);
    fs.rmSync(dmg, { force: true });
    fs.rmSync(zip, { force: true });
    run('/usr/bin/hdiutil', ['create', '-volname', 'imessage-agent', '-srcfolder', dmgRoot, '-ov', '-format', 'ULMO', dmg]);
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
    const sums = [dmg, zip].map((f) => `${createHash('sha256').update(fs.readFileSync(f)).digest('hex')}  ${path.basename(f)}`);
    fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
    console.log(sums.join('\n'));
  }
  console.log(`Built ${app}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
