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

const { contextBridge, ipcRenderer } = require('electron');

let lastIdle = { idleSeconds: 0, source: 'init', at: Date.now() };
const listeners = new Set();

ipcRenderer.on('timehub:idle', (_e, payload) => {
  lastIdle = Object.assign({ at: Date.now() }, payload);
  try {
    window.dispatchEvent(new CustomEvent('timehub-native-idle', { detail: lastIdle }));
  } catch (_) {}
  listeners.forEach((cb) => { try { cb(lastIdle); } catch (_) {} });
});

contextBridge.exposeInMainWorld('timehubNative', {
  isDesktop: true,
  platform: process.platform,
  appVersion: '1.2.0',

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

  // Grab a single JPEG of the primary screen. Returns a data URL string, or null
  // if capture failed/was blocked. The web app calls this on its own schedule
  // (only while the company has monitoring enabled, the user has consented, and
  // the user is clocked in and working — all enforced in the web app).
  captureScreen: (opts) => ipcRenderer.invoke('timehub:capture-screen', opts || {}),

  // Show / hide the thin coloured border that tells the person a live view is
  // active. The web app turns it on while an admin is watching and off when the
  // session ends.
  setLiveViewBorder: (on) => ipcRenderer.invoke('timehub:live-border', !!on),
});
