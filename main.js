// TimeHub desktop (Electron) — loads the live timehub.company app in a native
// window, adds a system tray, auto-launch on login, and native whole-computer
// idle detection fed to the web app (no browser permission prompt needed).

const { app, BrowserWindow, Tray, Menu, powerMonitor, shell, nativeImage } = require('electron');
const path = require('path');

const APP_URL = 'https://timehub.company';
const IDLE_POLL_MS = 5000; // how often we report machine idle time to the web app

let mainWindow = null;
let tray = null;
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
    { label: 'Open TimeHub', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: 'Reload', click: () => { if (mainWindow) mainWindow.reload(); } },
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

  // Screen lock / suspend count as idle immediately; unlock / resume as active.
  ['lock-screen', 'suspend'].forEach((ev) =>
    powerMonitor.on(ev, () => mainWindow && mainWindow.webContents.send('timehub:idle', { idleSeconds: 99999, source: ev })));
  ['unlock-screen', 'resume'].forEach((ev) =>
    powerMonitor.on(ev, () => mainWindow && mainWindow.webContents.send('timehub:idle', { idleSeconds: 0, source: ev })));
}

app.whenReady().then(() => {
  // Default auto-launch on first run (user can toggle it off from the tray).
  if (!app.getLoginItemSettings().wasOpenedAtLogin && app.isPackaged) {
    try { app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true }); } catch (_) {}
  }
  createWindow();
  createTray();
  startIdleReporting();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});

app.on('before-quit', () => { isQuitting = true; });

// Keep running in the tray even when all windows are closed (Windows/Linux).
app.on('window-all-closed', (e) => { /* stay alive in tray */ });
