// Lightweight checks for CI and local use. No network. On Windows (and on a
// machine with a display) also launches Electron to prove appVersion comes
// from app.getVersion() rather than a preload literal.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let failed = false;

function fail(message) {
  failed = true;
  console.error('smoke: ' + message);
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

for (const file of ['main.js', 'preload.js', 'device-monitor.js', 'scripts/smoke.js', 'scripts/device-monitor.test.js']) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(file + ' failed node --check\n' + (result.stderr || result.stdout || ''));
  }
}

const pkg = JSON.parse(read('package.json'));
if (!/^\d+\.\d+\.\d+/.test(pkg.version)) fail('package.json version is not semver: ' + pkg.version);

const files = (pkg.build && pkg.build.files) || [];
if (files.indexOf('device-monitor.js') === -1) fail('build.files is missing device-monitor.js');
const nodeModulesPattern = files.indexOf('node_modules/**/*');
for (const rel of ['build/icon.ico', 'build/icon.png']) {
  const idx = files.indexOf(rel);
  if (idx === -1) fail('build.files is missing ' + rel);
  // electron-builder appends !build/** after the last ** pattern. Icons must
  // be listed after that so the exclusion does not drop the tray assets.
  if (nodeModulesPattern !== -1 && idx < nodeModulesPattern) {
    fail(rel + ' must be listed after node_modules/**/* so it survives the build/ exclusion');
  }
  const full = path.join(root, rel);
  if (!fs.existsSync(full) || fs.statSync(full).size < 256) fail('missing or tiny ' + rel);
}
const unpack = pkg.build && pkg.build.asarUnpack;
if (!Array.isArray(unpack) || !unpack.includes('build/icon.ico')) {
  fail('build.asarUnpack should include build/icon.ico');
}
if (!pkg.build || !pkg.build.win || pkg.build.win.icon !== 'build/icon.ico') {
  fail('build.win.icon should be build/icon.ico');
}

const ico = fs.readFileSync(path.join(root, 'build/icon.ico'));
if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) fail('build/icon.ico is not an ICO');
const png = fs.readFileSync(path.join(root, 'build/icon.png'));
if (png[0] !== 0x89 || png[1] !== 0x50) fail('build/icon.png is not a PNG');

const preload = read('preload.js');
if (/appVersion\s*:\s*['"][^'"]+['"]/.test(preload)) {
  fail('preload.js hardcodes appVersion');
}
if (!preload.includes("sendSync('timehub:get-version')")) {
  fail('preload.js does not read the version over IPC');
}

const main = read('main.js');
if (!main.includes('event.returnValue = app.getVersion()')) {
  fail('main.js does not answer timehub:get-version with app.getVersion()');
}
for (const token of ['timehub:update-error', 'timehub:update-ready', 'timehub:restart-to-update']) {
  if (!main.includes(token)) fail('main.js is missing ' + token);
}
if (/autoUpdater\.on\('error',\s*\(\)\s*=>\s*\{\s*\}\)/.test(main)) {
  fail('updater errors are still swallowed');
}

// Upgrades must close the running app (see build/installer.nsh).
if (!pkg.build || !pkg.build.nsis || pkg.build.nsis.include !== "build/installer.nsh") {
  fail("build.nsis.include should be build/installer.nsh");
}
{
  const nsh = read("build/installer.nsh");
  if (!nsh.includes("!macro customCheckAppRunning")) fail("installer.nsh must define customCheckAppRunning");
  // nsExec does not expand %VARS%, so a command that starts with one never runs.
  if (/nsExec::Execs+`%/.test(nsh)) fail("installer.nsh starts an nsExec command with an unexpanded %VAR%");
  if (!nsh.includes("/F /T")) fail("installer.nsh should force-close TimeHub with its child processes");
}
for (const token of ["--timehub-quit", "quitForInstaller()"]) {
  if (!main.includes(token)) fail("main.js is missing " + token);
}

const release = read('.github/workflows/release.yml');
if (!release.includes('npm run publish')) fail('release.yml no longer publishes');
if (!release.includes('"v*"')) fail('release.yml no longer triggers on v* tags');
if (release.includes('CSC_LINK: ${{ secrets.CSC_LINK }}')) {
  fail('release.yml passes CSC_LINK directly; an empty secret breaks electron-builder 24');
}

const ci = read('.github/workflows/ci.yml');
if (!ci.includes('npm ci') || !ci.includes('npm run smoke') || !ci.includes('npm run dist')) {
  fail('ci.yml should npm ci, smoke, and dist');
}
if (!ci.includes('windows-latest')) fail('ci.yml should run on windows-latest');
if (ci.includes('--publish always') || ci.includes('npm run publish')) {
  fail('ci.yml must not publish');
}

// USB / file-copy logging: off until the web app asks, main window only,
// never reads contents.
for (const token of ['timehub:device-monitoring', 'timehub:device-event', 'fromMainWindow(event)', 'stopDeviceMonitoring()']) {
  if (!main.includes(token)) fail('main.js is missing ' + token);
}
if (/new DeviceMonitor\([^)]*\)[\s\S]{0,80}\.start\(\)/.test(main.split("ipcMain.handle('timehub:device-monitoring'")[0])) {
  fail('device logging must start only from the timehub:device-monitoring handler');
}
const deviceMonitorSrc = read('device-monitor.js');
if (/readFile|createReadStream|\.open\(/.test(deviceMonitorSrc)) {
  fail('device-monitor.js must never read file contents');
}
for (const token of ['setDeviceMonitoring', 'onDeviceEvent', 'deviceMonitoringSupported']) {
  if (!preload.includes(token)) fail('preload.js is missing ' + token);
}
{
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'device-monitor.test.js')], { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) fail('device-monitor test failed\n' + (result.stdout || '') + (result.stderr || ''));
  else console.log((result.stdout || '').trim());
}

function canLaunchElectron() {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

if (canLaunchElectron()) {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch (err) {
    fail('electron is not installed: ' + err.message);
    electronPath = null;
  }
  if (typeof electronPath !== 'string') {
    fail('require("electron") from node did not return the binary path');
  } else {
    const env = Object.assign({}, process.env, { TIMEHUB_SELFTEST: '1' });
    const args = [root];
    if (process.platform === 'linux') args.unshift('--no-sandbox');
    const result = spawnSync(electronPath, args, {
      cwd: root,
      env: env,
      encoding: 'utf8',
      timeout: 60000
    });
    const output = (result.stdout || '') + '\n' + (result.stderr || '');
    if (result.status !== 0 || !output.includes('[timehub-selftest] ok ' + pkg.version)) {
      fail('electron selftest failed (status ' + result.status + ')\n' + output);
    } else {
      console.log(output.trim().split('\n').filter((line) => line.includes('[timehub-selftest]')).join('\n'));
    }
  }
} else {
  console.log('smoke: skipped electron selftest (no display). CI on windows-latest runs it.');
}

if (failed) process.exit(1);
console.log('smoke: ok');
