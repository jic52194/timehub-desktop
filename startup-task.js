// Microsoft Store / MSIX start-at-login.
//
// app.setLoginItemSettings writes a Run key. That key does not start an
// AppX/MSIX package. The Store build declares a windows.startupTask extension
// (build/appx-startup-task.xml) with Enabled="true", which is enough for a
// packaged desktop app to open at login. This module only toggles that task
// from the tray. TaskId must match the manifest.

const { spawn } = require('child_process');

const TASK_ID = 'TimeHub';
const STATE_BY_CODE = {
  0: 'disabled',
  1: 'disabledByUser',
  2: 'enabled',
  3: 'disabledByPolicy',
  4: 'enabledByPolicy'
};

function isOpenAtLoginState(state) {
  return state === 'enabled' || state === 'enabledByPolicy';
}

function parseState(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\d+$/.test(lines[i]) && STATE_BY_CODE[Number(lines[i])]) {
      return STATE_BY_CODE[Number(lines[i])];
    }
  }
  return null;
}

function powershellScript(action) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Windows.ApplicationModel.StartupTask,Windows.ApplicationModel,ContentType=WindowsRuntime] | Out-Null',
    "$task = [Windows.ApplicationModel.StartupTask]::GetAsync('" + TASK_ID + "').GetAwaiter().GetResult()"
  ];
  if (action === 'enable') {
    lines.push('$task.RequestEnableAsync().GetAwaiter().GetResult() | Out-Null');
    lines.push("$task = [Windows.ApplicationModel.StartupTask]::GetAsync('" + TASK_ID + "').GetAwaiter().GetResult()");
  } else if (action === 'disable') {
    lines.push('$task.Disable()');
    lines.push("$task = [Windows.ApplicationModel.StartupTask]::GetAsync('" + TASK_ID + "').GetAwaiter().GetResult()");
  } else if (action !== 'get') {
    throw new Error('unknown StartupTask action: ' + action);
  }
  lines.push('Write-Output ([int]$task.State)');
  return lines.join('\n');
}

// Calls back with (err, state). state is one of STATE_BY_CODE, or null.
// Must run inside the packaged app: a child of an MSIX process keeps the
// package identity, so StartupTask.GetAsync sees this package's task.
function runStartupTask(action, cb) {
  let script;
  try {
    script = powershellScript(action);
  } catch (err) {
    cb(err, null);
    return;
  }
  if (process.platform !== 'win32') {
    cb(new Error('StartupTask requires Windows'), null);
    return;
  }
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', script
  ], { windowsHide: true });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = (err, state) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cb(err, state);
  };
  const timer = setTimeout(() => {
    try { child.kill(); } catch (_) {}
    finish(new Error('StartupTask powershell timed out'), parseState(stdout));
  }, 20000);
  child.stdout.on('data', (buf) => { stdout += buf.toString('utf8'); });
  child.stderr.on('data', (buf) => { stderr += buf.toString('utf8'); });
  child.on('error', (err) => finish(err, null));
  child.on('close', (code) => {
    const state = parseState(stdout);
    if (code !== 0 || !state) {
      const detail = (stderr || stdout || ('powershell exited ' + code)).replace(/\s+/g, ' ').trim().slice(0, 400);
      finish(new Error(detail || 'StartupTask failed'), state);
      return;
    }
    finish(null, state);
  });
}

module.exports = {
  TASK_ID,
  isOpenAtLoginState,
  parseState,
  powershellScript,
  runStartupTask
};
