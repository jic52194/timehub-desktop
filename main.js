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

const { app, BrowserWindow, Tray, Menu, powerMonitor, shell, nativeImage, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');

const APP_URL = process.env.TIMEHUB_URL || 'https://app.timehub.company';
const IDLE_POLL_MS = 5000; // how often we report machine idle time to the web app
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000; // re-check for updates every 6 hours

let mainWindow = null;
let tray = null;
let borderWindow = null;
let isQuitting = false;

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
  try {
    const p = path.join(__dirname, 'build', 'icon.ico');
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  } catch (_) {}
  return undefined; // fall back to Electron default
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
  const menu = Menu.buildFromTemplate([
    { label: `TimeHub v${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Open TimeHub', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: 'Reload', click: () => { if (mainWindow) mainWindow.reload(); } },
    { label: 'Check for updates…', click: () => { try { if (autoUpdater) autoUpdater.checkForUpdatesAndNotify(); } catch (_) {} } },
    { type: 'separator' },
    { label: 'Start automatically on login', type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }) },
    { type: 'separator' },
    { label: 'Quit TimeHub', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setToolTip('TimeHub');
  tray.setContextMenu(menu);
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
// Returns a JPEG data URL of the primary display. The web app decides whether to
// call this at all; the native side just grabs the current screen.
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
// on the next quit, so the fleet stays current without manual re-installs.
// No-op in dev (unpackaged) and degrades gracefully if the module is missing.
let autoUpdater = null;
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try { ({ autoUpdater } = require('electron-updater')); } catch (_) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    try {
      if (tray) tray.setToolTip('TimeHub — update ready (installs on quit)');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('timehub:update-ready', { version: info && info.version });
      }
    } catch (_) {}
  });
  autoUpdater.on('error', () => {}); // never surface update errors to the user
  const check = () => { try { autoUpdater.checkForUpdates(); } catch (_) {} };
  check();
  setInterval(check, UPDATE_CHECK_MS);
}

app.whenReady().then(() => {
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
