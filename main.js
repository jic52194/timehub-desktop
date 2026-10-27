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
const { DeviceMonitor } = require('./device-monitor');

const APP_URL = process.env.TIMEHUB_URL || 'https://app.timehub.company';
const IDLE_POLL_MS = 5000; // how often we report machine idle time to the web app
const UPDATE_CHECK_MS = 60 * 60 * 1000; // re-check for updates every hour
const UPDATER_LOG_MAX_BYTES = 256 * 1024;
// A downloaded update installs itself once the computer has been idle this
// long, or the screen is locked, so nobody has to quit TimeHub to update.
const AUTO_INSTALL_IDLE_S = 10 * 60;
const AUTO_INSTALL_POLL_MS = 60 * 1000;
// Local hours when an update may install by itself (05:00 to 16:00).
const INSTALL_FROM_HOUR = 5;
const INSTALL_UNTIL_HOUR = 16;
// Reconnect screen: retry after 5 s, then back off to at most 60 s.
const RETRY_MIN_S = 5;
const RETRY_MAX_S = 60;
// A frozen page is reloaded after this long.
const UNRESPONSIVE_RELOAD_MS = 30 * 1000;

let mainWindow = null;
let tray = null;
let borderWindow = null;
let isQuitting = false;
let autoUpdater = null;
let updateDownloaded = false;
let pageReady = false;
let pendingUpdate = null; // latest { channel, payload } to replay after a full load
let screenLocked = false;
let autoInstallTimer = null;
let offlineAttempt = 0; // consecutive failed loads of the web app
let showingOffline = false;
let offlineResetTimer = null;
let unresponsiveTimer = null;
let deviceMonitor = null; // USB / file-copy logging, on only while the web app asks
const deviceQueue = []; // device events held while the page is (re)loading
const DEVICE_QUEUE_MAX = 1000;

