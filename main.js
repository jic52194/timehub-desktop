// TimeHub desktop (Electron) — loads the live TimeHub web app in a native
// window, adds a system tray, auto-launch on login, native whole-computer idle
// detection fed to the web app, and auto-update from GitHub Releases.
//
// Host: defaults to the GitHub/Vercel app at app.timehub.company. Override at
// launch with the TIMEHUB_URL env var (e.g. to point at a staging host) without
// a rebuild.
//
// v1.1.0 adds two native capabilities for COMPLIANT, consent-based screen
// monitoring. The native side only (a) grabs a single screen image when the web
// app asks, and (b) shows a thin coloured border while a live view is active.
// It holds no Supabase keys and performs no uploads: the web app, which already
// holds the signed-in user's session, owns the schedule, the consent gate and
// the upload. Capture only ever happens because the web app requested it, and
// the web app only requests it when the company has monitoring enabled, the
// person has accepted the notice, and they are clocked in and working.
//
// TODO(crash-reporting): nothing is wired. A vendor such as Sentry can be
// initialized here later from an env DSN. Do not commit a DSN or a half-configured SDK.

const { app, BrowserWindow, Tray, Menu, powerMonitor, shell, nativeImage, ipcMain, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_URL = process.env.TIMEHUB_URL || 'https://app.timehub.company';
const IDLE_POLL_MS = 5000; // how often we report machine idle time to the web app
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000; // re-check for updates every 6 hours
const UPDATER_LOG_MAX_BYTES = 256 * 1024;

let mainWindow = null;
let tray = null;
let borderWindow = null;
let isQuitting = false;
let autoUpdater = null;
let updateDownloaded = false;
let pageReady = false;
let pendingUpdate = null; // latest { channel, payload } to replay after a full load

if (process.env.TIMEHUB_SELFTEST === '1') {
  app.disableHardwareAcceleration();
  if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
}

// Synchronous on purpose: preload reads this before the page script runs and
// exposes it as window.timehubNative.appVersion. The value is app.getVersion()
// (package.json of this build), never a literal copied into preload.js.
ipcMain.on('timehub:get-version', (event) => {
  event.returnValue = app.getVersion();
});

ipcMain.handle('timehub:restart-to-update', () => installDownloadedUpdate());

// --- Single instance: focus the existing window instead of opening a 2nd one ---
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function resolveIcon() {
  const candidates = [
    path.join(__dirname, 'build', 'icon.ico'),
    path.join(__dirname, 'build', 'icon.png')
  ];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const img = nativeImage.createFromPath(candidates[i]);
      if (!img.isEmpty()) return img;
    } catch (_) {}
  }
  return undefined; // fall back to Electron default
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send(channel, payload); } catch (_) {}
}

function publishUpdate(channel, payload) {
  pendingUpdate = { channel: channel, payload: payload };
  if (pageReady) sendToRenderer(channel, payload);
}

function logUpdater(level, message) {
  const text = String(message || '');
  const line = new Date().toISOString() + ' [' + level + '] ' + text;
  if (level === 'error') console.error('[timehub-updater]', text);
  else console.log('[timehub-updater]', text);
  try {
    if (!app.isReady()) return;
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'updater.log');
    if (fs.existsSync(file) && fs.statSync(file).size > UPDATER_LOG_MAX_BYTES) {
      fs.unlinkSync(file);
    }
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch (_) {}
}

function sanitizeUpdateMessage(value) {
  let message = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!message) message = 'Update failed';
  message = message.replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+/gi, '[redacted]');
  message = message.replace(/https?:\/\/\S+/gi, (url) => {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
  });
  if (message.length > 400) message = message.slice(0, 400) + '...';
  return message;
}

function setTrayTip(text) {
  if (!tray) return;
  const tip = String(text || 'TimeHub').replace(/\s+/g, ' ').trim().slice(0, 127);
  try { tray.setToolTip(tip || 'TimeHub'); } catch (_) {}
}

function reportUpdateError(err) {
  const raw = err && err.stack ? String(err.stack) : String(err && err.message ? err.message : err || 'Update failed');
  const message = sanitizeUpdateMessage(err && err.message ? err.message : raw);
  logUpdater('error', sanitizeUpdateMessage(raw));
  if (updateDownloaded) {
    setTrayTip('TimeHub — update ready (last check failed)');
  } else {
    setTrayTip('TimeHub — update failed: ' + message.slice(0, 80));
  }
  publishUpdate('timehub:update-error', { message: message });
}

