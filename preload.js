// Exposes a tiny, safe bridge to the TimeHub web app running inside the desktop
// shell. The web app can detect it's running in the desktop app and consume
// native whole-computer idle time (no browser IdleDetector permission prompt).

const { contextBridge, ipcRenderer } = require('electron');

let lastIdle = { idleSeconds: 0, source: 'init', at: Date.now() };
const listeners = new Set();

ipcRenderer.on('timehub:idle', (_e, payload) => {
  lastIdle = Object.assign({ at: Date.now() }, payload);
  // 1) Fire a DOM event the web app can listen for.
  try {
    window.dispatchEvent(new CustomEvent('timehub-native-idle', { detail: lastIdle }));
  } catch (_) {}
  // 2) Notify any registered callbacks.
  listeners.forEach((cb) => { try { cb(lastIdle); } catch (_) {} });
});

contextBridge.exposeInMainWorld('timehubNative', {
  isDesktop: true,
  platform: process.platform,
  // Current whole-computer idle time in seconds (from the OS).
  getIdleSeconds: () => lastIdle.idleSeconds,
  getIdle: () => lastIdle,
  // Subscribe to idle updates: onIdle(({idleSeconds, source}) => {...}) -> unsubscribe
  onIdle: (cb) => {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    try { cb(lastIdle); } catch (_) {}
    return () => listeners.delete(cb);
  }
});
