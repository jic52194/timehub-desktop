# TimeHub Desktop

Windows shell for [https://app.timehub.company](https://app.timehub.company). Version **1.3.1** (`package.json`). The web app owns sign-in, consent, billing, and product logic. This repo is the Electron window, tray, native idle signal, consent-gated screen-capture IPC, and auto-update. It does not contain the web app.

## Install

Per-user NSIS installer (not a machine-wide MSI):

[https://github.com/jic52194/timehub-desktop/releases/latest/download/TimeHub-Setup.exe](https://github.com/jic52194/timehub-desktop/releases/latest/download/TimeHub-Setup.exe)

[All releases](https://github.com/jic52194/timehub-desktop/releases)

- `perMachine` is false. Each person installs into their own profile. The default directory is `%LOCALAPPDATA%\Programs\TimeHub`. The installer lets them change it.
- A desktop shortcut named TimeHub is created.
- The shell is 64-bit Windows only.

Until a code-signing certificate is configured, SmartScreen may warn on first launch. That is expected for an unsigned installer. See [Code signing](#code-signing).

## Point the shell at another host

`TIMEHUB_URL` replaces the loaded origin. The default is `https://app.timehub.company`. No rebuild.

A terminal session variable applies only to a process started from that terminal. Open-at-login does not see it. For a lasting override, set a user environment variable, then sign out and back in (or restart the app after the next login):

```powershell
setx TIMEHUB_URL "https://staging.example.company"
```

One-shot, if you know the install directory:

```powershell
$env:TIMEHUB_URL = "https://staging.example.company"
& "$env:LOCALAPPDATA\Programs\TimeHub\TimeHub.exe"
```

The value must be an origin the web app can load (including `https://`). Links that are not on that origin open in the system browser. `supabase.co` navigations from the page are left inside the window so sign-in can finish.

## Open at login

On a packaged build, the first launch that was **not** itself started by the login item turns on “start when the user signs in”, hidden. The tray checkbox reads and writes the same Windows login item (`openAtLogin`, `openAsHidden`).

That first-launch path runs again on later manual starts. Unchecking the tray item applies immediately, and a later manual start turns it back on. IT does not need a logon script or a Run-key deployment for the default “open at login” behavior.

Closing the window hides it to the tray. Quit is on the tray menu. A second launch focuses the existing window.

Installing over a running copy closes it automatically ([`build/installer.nsh`](build/installer.nsh)). The installer runs `TimeHub.exe --timehub-quit`, which tells the running copy (1.3.1+) to quit cleanly through the single-instance lock. After 5 seconds it runs `taskkill /F /T` on this user's `TimeHub.exe` processes. It shows "TimeHub cannot be closed … Retry" only if that also fails, for example when TimeHub was started as administrator. electron-builder 24's own check is replaced because it never ran for per-user installs: it starts its `tasklist` command with `%SYSTEMROOT%`, which `nsExec` does not expand.

## Auto-update

Packaged builds only. `npm start` does not check.

- Provider: GitHub Releases for `jic52194/timehub-desktop` (electron-updater).
- On startup, then every hour, the shell reads `latest.yml` from the latest release and downloads in the background.
- The download installs by itself once the screen is locked or the computer has been idle for 10 minutes (silent install, then relaunch), or on the next quit (`autoInstallOnAppQuit`). The tray tooltip says when an update is ready, and the menu gains **Restart to update** (silent install, then relaunch).
- Failures are no longer dropped. The shell appends them to `updater.log` in the app user-data directory (`%APPDATA%\timehub-desktop\updater.log` on Windows), sets the tray tooltip, and tells the page (see below). Query strings and GitHub token-shaped strings are stripped from the message that reaches the page.
- A later successful “no update” clears an error tooltip. If a download is already staged, a failed re-check leaves the tooltip on “update ready”.

### Staying up (1.3.2+)

- If TimeHub can't be reached (no internet, DNS, server error 5xx), the window shows a "Reconnecting to TimeHub" screen instead of a blank page and retries after 5 s, doubling to at most 60 s. It also retries at once when the network comes back or the computer wakes.
- A crashed page reloads itself; a page frozen for 30 s is reloaded.

Publish a release by bumping `package.json` and pushing a tag that matches it (`v1.2.1` for version `1.2.1`). [`.github/workflows/release.yml`](.github/workflows/release.yml) builds `TimeHub-Setup.exe` and `latest.yml` with `GITHUB_TOKEN`. `workflow_dispatch` publishes whatever version is on the branch you run it from. Pull-request CI builds the installer with `--publish never` and does not create a release.

## What the web app can call

The page sees `window.timehubNative` only inside this shell (`contextIsolation` is on; the page cannot use `ipcRenderer` directly).

| Member | Contract |
| --- | --- |
| `isDesktop` | `true` |
| `platform` | Node `process.platform` (`win32` on the shipped build) |
| `appVersion` | String from `app.getVersion()` via synchronous IPC `timehub:get-version`. Same value as `package.json` for this build, and the same string the tray shows. Read this for heartbeats. It is not a literal in `preload.js`. |
| `getIdleSeconds()` / `getIdle()` / `onIdle(cb)` | Machine idle from `powerMonitor`. Also dispatched as `timehub-native-idle`. |
| `monitoringSupported` | `true`. The shell can capture when asked. |
| `captureScreen(opts)` | One primary-screen JPEG, base64 with no `data:` prefix, or `null`. Called only by the page. |
| `setLiveViewBorder(on)` | Show or hide the “screen is being viewed” border. |
| `getUpdateState()` | `{ status: "idle" \| "ready" \| "error", version: string \| null, message: string \| null }` |
| `onUpdateReady(cb)` | `cb({ version })` when a download is ready. Replays immediately if one is already ready. Returns an unsubscribe function. |
| `onUpdateError(cb)` | `cb({ message })` when a check or download fails. Replays if the latest status is still an error. Returns an unsubscribe function. |
| `restartToUpdate()` | Promise. Resolves `true` when a download is staged and quit-and-install was requested. Resolves `false` in dev or before a download. A following update error means the installer did not start. |
| `deviceMonitoringSupported` | v1.3.0+. `true` on Windows. |
| `setDeviceMonitoring(on)` | v1.3.0+. Turns USB / Downloads logging on or off (off by default). Resolves `{ ok, active, reason? }`. Only the main TimeHub window may call it. |
| `onDeviceEvent(cb)` | v1.3.0+. `cb(event)` per event; events that arrive before the page subscribes are held and replayed. Returns an unsubscribe function. See below. |
| `getRemovableDrives()` | v1.3.0+. Drives being watched now: `[{ id, label, size, fs, bus }]`. |

DOM events (live only; they do not replay — use the methods above after a late mount):

- `timehub-update-ready` — `event.detail` is `{ version }`
- `timehub-update-error` — `event.detail` is `{ message }`

After a full page load the shell re-sends the latest update event, so a reload does not forget a staged update.

Example the web app can adopt. This repository does not ship that UI:

```javascript
if (window.timehubNative && window.timehubNative.onUpdateReady) {
  window.timehubNative.onUpdateReady(function (detail) {
    // show "Restart to update" for detail.version
  });
}
function onRestartClick() {
  window.timehubNative.restartToUpdate();
}
```

The tray item is the path that works before that UI exists. Quitting the app also installs a staged update.

## Consent model

The shell does not decide whether monitoring is allowed.

- Idle time is reported whenever the desktop app is running. It is not a screenshot.
- A screenshot is taken only when the page calls `captureScreen`. The page is responsible for the company setting, the notice the person accepted, and the clocked-in state.
- The border is shown only when the page calls `setLiveViewBorder(true)`.
- Bytes stay on the machine until the web app uploads them with the signed-in session. This repo has no Supabase keys and no upload code.
- USB / Downloads logging (v1.3.0) runs only after the page calls `setDeviceMonitoring(true)`. The page does that only when monitoring is enabled and the person accepted the current notice, and turns it off when that stops being true or they sign out.

## USB drive and download logging (v1.3.0)

`device-monitor.js`, Windows only. While switched on:

- A small PowerShell loop (`timehub-drives.ps1` in the app's data folder, run with `-File`) lists removable drives (`Win32_LogicalDisk DriveType=2`) and volumes on USB-attached disks every 4 seconds. It exits by itself if TimeHub is gone.
- Each drive is watched with `fs.watch` (recursive). A file created or written after the drive appeared is reported once its writes settle. Reading files that were already on the drive is not reported. System files (`System Volume Information`, `$RECYCLE.BIN`, `~$` lock files, `.tmp`) are skipped.
- The person's Downloads folder is watched the same way, so a file saved by any browser or app is reported once the download finishes (`.crdownload` / `.part` files are skipped).

Events: `{ kind, drive_letter, drive_label, file_name, file_ext, size_bytes, occurred_at, details }`, where `kind` is `usb_connected`, `usb_removed`, `file_copied` (written to a USB drive) or `file_downloaded`. File names, types and sizes only. The module never opens a file for reading; `npm run smoke` checks that.

Known gaps: a USB drive that Windows reports as a SCSI/NVMe disk is missed, and so are phones (MTP) and network shares. Files saved somewhere other than Downloads aren't reported as downloads. Blocking USB storage is a Windows policy job; see `docs/usb-blocking.md` in the web app repo.

## Code signing

Local `npm run dist` and pull-request CI stay unsigned. No certificate is in this repo. Do not commit a `.pfx`, `.p12`, or password.

electron-builder **24.13.3** (this repo) signs the Windows build when `CSC_LINK` is a non-empty certificate. `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` are the Windows-specific aliases if you ever cross-compile.

| Secret | Purpose |
| --- | --- |
| `CSC_LINK` | Base64 of the `.pfx` (no `data:` prefix), or an `https://` URL, or a file path the runner can read |
| `CSC_KEY_PASSWORD` | Password for that certificate |

Base64 for the secret, from the machine that holds the cert (do not paste the output into git):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("codesign.pfx"))
```

The release workflow copies those secrets onto `CSC_LINK` / `CSC_KEY_PASSWORD` only when `CSC_LINK` is non-empty. An empty GitHub secret must not be passed through: electron-builder 24 treats `CSC_LINK=""` as a path and fails the build. When the secret is absent, the job logs a TODO and still publishes an unsigned installer.

Azure Trusted Signing env vars, when you have an account:

| Secret | Purpose |
| --- | --- |
| `AZURE_TENANT_ID` | Entra tenant id |
| `AZURE_CLIENT_ID` | App registration client id |
| `AZURE_CLIENT_SECRET` | App registration secret **value** |

**TODO(Jared):** electron-builder 24.13.3 does not sign with Azure. Those secrets are accepted by the workflow and produce a warning only. Signing with Azure also needs a builder upgrade (Azure support landed in 25.1.6) and non-secret `win` config this repo deliberately does not invent:

```json
"azureSignOptions": {
  "publisherName": "CN=...",
  "endpoint": "https://<region>.codesigning.azure.net/",
  "certificateProfileName": "...",
  "codeSigningAccountName": "..."
}
```

`publisherName` must match the certificate subject. Do not commit placeholder account names into `package.json`; an incomplete Azure block is worse than an unsigned build. Unsigned `npm run dist` must keep working.

## Develop and package

```powershell
npm ci
npm start
npm run smoke
npm run dist
```

`npm run dist` writes an unsigned `dist/TimeHub-Setup.exe` (`--publish never`). `npm run smoke` syntax-checks the shell and, on Windows or any machine with a display, launches Electron to assert `window.timehubNative.appVersion` equals `app.getVersion()`.

Icons live in `build/icon.ico` (installer, exe, tray) and `build/icon.png`. They are listed in `build.files` after `node_modules/**/*` and unpacked from the asar. electron-builder otherwise excludes its `build/` resource directory from the packaged app, which would leave the tray with no icon. Regenerate with `python3 scripts/make-icon.py` (needs Pillow) and commit both files.

CI is [`.github/workflows/ci.yml`](.github/workflows/ci.yml): on pull requests and on `main`, `windows-latest` runs `npm ci`, `npm run smoke`, and `npm run dist`. It does not publish and does not receive signing secrets.

## Not in this repo

- macOS / Linux installers, Apple notarization
- The web app, Stripe, Supabase
- A purchased Authenticode certificate or Azure Trusted Signing account
- Crash reporting. A Sentry (or similar) DSN is not configured; add it later from the environment rather than a half-set-up SDK