function installDownloadedUpdate() {
  if (!autoUpdater || !updateDownloaded) {
    logUpdater('info', 'restart-to-update ignored: no downloaded update');
    return false;
  }
  try {
    // Silent install + relaunch. isForceRunAfter is honored only when silent.
    autoUpdater.quitAndInstall(true, true);
    return true;
  } catch (err) {
    reportUpdateError(err);
    return false;
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  const items = [
    { label: 'TimeHub v' + app.getVersion(), enabled: false }
  ];
  if (updateDownloaded) {
    items.push({ label: 'Restart to update', click: () => installDownloadedUpdate() });
  }
  items.push(
    { type: 'separator' },
    { label: 'Open TimeHub', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: 'Reload', click: () => { if (mainWindow) mainWindow.reload(); } },
    { label: 'Check for updates…', click: () => checkForUpdates(true) },
    { type: 'separator' },
    { label: 'Start automatically on login', type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }) },
    { type: 'separator' },
    { label: 'Quit TimeHub', click: () => { isQuitting = true; app.quit(); } }
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1115',
    icon: resolveIcon(),
    title: 'TimeHub',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.on('did-start-loading', () => { pageReady = false; });
  mainWindow.webContents.on('did-finish-load', () => {
    pageReady = true;
    if (pendingUpdate) sendToRenderer(pendingUpdate.channel, pendingUpdate.payload);
  });

  mainWindow.loadURL(APP_URL);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open external links (anything not on timehub.company) in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_URL) && !url.startsWith('https://') ) return;
    if (!url.startsWith(APP_URL) && !url.includes('supabase.co')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Minimize-to-tray instead of quitting when the window is closed.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = resolveIcon();
  tray = new Tray(icon || nativeImage.createEmpty());
  refreshTrayMenu();
  setTrayTip('TimeHub');
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

// Report the machine's idle time to the web app every few seconds. The web app
// reads window.timehubNative (see preload.js) and uses this as the source of
// truth for idle breaks when running inside the desktop app.
function startIdleReporting() {
  const tick = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    let idleSeconds = 0;
    try { idleSeconds = powerMonitor.getSystemIdleTime(); } catch (_) {}
    mainWindow.webContents.send('timehub:idle', { idleSeconds, source: 'powerMonitor' });
  };
  setInterval(tick, IDLE_POLL_MS);
  tick();

  ['lock-screen', 'suspend'].forEach((ev) =>
    powerMonitor.on(ev, () => mainWindow && mainWindow.webContents.send('timehub:idle', { idleSeconds: 99999, source: ev })));
  ['unlock-screen', 'resume'].forEach((ev) =>
    powerMonitor.on(ev, () => mainWindow && mainWindow.webContents.send('timehub:idle', { idleSeconds: 0, source: ev })));
}

// --- Screen monitoring: single-frame capture on request from the web app ------
// Returns base64-encoded JPEG bytes (no data: prefix). The web app decides whether
// to call this at all; the native side just grabs the current screen.
ipcMain.handle('timehub:capture-screen', async (_e, opts) => {
  try {
    const primary = screen.getPrimaryDisplay();
    const { width, height } = primary.size;
    const scale = Math.min(1, (opts && opts.maxWidth ? opts.maxWidth : 1280) / width);
    const thumb = { width: Math.round(width * scale), height: Math.round(height * scale) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumb });
    if (!sources || !sources.length) return null;
    // Primary display first, else the first screen.
    const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
    const img = src.thumbnail;
    if (!img || img.isEmpty()) return null;
    return img.toJPEG(Math.max(30, Math.min(90, (opts && opts.quality) || 60))).toString('base64');
  } catch (err) {
    return null;
  }
});

// --- Live-view "being viewed" border -----------------------------------------
// A frameless, transparent, click-through, always-on-top window that draws a
// thin coloured border around the primary display while an admin is watching.
function ensureBorderWindow() {
  if (borderWindow && !borderWindow.isDestroyed()) return borderWindow;
  const b = screen.getPrimaryDisplay().bounds;
  borderWindow = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, transparent: true, resizable: false, movable: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
    hasShadow: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  borderWindow.setIgnoreMouseEvents(true); // click-through: never blocks the user
  borderWindow.setAlwaysOnTop(true, 'screen-saver');
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;height:100%;background:transparent;overflow:hidden}' +
    '#b{position:fixed;inset:0;border:3px solid #ef4444;box-sizing:border-box;' +
    'border-radius:2px;pointer-events:none}' +
    '#t{position:fixed;top:0;left:50%;transform:translateX(-50%);background:#ef4444;' +
    'color:#fff;font:600 11px system-ui,sans-serif;padding:2px 10px;border-radius:0 0 6px 6px;' +
    'pointer-events:none}</style></head><body><div id="b"></div>' +
    '<div id="t">Screen is being viewed</div></body></html>';
  borderWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  borderWindow.on('closed', () => { borderWindow = null; });
  return borderWindow;
}

