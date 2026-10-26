// Removable-drive and file-copy detection (Windows), added v1.3.0.
//
// What it records: a USB / removable drive being connected or removed, each
// file written to such a drive while it is mounted (file_copied), and each
// new file saved to the person's Downloads folder by any browser or app
// (file_downloaded) — the file's name, extension, size and time. It never
// opens or reads a file's contents.
//
// It only runs while the web app has switched it on (setDeviceMonitoring(true)
// over the bridge). The web app does that only when the company has monitoring
// enabled and the person has accepted the current monitoring notice, the same
// rule as screenshots. Events go to the web app, which records them with the
// signed-in user's own session; nothing is uploaded from here.
//
// No dependency on Electron, so scripts/device-monitor.test.js can run it in
// plain Node with a fake drive source.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const POLL_SECONDS = 4; // how often the drive list is refreshed
const SETTLE_MS = 2000; // wait this long after the last write before stat()
const FRESH_SLACK_MS = 5000; // clock slack when deciding a file is new
const MAX_PENDING = 5000; // per drive; protects against runaway event storms
const MAX_SEEN = 20000; // per drive; dedupe memory cap

// Windows/macOS housekeeping, not user files.
const IGNORE_DIRS = /^(system volume information|\$recycle\.bin|recycler|\.trashes|\.spotlight-v100|\.fseventsd|\.temporaryitems)$/i;
const IGNORE_FILES = /^(~\$.*|.*\.tmp|.*\.crdownload|.*\.partial|.*\.part|.*\.download|.*\.opdownload|desktop\.ini|thumbs\.db|\.ds_store|indexervolumeguid|wpsettings\.dat|autorun\.inf)$/i;

function shouldIgnore(rel) {
  const parts = String(rel || '').split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return true;
  for (let i = 0; i < parts.length - 1; i++) {
    if (IGNORE_DIRS.test(parts[i])) return true;
  }
  const base = parts[parts.length - 1];
  if (IGNORE_DIRS.test(base)) return true;
  return IGNORE_FILES.test(base) || base.startsWith('._');
}

function extOf(name) {
  const e = path.extname(String(name || '')).toLowerCase().replace(/^\./, '');
  return e ? e.slice(0, 16) : null;
}

function cleanLabel(v) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').trim();
  return s ? s.slice(0, 64) : null;
}

// PowerShell loop that prints one "DRIVES <json>" line every few seconds:
// every removable drive (DriveType=2: pen drives, SD cards) plus every
// volume on a USB-attached disk (external HDD/SSD, which Windows reports as
// a fixed drive). Empty card-reader slots (no file system) are skipped. It
// exits by itself when the parent app is gone, so it never lingers.
function powershellScript(parentPid) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$parent = ' + Number(parentPid),
    'while ($true) {',
    '  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit }',
    '  $map = @{}',
    '  Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2" | ForEach-Object { $map[$_.DeviceID] = $_ }',
    '  Get-CimInstance Win32_DiskDrive -Filter "InterfaceType=\'USB\'" | ForEach-Object {',
    '    Get-CimAssociatedInstance -InputObject $_ -ResultClassName Win32_DiskPartition | ForEach-Object {',
    '      Get-CimAssociatedInstance -InputObject $_ -ResultClassName Win32_LogicalDisk | ForEach-Object { $map[$_.DeviceID] = $_ }',
    '    }',
    '  }',
    '  $out = @($map.Values | Where-Object { $_.FileSystem } | ForEach-Object {',
    '    [pscustomobject]@{ id = $_.DeviceID; label = $_.VolumeName; size = $_.Size; fs = $_.FileSystem; type = $_.DriveType }',
    '  })',
    "  [Console]::Out.WriteLine('DRIVES ' + (ConvertTo-Json -InputObject $out -Compress -Depth 2))",
    '  [Console]::Out.Flush()',
    '  Start-Sleep -Seconds ' + POLL_SECONDS,
    '}'
  ].join('\n');
}

function parseDrivesLine(line) {
  const m = /^DRIVES\s+(.*)$/.exec(String(line || '').trim());
  if (!m) return null;
  let list;
  try { list = JSON.parse(m[1]); } catch (_) { return null; }
  if (list && !Array.isArray(list)) list = [list];
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const d of list) {
    const id = d && typeof d.id === 'string' ? d.id.trim().toUpperCase() : '';
    if (!/^[A-Z]:$/.test(id)) continue;
    out.push({
      id: id,
      root: id + '\\',
      label: cleanLabel(d.label),
      size: Number(d.size) > 0 ? Number(d.size) : null,
      fs: cleanLabel(d.fs),
      bus: Number(d.type) === 2 ? 'removable' : 'usb-disk'
    });
  }
  return out;
}

// Default drive source: one long-lived PowerShell process (cheaper than
// spawning one every few seconds). Restarted if it dies while running. The
// script is written as a plain .ps1 file in the app's own data folder and run
// with -File (an encoded command line tends to trip antivirus heuristics).
function powershellDriveSource(scriptDir) {
  let child = null;
  let stopped = true;
  let restartTimer = null;
  return {
    start(onList, onError) {
      stopped = false;
      const launch = () => {
        if (stopped) return;
        try {
          const dir = scriptDir || require('os').tmpdir();
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, 'timehub-drives.ps1');
          fs.writeFileSync(file, powershellScript(process.pid), 'utf8');
          child = spawn('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
            // cwd: the data folder, never the install folder, so this helper
            // cannot hold the install folder open during an upgrade.
            { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (err) {
          if (onError) onError(err);
          restartTimer = setTimeout(launch, 30000);
          return;
        }
        let buf = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            const list = parseDrivesLine(line);
            if (list) onList(list);
          }
          if (buf.length > 65536) buf = '';
        });
        child.on('error', (err) => { if (onError) onError(err); });
        child.on('exit', () => {
          child = null;
          if (!stopped) restartTimer = setTimeout(launch, 10000);
        });
      };
      launch();
    },
    stop() {
      stopped = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (child) { try { child.kill(); } catch (_) {} child = null; }
    }
  };
}