if (process.env.TIMEHUB_SELFTEST === '1') {
  // Own data folder, so the single-instance lock never collides with an
  // installed TimeHub that is running on the same machine.
  app.setPath('userData', path.join(require('os').tmpdir(), 'timehub-selftest-' + process.pid));
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

// The installer runs `TimeHub.exe --timehub-quit` before an upgrade or
// uninstall. The new process hands the flag to the running copy through the
// single-instance lock below and exits; the running copy then quits cleanly.
const QUIT_FLAG = '--timehub-quit';
const QUIT_FALLBACK_MS = 3000;
const isQuitRequest = (argv) => Array.isArray(argv) && argv.indexOf(QUIT_FLAG) !== -1;

// Quit for good: no hide-to-tray, no helper processes left behind, and no
// pending update install kicked off on the way out (an installer is already
// running, and a second one would collide with it).
function quitForInstaller() {
  isQuitting = true;
  if (autoUpdater) {
    try { autoUpdater.autoInstallOnAppQuit = false; } catch (_) {}
  }
  stopDeviceMonitoring();
  if (tray) { try { tray.destroy(); } catch (_) {} tray = null; }
  app.quit();
  // If a window or handler still blocks the quit, exit anyway; the installer
  // force-closes TimeHub a few seconds later regardless.
  setTimeout(() => app.exit(0), QUIT_FALLBACK_MS).unref();
}

// --- Single instance: focus the existing window instead of opening a 2nd one ---
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else if (isQuitRequest(process.argv)) {
  // Nothing was running: a quit request must never start TimeHub.
  app.exit(0);
} else {
  app.on('second-instance', (_event, argv) => {
    if (isQuitRequest(argv)) {
      quitForInstaller();
      return;
    }
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

// --- Blank-page watchdog ---------------------------------------------------
// If the window is visible on TimeHub but the page has drawn nothing for two
// checks in a row, reload it (at most once every 2 minutes). Covers a page
// that reloaded while hidden and never painted, or a script that failed.
const BLANK_CHECK_MS = 30 * 1000;
let blankStrikes = 0;
let lastBlankReload = 0;
async function checkNotBlank(why) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || showingOffline) return;
  const wc = mainWindow.webContents;
  if (wc.isLoading() || !isAppUrl(wc.getURL())) return;
  let chars = -1;
  try {
    chars = await wc.executeJavaScript(
      "(function(){var r=document.getElementById('root');return r?(r.innerText||'').trim().length:0;})()",
      true);
  } catch (_) { chars = 0; }
  if (chars > 0) { blankStrikes = 0; return; }
  blankStrikes += 1;
  try { wc.invalidate(); } catch (_) {}
  if (blankStrikes < 2 || Date.now() - lastBlankReload < 2 * 60 * 1000) return;
  blankStrikes = 0;
  lastBlankReload = Date.now();
  logUpdater('error', 'page was blank (' + why + '), reloading');
  try { wc.reloadIgnoringCache(); } catch (_) { loadApp(); }
}

function isAppUrl(url) {
  return typeof url === 'string' && url.startsWith(APP_URL);
}

function loadApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.loadURL(APP_URL).catch(() => {}); } catch (_) {}
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Local "reconnecting" screen. Counts down, then goes back to TimeHub; another
// failure brings it back with a longer wait (5 s doubling up to 60 s).
function showOffline(reason) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  pageReady = false;
  showingOffline = true;
  clearTimeout(offlineResetTimer);
  offlineAttempt += 1;
  const wait = Math.min(RETRY_MAX_S, RETRY_MIN_S * Math.pow(2, Math.max(0, offlineAttempt - 1)));
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>TimeHub</title><style>' +
    'html,body{margin:0;height:100%;background:#0f1115;color:#e5e7eb;font:15px system-ui,Segoe UI,sans-serif}' +
    '.c{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:24px}' +
    'h1{font-size:20px;margin:0;color:#fff}p{margin:0;color:#9ca3af;max-width:440px}' +
    'button{margin-top:8px;background:#F47B20;color:#fff;border:0;border-radius:10px;padding:10px 22px;font:600 15px system-ui;cursor:pointer}' +
    '.r{font-size:12px;color:#6b7280}</style></head><body><div class="c">' +
    '<h1>Reconnecting to TimeHub…</h1>' +
    '<p>TimeHub can\'t reach the internet right now. Your clock and shift are safe; this window reconnects by itself.</p>' +
    '<p id="n">Trying again in ' + wait + ' s</p>' +
    '<button onclick="go()">Try now</button>' +
    '<p class="r">' + escapeHtml(reason) + '</p></div><script>' +
    'var s=' + wait + ';function go(){location.replace(' + JSON.stringify(APP_URL) + ');}' +
    'setInterval(function(){s--;if(s<=0){go();}else{document.getElementById("n").textContent="Trying again in "+s+" s";}},1000);' +
    'window.addEventListener("online",go);' +
    '</script></body></html>';
  try {
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {});
  } catch (_) {}
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
      // backgroundThrottling stays at Chromium's default. 1.3.3 turned it off
      // to keep the heartbeat on time in the tray, and some PCs then showed a
      // blank window after the page reloaded while hidden. Hidden pages still
      // check in about once a minute, inside the 2-minute offline limit.
    }
  });

  mainWindow.webContents.on('did-start-loading', () => { pageReady = false; });
  mainWindow.webContents.on('did-finish-load', () => {
    // The reconnect screen is not the web app: nothing listens there.
    if (!isAppUrl(mainWindow.webContents.getURL())) {
      showingOffline = true;
      return;
    }
    showingOffline = false;
    // A failed load also "finishes" (Chromium's error page), so only reset
    // the back-off once TimeHub has stayed up for a while.
    clearTimeout(offlineResetTimer);
    offlineResetTimer = setTimeout(() => { if (!showingOffline) offlineAttempt = 0; }, 15000);
    pageReady = true;
    if (pendingUpdate) sendToRenderer(pendingUpdate.channel, pendingUpdate.payload);
    flushDeviceQueue();
  });

  // No internet, DNS trouble, or TimeHub down: show the reconnect screen
  // instead of a blank window, and keep retrying.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted by a newer navigation
    logUpdater('info', 'page load failed ' + code + ' ' + desc);
    showOffline(desc);
  });
  mainWindow.webContents.on('did-navigate', (_e, url, httpCode) => {
    if (isAppUrl(url) && httpCode >= 500) {
      logUpdater('info', 'server error ' + httpCode);
      showOffline('TimeHub server error ' + httpCode);
    }
  });

  // Crashed or frozen page: reload it.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logUpdater('error', 'page process gone: ' + (details && details.reason));
    setTimeout(() => loadApp(), 1000);
  });
  mainWindow.on('unresponsive', () => {
    clearTimeout(unresponsiveTimer);
    unresponsiveTimer = setTimeout(() => {
      logUpdater('error', 'page unresponsive, reloading');
      try { mainWindow.webContents.forcefullyCrashRenderer(); } catch (_) {}
      loadApp();
    }, UNRESPONSIVE_RELOAD_MS);
  });
  mainWindow.on('responsive', () => clearTimeout(unresponsiveTimer));

  loadApp();

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Whenever the window comes back (tray, taskbar, second launch), make
  // Chromium paint it again, then make sure the page actually has content.
  ['show', 'restore', 'focus'].forEach((ev) =>
    mainWindow.on(ev, () => {
      try { mainWindow.webContents.invalidate(); } catch (_) {}
      setTimeout(() => checkNotBlank(ev), 4000);
    }));
  setInterval(() => checkNotBlank('timer'), BLANK_CHECK_MS);

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
//
// Each report carries the real seconds since the last keyboard/mouse input
// and locked=true while the screen is locked or the computer is asleep. The
// web app counts a locked screen as idle straight away. (Before 1.3.3 a lock
// sent idleSeconds 99999, then the next 5 s tick sent the small real number,
// so a locked PC showed "active" for the first minute and the server could
// start the idle period hours too early.)
function isLockedNow() {
  if (screenLocked) return true;
  try { return powerMonitor.getSystemIdleState(1) === 'locked'; } catch (_) { return false; }
}

