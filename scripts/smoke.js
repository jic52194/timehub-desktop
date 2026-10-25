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

for (const file of ['main.js', 'preload.js', 'startup-task.js', 'scripts/smoke.js', 'scripts/build-win.js', 'scripts/sign-windows.js', 'electron-builder.config.js']) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(file + ' failed node --check\n' + (result.stderr || result.stdout || ''));
  }
}

const pkg = JSON.parse(read('package.json'));
if (!/^\d+\.\d+\.\d+/.test(pkg.version)) fail('package.json version is not semver: ' + pkg.version);

const files = (pkg.build && pkg.build.files) || [];
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
const winTargets = ((pkg.build.win && pkg.build.win.target) || []).map((target) => target.target);
if (!winTargets.includes('nsis') || !winTargets.includes('appx')) {
  fail('win.target should include nsis and appx: ' + winTargets.join(','));
}
if (!files.includes('startup-task.js')) fail('build.files is missing startup-task.js');

const appx = pkg.build.appx;
if (!appx) fail('build.appx is missing');
if (appx.electronUpdaterAware !== false) fail('appx.electronUpdaterAware must be false so latest.yml stays NSIS-only');
if (appx.customExtensionsPath !== 'build/appx-startup-task.xml') {
  fail('appx.customExtensionsPath should be build/appx-startup-task.xml');
}
if (appx.addAutoLaunchExtension) {
  fail('do not set addAutoLaunchExtension; electron-builder 24 hardcodes TaskId SlackStartup');
}
if (appx.applicationId !== 'TimeHub') fail('appx.applicationId should stay TimeHub');
const guid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
for (const field of ['identityName', 'publisher', 'publisherDisplayName']) {
  const value = String(appx[field] || '');
  if (!value.includes('PLACEHOLDER')) fail('build.appx.' + field + ' is missing a PLACEHOLDER value');
  if (guid.test(value)) fail('build.appx.' + field + ' looks like a real Partner Center GUID');
}
if (!String(appx.publisher).startsWith('CN=PLACEHOLDER')) {
  fail('build.appx.publisher should be an obvious CN=PLACEHOLDER value');
}

const startupXml = read('build/appx-startup-task.xml');
if (!startupXml.includes('Category="windows.startupTask"')) fail('startup task extension missing');
if (!startupXml.includes('TaskId="TimeHub"') || !startupXml.includes('Enabled="true"')) {
  fail('StartupTask should be TaskId TimeHub and Enabled true');
}
if (!startupXml.includes('Executable="app\\TimeHub.exe"')) fail('StartupTask executable should be app\\TimeHub.exe');
if (startupXml.includes('SlackStartup')) fail('startup task must not use the SlackStartup task id');

const startup = require(path.join(root, 'startup-task'));
if (startup.TASK_ID !== 'TimeHub') fail('startup-task.js TASK_ID drifted from the manifest');
if (!startup.powershellScript('get').includes("GetAsync('TimeHub')")) fail('get script does not query TimeHub');
if (!startup.powershellScript('enable').includes('RequestEnableAsync')) fail('enable script missing RequestEnableAsync');
if (startup.powershellScript('disable').includes('RequestEnableAsync')) fail('disable script should not request enable');
if (startup.parseState('noise\n2\n') !== 'enabled') fail('parseState did not read the state code');
if (!startup.isOpenAtLoginState('enabled') || startup.isOpenAtLoginState('disabledByUser')) {
  fail('isOpenAtLoginState mismatch');
}

const signWindows = require(path.join(root, 'scripts', 'sign-windows'));
if (!signWindows.isStorePackage('dist/TimeHub-1.2.1.appx')) fail('isStorePackage should match appx');
if (signWindows.isStorePackage('dist/TimeHub-Setup.exe')) fail('isStorePackage should not match nsis');

const builderConfig = require(path.join(root, 'electron-builder.config.js'));
if (builderConfig.appx.identityName !== appx.identityName) fail('builder config did not keep the package.json identity');
if (builderConfig.appx.publisher !== appx.publisher) fail('builder config did not keep the package.json publisher');
if (builderConfig.win.sign !== signWindows.signWindows) fail('builder config is not using scripts/sign-windows.js');
if (!String(builderConfig.win.target.map((target) => target.target)).includes('appx')) {
  fail('builder config dropped the appx target');
}

