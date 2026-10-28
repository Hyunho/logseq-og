// Package the release assets produced by gulp and shadow-cljs for local macOS use.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { packager } = require('../static/node_modules/@electron/packager');

async function main() {
  if (process.platform !== 'darwin') throw new Error('Run this script on macOS.');
  const root = path.resolve(__dirname, '..');
  const dir = path.join(root, 'static');
  const releaseDir = process.env.LOGSEQ_RELEASE_DIR;
  for (const file of ['electron.html', 'electron.js', 'js/main.js']) {
    const assetDir = releaseDir && file !== 'electron.html' ? releaseDir : dir;
    if (!fs.existsSync(path.join(assetDir, file))) throw new Error(`Missing release asset: ${path.join(assetDir, file)}`);
  }
  const electronVersion = require('../static/node_modules/electron/package.json').version;
  const cache = path.join(os.homedir(), 'Library/Caches/electron');
  const zip = `electron-v${electronVersion}-darwin-${process.arch}.zip`;
  const cacheDir = fs.existsSync(cache) && fs.readdirSync(cache)
    .map(entry => path.join(cache, entry))
    .find(entry => fs.existsSync(path.join(entry, zip)));
  // Finder does not inherit the environment of a build terminal.
  fs.writeFileSync(path.join(dir, 'main.cjs'),
    "process.env.NODE_ENV = 'production';\nrequire('./electron.js');\n");
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.main = 'main.cjs';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  const apps = await packager({
    dir,
    out: path.join(root, 'build/macos'),
    name: 'Logseq-OG',
    platform: 'darwin',
    arch: process.arch,
    electronVersion,
    ...(cacheDir ? { electronZipDir: cacheDir } : {}),
    appBundleId: 'com.logseq.logseq-og',
    appVersion: pkg.version,
    icon: path.join(dir, 'icons/logseq_big_sur.icns'),
    protocols: [{ name: 'logseq-og', schemes: ['logseq-og'] }],
    prune: true,
    overwrite: true,
    afterCopy: releaseDir ? [(buildPath, version, platform, arch, done) => {
      try {
      fs.copyFileSync(path.join(releaseDir, 'electron.js'), path.join(buildPath, 'electron.js'));
      fs.cpSync(path.join(releaseDir, 'js'), path.join(buildPath, 'js'), { recursive: true });
      const stagedPkg = JSON.parse(fs.readFileSync(path.join(buildPath, 'package.json'), 'utf8'));
      stagedPkg.main = 'main.cjs';
      fs.writeFileSync(path.join(buildPath, 'package.json'), JSON.stringify(stagedPkg, null, 2));
      fs.writeFileSync(path.join(buildPath, 'main.cjs'),
        "process.env.NODE_ENV = 'production';\nrequire('./electron.js');\n");
      done();
      } catch (error) { done(error); }
    }] : [],
    ignore: [/^\/out(?:\/|$)/, /^\/tests\.js/, /\.map$/],
  });
  for (const appDir of apps) {
    const app = path.join(appDir, 'Logseq-OG.app');
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    console.log(`Standalone app: ${app}`);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