function sendIdle(source) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let idleSeconds = 0;
  try { idleSeconds = powerMonitor.getSystemIdleTime(); } catch (_) {}
  mainWindow.webContents.send('timehub:idle', { idleSeconds, locked: isLockedNow(), source });
}

function startIdleReporting() {
  const tick = () => sendIdle('powerMonitor');
  setInterval(tick, IDLE_POLL_MS);
  tick();

  ['lock-screen', 'suspend'].forEach((ev) =>
    powerMonitor.on(ev, () => {
      screenLocked = true;
      sendIdle(ev);
      if (ev === 'lock-screen') maybeAutoInstall('screen locked');
    }));
  ['unlock-screen', 'resume'].forEach((ev) =>
    powerMonitor.on(ev, () => {
      screenLocked = false;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('timehub:idle', { idleSeconds: 0, locked: false, source: ev });
      }
      // Back from sleep: if we were on the reconnect screen, try straight away.
      if (showingOffline) loadApp();
    }));
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

// --- USB / removable drive and file-copy logging (added v1.3.0) ---------------
// Off until the web app turns it on. The web app turns it on only when the
// company has monitoring enabled and the person has accepted the current
// monitoring notice (same rule as screenshots), and off again when that stops
// being true or the person signs out. Events carry file names, types, sizes
// and times only — never contents. The web app records them.
function flushDeviceQueue() {
  if (!pageReady) return;
  while (deviceQueue.length) sendToRenderer('timehub:device-event', deviceQueue.shift());
}

function sendDeviceEvent(ev) {
  deviceQueue.push(ev);
  if (deviceQueue.length > DEVICE_QUEUE_MAX) deviceQueue.shift();
  flushDeviceQueue();
}

function stopDeviceMonitoring() {
  if (deviceMonitor) {
    try { deviceMonitor.stop(); } catch (_) {}
    deviceMonitor = null;
  }
  deviceQueue.length = 0;
}