function pngSize(buf) {
  if (buf.length < 24 || buf[0] !== 0x89 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
const appxTiles = {
  'build/appx/StoreLogo.png': [50, 50],
  'build/appx/Square44x44Logo.png': [44, 44],
  'build/appx/Square150x150Logo.png': [150, 150],
  'build/appx/Wide310x150Logo.png': [310, 150],
  'build/appx/LargeTile.png': [310, 310],
  'build/appx/SmallTile.png': [71, 71],
  'build/appx/BadgeLogo.png': [24, 24],
  'build/appx/SplashScreen.png': [620, 300]
};
for (const rel of Object.keys(appxTiles)) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    fail('missing ' + rel);
    continue;
  }
  const size = pngSize(fs.readFileSync(full));
  const expected = appxTiles[rel];
  if (!size || size.width !== expected[0] || size.height !== expected[1]) {
    fail(rel + ' size ' + (size ? size.width + 'x' + size.height : 'unreadable') + ' !== ' + expected.join('x'));
  }
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
if (!preload.includes("sendSync('timehub:get-host-info')")) {
  fail('preload.js does not read windowsStore from the main process');
}
if (!preload.includes('windowsStore: hostInfo.windowsStore === true')) {
  fail('preload.js does not expose windowsStore');
}

const main = read('main.js');
if (!main.includes('event.returnValue = app.getVersion()')) {
  fail('main.js does not answer timehub:get-version with app.getVersion()');
}
if (!main.includes('windowsStore: isWindowsStore')) {
  fail('main.js does not answer timehub:get-host-info');
}
const setupStart = main.indexOf('function setupAutoUpdate');
const setupEnd = main.indexOf('function runSelfTest');
const setup = setupStart === -1 || setupEnd === -1 ? '' : main.slice(setupStart, setupEnd);
const storeGuard = setup.indexOf('if (isWindowsStore)');
const updaterRequire = setup.indexOf("require('electron-updater')");
if (storeGuard === -1 || updaterRequire === -1 || storeGuard > updaterRequire) {
  fail('setupAutoUpdate must skip electron-updater when process.windowsStore is set');
}
const trayStart = main.indexOf('function refreshTrayMenu');
const trayEnd = main.indexOf('function createWindow');
const tray = trayStart === -1 || trayEnd === -1 ? '' : main.slice(trayStart, trayEnd);
if (!/if\s*\(\s*!isWindowsStore\s*\)\s*\{[\s\S]*Check for updates/.test(tray)) {
  fail('Check for updates must be hidden when process.windowsStore is set');
}
if (!/if\s*\(\s*!isWindowsStore\s*&&\s*updateDownloaded\s*\)/.test(tray)) {
  fail('Restart to update must be hidden when process.windowsStore is set');
}
if (!main.includes('if (isWindowsStore)') || !main.includes('startupTask.runStartupTask')) {
  fail('Store build must toggle StartupTask instead of only the Run key');
}
if (!/if\s*\(\s*!isWindowsStore\s*&&\s*!app\.getLoginItemSettings\(\)\.wasOpenedAtLogin/.test(main)) {
  fail('Store build must not force setLoginItemSettings on launch');
}
for (const token of ['timehub:update-error', 'timehub:update-ready', 'timehub:restart-to-update']) {
  if (!main.includes(token)) fail('main.js is missing ' + token);
}
if (/autoUpdater\.on\('error',\s*\(\)\s*=>\s*\{\s*\}\)/.test(main)) {
  fail('updater errors are still swallowed');
}

const buildWin = read('scripts/build-win.js');
if (!buildWin.includes('electron-builder.config.js')) fail('build-win.js must load electron-builder.config.js');
if (!buildWin.includes('Store appx does not use CSC_LINK')) fail('build-win.js should record that the Store package ignores CSC_LINK');
const signSource = read('scripts/sign-windows.js');
if (!signSource.includes('isStorePackage') || !signSource.includes('doSign')) {
  fail('sign-windows.js should skip appx and delegate other files to doSign');
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
if (!ci.includes('dist/**/*.appx')) fail('ci.yml should upload the Store appx artifact');
if (!ci.includes('windows-latest')) fail('ci.yml should run on windows-latest');
if (ci.includes('--publish always') || ci.includes('npm run publish')) {
  fail('ci.yml must not publish');
}

const readme = read('README.md');
for (const token of [
  'https://storedeveloper.microsoft.com',
  'build.appx.identityName',
  'build.appx.publisher',
  'build.appx.publisherDisplayName',
  'TIMEHUB_APPX_IDENTITY_NAME',
  'TIMEHUB_APPX_PUBLISHER',
  'TIMEHUB_APPX_PUBLISHER_DISPLAY_NAME',
  'electron-builder.config.js',
  'privacy policy',
  'powerMonitor',
  'desktopCapturer',
  'runFullTrust',
  'TimeHub-Setup.exe'
]) {
  if (!readme.includes(token)) fail('README is missing ' + token);
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
