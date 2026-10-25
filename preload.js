// Exposes a tiny, safe bridge to the TimeHub web app running inside the desktop
// shell. The web app can detect it's running in the desktop app and consume
// native whole-computer idle time (no browser IdleDetector permission prompt).
//
// Screen monitoring (added v1.1.0) is DELIBERATELY thin here: the native side
// only GRABS a screen image when the web app asks for one, and toggles a live
// "being viewed" border. It never holds Supabase keys, never uploads, and never
// decides when to capture. The web app (which already holds the signed-in user's
// session) owns the schedule, the consent check, and the upload. That keeps the
// service-role key off every employee machine.
//
// appVersion is read from the main process (app.getVersion(), i.e. package.json
// of the build that is actually running) over a synchronous IPC channel. Do not
// hardcode a version here — heartbeats and the tray must not drift.

const { contextBridge, ipcRenderer } = require('electron');

let lastIdle = { idleSeconds: 0, source: 'init', at: Date.now() };
const listeners = new Set();

let updateState = { status: 'idle', version: null, message: null };
const updateReadyListeners = new Set();
const updateErrorListeners = new Set();

function readAppVersion() {
  try {
    const version = ipcRenderer.sendSync('timehub:get-version');
    if (typeof version === 'string' && version.trim()) return version.trim();
  } catch (_) {}
  return 'unknown';
}

function emitPageEvent(name, detail) {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail: detail }));
  } catch (_) {}
}

function notify(set, detail) {
  set.forEach((cb) => { try { cb(detail); } catch (_) {} });
}

ipcRenderer.on('timehub:idle', (_e, payload) => {
  lastIdle = Object.assign({ at: Date.now() }, payload);
  try {
    window.dispatchEvent(new CustomEvent('timehub-native-idle', { detail: lastIdle }));
  } catch (_) {}
  listeners.forEach((cb) => { try { cb(lastIdle); } catch (_) {} });
});

ipcRenderer.on('timehub:update-ready', (_e, payload) => {
  const version = payload && payload.version ? String(payload.version) : null;
  updateState = { status: 'ready', version: version, message: null };
  const detail = { version: version };
  emitPageEvent('timehub-update-ready', detail);
  notify(updateReadyListeners, detail);
});

ipcRenderer.on('timehub:update-error', (_e, payload) => {
  const message = payload && payload.message ? String(payload.message) : 'Update failed';
  updateState = { status: 'error', version: updateState.version, message: message };
  const detail = { message: message };
  emitPageEvent('timehub-update-error', detail);
  notify(updateErrorListeners, detail);
});

function readHostInfo() {
  try {
    const info = ipcRenderer.sendSync('timehub:get-host-info');
    if (info && typeof info === 'object') return info;
  } catch (_) {}
  return { windowsStore: false };
}

const appVersion = readAppVersion();
const hostInfo = readHostInfo();

contextBridge.exposeInMainWorld('timehubNative', {
  isDesktop: true,
  platform: process.platform,
  appVersion: appVersion,
  // True when this process is the Microsoft Store / MSIX package.
  // electron-updater does not run in that build; the Store ships updates.
  windowsStore: hostInfo.windowsStore === true,

  // ----- idle (unchanged) -----
  getIdleSeconds: () => lastIdle.idleSeconds,
  getIdle: () => lastIdle,
  onIdle: (cb) => {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    try { cb(lastIdle); } catch (_) {}
    return () => listeners.delete(cb);
  },

  // ----- screen monitoring (added v1.1.0) -----
  // True so the web app knows it can capture here. Screenshots never leave the
  // machine except through the web app's own authenticated upload.
  monitoringSupported: true,

  // Grab a single JPEG of the primary screen. Returns base64 (no data: prefix),
  // or null if capture failed. The web app calls this on its own schedule
  // (only while the company has monitoring enabled, the user has consented, and
  // the user is clocked in and working — all enforced in the web app).
  captureScreen: (opts) => ipcRenderer.invoke('timehub:capture-screen', opts || {}),

  // Show / hide the thin coloured border that tells the person a live view is
  // active. The web app turns it on while an admin is watching and off when the
  // session ends.
  setLiveViewBorder: (on) => ipcRenderer.invoke('timehub:live-border', !!on),

  // ----- auto-update (shell downloads; the page may offer Restart) -----
  // Latest state. status is "idle", "ready", or "error". Subscribers below
  // replay this immediately when the matching status is already set, so a
  // late mount (or a full page reload) still sees a downloaded update.
  getUpdateState: () => ({
    status: updateState.status,
    version: updateState.version,
    message: updateState.message
  }),

  // cb({ version }) when a downloaded update is ready to install.
  // Returns an unsubscribe function.
  onUpdateReady: (cb) => {
    if (typeof cb !== 'function') return () => {};
    updateReadyListeners.add(cb);
    if (updateState.status === 'ready') {
      try { cb({ version: updateState.version }); } catch (_) {}
    }
    return () => updateReadyListeners.delete(cb);
  },

  // cb({ message }) when an update check or download fails.
  // Returns an unsubscribe function.
  onUpdateError: (cb) => {
    if (typeof cb !== 'function') return () => {};
    updateErrorListeners.add(cb);
    if (updateState.status === 'error' && updateState.message) {
      try { cb({ message: updateState.message }); } catch (_) {}
    }
    return () => updateErrorListeners.delete(cb);
  },

  // Quit and silently install the downloaded update, then relaunch.
  // Resolves false when nothing has been downloaded (dev, or no update yet).
  restartToUpdate: () => ipcRenderer.invoke('timehub:restart-to-update')
});