class DeviceMonitor extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.source = o.source || powershellDriveSource(o.scriptDir);
    this.settleMs = o.settleMs != null ? o.settleMs : SETTLE_MS;
    this.now = o.now || (() => Date.now());
    this.freshSlackMs = o.freshSlackMs != null ? o.freshSlackMs : FRESH_SLACK_MS;
    this.watched = new Map(); // drive id -> state
    // Extra folders to watch for new files, e.g. the person's Downloads
    // folder: [{ root, label }]. New files there are reported as
    // file_downloaded (whatever browser or app saved them).
    this.folders = Array.isArray(o.folders) ? o.folders.filter((f) => f && f.root) : [];
    this.folderStates = [];
    this.running = false;
    this.firstList = true;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.firstList = true;
    for (const f of this.folders) {
      this.folderStates.push(this._watch({ id: null, root: f.root, label: f.label || 'Folder' }, 'file_downloaded'));
    }
    this.source.start((list) => this._onDrives(list), (err) => this.emit('error', err));
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    try { this.source.stop(); } catch (_) {}
    for (const state of this.watched.values()) this._unwatch(state);
    this.watched.clear();
    for (const state of this.folderStates) this._unwatch(state);
    this.folderStates = [];
  }

  drives() {
    return Array.from(this.watched.values()).map((s) => Object.assign({}, s.drive));
  }

  _emit(ev) {
    this.emit('event', Object.assign({ occurred_at: new Date(this.now()).toISOString() }, ev));
  }

  _driveFields(drive) {
    return { drive_letter: drive.id, drive_label: drive.label };
  }

  _onDrives(list) {
    if (!this.running) return;
    const initial = this.firstList;
    this.firstList = false;
    const ids = new Set();
    for (const drive of list) {
      ids.add(drive.id);
      if (this.watched.has(drive.id)) continue;
      const state = this._watch(drive);
      this.watched.set(drive.id, state);
      this._emit(Object.assign({ kind: 'usb_connected' }, this._driveFields(drive), {
        size_bytes: drive.size,
        details: { file_system: drive.fs, bus: drive.bus, already_connected: initial, watching: !!state.watcher }
      }));
    }
    for (const [id, state] of Array.from(this.watched.entries())) {
      if (ids.has(id)) continue;
      this._unwatch(state);
      this.watched.delete(id);
      this._emit(Object.assign({ kind: 'usb_removed' }, this._driveFields(state.drive), {
        details: { files_seen: state.count }
      }));
    }
  }

  _watch(drive, fileKind) {
    const state = {
      drive: drive,
      fileKind: fileKind || 'file_copied',
      active: true,
      mountedAt: this.now(),
      watcher: null,
      pending: new Map(),
      seen: new Map(),
      count: 0
    };
    try {
      state.watcher = fs.watch(drive.root, { recursive: true, persistent: false }, (_evt, filename) => {
        this._onFsEvent(state, filename);
      });
      state.watcher.on('error', () => {
        // Usually the drive was pulled. The next drive poll reports removal.
        if (state.watcher) { try { state.watcher.close(); } catch (_) {} state.watcher = null; }
      });
    } catch (err) {
      state.watcher = null;
      this.emit('error', err);
    }
    return state;
  }

  _unwatch(state) {
    state.active = false;
    if (state.watcher) { try { state.watcher.close(); } catch (_) {} state.watcher = null; }
    for (const t of state.pending.values()) clearTimeout(t);
    state.pending.clear();
  }

  _onFsEvent(state, filename) {
    if (!filename || !state.watcher) return;
    const rel = String(filename);
    if (shouldIgnore(rel)) return;
    const prev = state.pending.get(rel);
    if (prev) clearTimeout(prev);
    else if (state.pending.size >= MAX_PENDING) return;
    // Large copies fire many change events; wait until writes stop.
    state.pending.set(rel, setTimeout(() => {
      state.pending.delete(rel);
      this._settle(state, rel);
    }, this.settleMs));
  }

  _settle(state, rel) {
    if (!this.running || !state.active) return;
    fs.stat(path.join(state.drive.root, rel), (err, st) => {
      if (err || !st || !st.isFile()) return;
      if (!state.active) return;
      // Only files created or written since we started watching. Reading a
      // file that was already on the drive also fires events (access time);
      // those are ignored. Explorer copies keep the source's modified time
      // but get a new created time, so check both.
      const touched = Math.max(st.birthtimeMs || 0, st.mtimeMs || 0);
      if (touched < state.mountedAt - this.freshSlackMs) return;
      const key = rel.toLowerCase();
      const sig = st.size + ':' + Math.round(st.mtimeMs || 0);
      if (state.seen.get(key) === sig) return;
      if (state.seen.size >= MAX_SEEN) state.seen.clear();
      state.seen.set(key, sig);
      state.count++;
      const name = path.basename(rel);
      const depth = rel.split(/[\\/]+/).filter(Boolean).length - 1;
      this._emit(Object.assign({ kind: state.fileKind }, this._driveFields(state.drive), {
        file_name: name.slice(0, 255),
        file_ext: extOf(name),
        size_bytes: st.size,
        details: { folder_depth: depth }
      }));
    });
  }
}

module.exports = { DeviceMonitor, shouldIgnore, extOf, parseDrivesLine, powershellScript };