ipcMain.handle('timehub:live-border', (_e, on) => {
  try {
    const w = ensureBorderWindow();
    if (on) { w.showInactive(); } else { w.hide(); }
    return true;
  } catch (_) { return false; }
});

// --- Auto-update (electron-updater → GitHub Releases) ------------------------
// Checks on launch and every few hours. Downloads in the background and installs
// on the next quit, or immediately if the page / tray calls restart-to-update.
// Failures are logged, shown on the tray tooltip, and forwarded to the page as
// timehub:update-error. No-op in dev (unpackaged) and if the module is missing.
function checkForUpdates(notify) {
  if (!autoUpdater) {
    if (notify) setTrayTip('TimeHub — updates run in the installed app');
    logUpdater('info', 'update check skipped (unpackaged or updater unavailable)');
    return;
  }
  try {
    const pending = notify ? autoUpdater.checkForUpdatesAndNotify() : autoUpdater.checkForUpdates();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch (err) {
    reportUpdateError(err);
  }
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    logUpdater('error', 'electron-updater is not available: ' + (err && err.message ? err.message : err));
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => {
    logUpdater('info', 'checking for updates');
  });
  autoUpdater.on('update-available', (info) => {
    const version = info && info.version ? String(info.version) : 'update';
    logUpdater('info', 'update available ' + version);
    setTrayTip('TimeHub — downloading ' + version);
  });
  autoUpdater.on('update-not-available', () => {
    logUpdater('info', 'no update available');
    if (!updateDownloaded) setTrayTip('TimeHub');
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    const version = info && info.version ? String(info.version) : null;
    logUpdater('info', 'update downloaded' + (version ? ' ' + version : ''));
    setTrayTip('TimeHub — update ready (installs on quit)');
    publishUpdate('timehub:update-ready', { version: version });
    refreshTrayMenu();
  });
  autoUpdater.on('error', (err) => reportUpdateError(err));
  checkForUpdates(false);
  setInterval(() => checkForUpdates(false), UPDATE_CHECK_MS);
}

// Hidden-window check used by `npm run smoke`. Does not load the web app.
function runSelfTest() {
  const icon = resolveIcon();
  if (!icon || icon.isEmpty()) {
    console.error('[timehub-selftest] resolveIcon empty');
    app.exit(1);
    return;
  }
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const fail = (msg) => {
    console.error('[timehub-selftest]', msg);
    try { win.destroy(); } catch (_) {}
    app.exit(1);
  };
  const timer = setTimeout(() => fail('timed out'), 15000);
  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(
        '({' +
          'appVersion: window.timehubNative && window.timehubNative.appVersion,' +
          'isDesktop: window.timehubNative && window.timehubNative.isDesktop,' +
          'hasOnUpdateReady: typeof (window.timehubNative && window.timehubNative.onUpdateReady),' +
          'hasOnUpdateError: typeof (window.timehubNative && window.timehubNative.onUpdateError),' +
          'hasRestart: typeof (window.timehubNative && window.timehubNative.restartToUpdate),' +
          'hasGetUpdateState: typeof (window.timehubNative && window.timehubNative.getUpdateState),' +
          'state: window.timehubNative ? window.timehubNative.getUpdateState() : null' +
        '})'
      );
      const expected = app.getVersion();
      if (!result || result.appVersion !== expected) {
        fail('appVersion ' + (result && result.appVersion) + ' !== ' + expected);
        return;
      }
      if (result.isDesktop !== true) return fail('isDesktop');
      if (result.hasOnUpdateReady !== 'function') return fail('onUpdateReady');
      if (result.hasOnUpdateError !== 'function') return fail('onUpdateError');
      if (result.hasRestart !== 'function') return fail('restartToUpdate');
      if (result.hasGetUpdateState !== 'function') return fail('getUpdateState');
      if (!result.state || result.state.status !== 'idle') return fail('update state not idle');
      const restarted = await win.webContents.executeJavaScript('window.timehubNative.restartToUpdate()');
      if (restarted !== false) return fail('restartToUpdate should be false before a download');
      clearTimeout(timer);
      console.log('[timehub-selftest] ok ' + expected);
      win.destroy();
      app.exit(0);
    } catch (err) {
      fail(err && err.stack ? err.stack : String(err));
    }
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>selftest</title>'));
}

app.whenReady().then(() => {
  if (!gotLock) return;
  if (process.env.TIMEHUB_SELFTEST === '1') {
    runSelfTest();
    return;
  }
  if (!app.getLoginItemSettings().wasOpenedAtLogin && app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true }); } catch (_) {}
  }
  createWindow();
  createTray();
  startIdleReporting();
  setupAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});

app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', (e) => { /* stay alive in tray */ });