function fromMainWindow(event) {
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

ipcMain.handle('timehub:device-monitoring', (event, on) => {
  if (!fromMainWindow(event)) return { ok: false, active: false, reason: 'not-main-window' };
  if (process.platform !== 'win32') return { ok: false, active: false, reason: 'unsupported-platform' };
  if (!on) {
    stopDeviceMonitoring();
    return { ok: true, active: false };
  }
  if (!deviceMonitor) {
    try {
      let downloads = null;
      try { downloads = app.getPath('downloads'); } catch (_) {}
      deviceMonitor = new DeviceMonitor({
        scriptDir: app.getPath('userData'),
        folders: downloads ? [{ root: downloads, label: 'Downloads' }] : []
      });
      deviceMonitor.on('event', sendDeviceEvent);
      deviceMonitor.on('error', (err) => console.warn('[timehub-devices]', err && err.message ? err.message : err));
      deviceMonitor.start();
    } catch (err) {
      deviceMonitor = null;
      return { ok: false, active: false, reason: String(err && err.message ? err.message : err).slice(0, 200) };
    }
  }
  return { ok: true, active: true };
});

ipcMain.handle('timehub:removable-drives', (event) => {
  if (!fromMainWindow(event) || !deviceMonitor) return [];
  return deviceMonitor.drives();
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

// Install a downloaded update when the screen is locked or the computer has
// been idle 10+ minutes. Silent; TimeHub restarts itself (hidden in the tray
// if the window was hidden). The person's clock-in lives on the server, so a
// restart never loses it.
function inInstallWindow(d = new Date()) {
  const h = d.getHours();
  return h >= INSTALL_FROM_HOUR && h < INSTALL_UNTIL_HOUR;
}

function maybeAutoInstall(why) {
  if (!updateDownloaded || isQuitting) return;
  // Never restart TimeHub during working hours; it installs on the next quit
  // or during the quiet window.
  if (!inInstallWindow()) return;
  let idle = 0;
  try { idle = powerMonitor.getSystemIdleTime(); } catch (_) {}
  if (!screenLocked && idle < AUTO_INSTALL_IDLE_S) return;
  logUpdater('info', 'auto-installing update (' + why + ', idle ' + idle + ' s)');
  if (autoInstallTimer) { clearInterval(autoInstallTimer); autoInstallTimer = null; }
  installDownloadedUpdate();
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
    setTrayTip('TimeHub — update ready (installs outside working hours)');
    publishUpdate('timehub:update-ready', { version: version });
    refreshTrayMenu();
    // Install by itself when nobody is using the computer.
    if (!autoInstallTimer) {
      autoInstallTimer = setInterval(() => maybeAutoInstall('idle'), AUTO_INSTALL_POLL_MS);
    }
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
          'hasSetDeviceMonitoring: typeof (window.timehubNative && window.timehubNative.setDeviceMonitoring),' +
          'hasOnDeviceEvent: typeof (window.timehubNative && window.timehubNative.onDeviceEvent),' +
          'hasGetRemovableDrives: typeof (window.timehubNative && window.timehubNative.getRemovableDrives),' +
          'deviceSupported: window.timehubNative && window.timehubNative.deviceMonitoringSupported,' +
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
      if (result.hasSetDeviceMonitoring !== 'function') return fail('setDeviceMonitoring');
      if (result.hasOnDeviceEvent !== 'function') return fail('onDeviceEvent');
      if (result.hasGetRemovableDrives !== 'function') return fail('getRemovableDrives');
      if (result.deviceSupported !== (process.platform === 'win32')) return fail('deviceMonitoringSupported');
      // Only the main TimeHub window may switch logging on; this test window
      // is not it, so the request must be refused and nothing may start.
      const dev = await win.webContents.executeJavaScript('window.timehubNative.setDeviceMonitoring(true)');
      if (!dev || dev.active !== false || deviceMonitor) return fail('device logging started from a non-main window');
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

app.on('before-quit', () => { isQuitting = true; stopDeviceMonitoring(); });
app.on('window-all-closed', (e) => { /* stay alive in tray */ });
