# TimeHub Desktop

Windows shell for [https://app.timehub.company](https://app.timehub.company). Version **1.2.1** (`package.json`). The web app owns sign-in, consent, billing, and product logic. This repo is the Electron window, tray, native idle signal, consent-gated screen-capture IPC, and auto-update. It does not contain the web app.

## Install

Per-user NSIS installer (not a machine-wide MSI). This is the IT and direct-download build. The Microsoft Store package is separate; see [Microsoft Store](#microsoft-store). Do not install both on the same Windows user.

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

On a packaged NSIS build, the first launch that was **not** itself started by the login item turns on “start when the user signs in”, hidden. The tray checkbox reads and writes the same Windows login item (`openAtLogin`, `openAsHidden`).

That first-launch path runs again on later manual starts. Unchecking the tray item applies immediately, and a later manual start turns it back on. IT does not need a logon script or a Run-key deployment for the default “open at login” behavior.

The Store build does not use that Run key. It starts at login through a Windows StartupTask. See [Microsoft Store](#microsoft-store).

Closing the window hides it to the tray. Quit is on the tray menu. A second launch focuses the existing window.

## Auto-update

Packaged NSIS builds only. `npm start` does not check. Microsoft Store builds do not check either: `process.windowsStore` skips electron-updater, and the tray hides **Check for updates** and **Restart to update**. The Store ships those updates.

- Provider: GitHub Releases for `jic52194/timehub-desktop` (electron-updater).
- On startup, then every 6 hours, the shell reads `latest.yml` from the latest release and downloads in the background.
- The download installs on the next quit (`autoInstallOnAppQuit`). The tray tooltip says when an update is ready, and the menu gains **Restart to update** (silent install, then relaunch).
- Failures are no longer dropped. The shell appends them to `updater.log` in the app user-data directory (`%APPDATA%\timehub-desktop\updater.log` on Windows), sets the tray tooltip, and tells the page (see below). Query strings and GitHub token-shaped strings are stripped from the message that reaches the page.
- A later successful “no update” clears an error tooltip. If a download is already staged, a failed re-check leaves the tooltip on “update ready”.

Publish a release by bumping `package.json` and pushing a tag that matches it (`v1.2.1` for version `1.2.1`). [`.github/workflows/release.yml`](.github/workflows/release.yml) builds `TimeHub-Setup.exe`, `latest.yml`, and `TimeHub-<version>.appx` with `GITHUB_TOKEN`. `latest.yml` is only the NSIS feed. `workflow_dispatch` publishes whatever version is on the branch you run it from. Pull-request CI builds both packages with `--publish never` and does not create a release. The Store listing does not update itself from that GitHub release; upload the `.appx` in Partner Center.

## What the web app can call

The page sees `window.timehubNative` only inside this shell (`contextIsolation` is on; the page cannot use `ipcRenderer` directly).

| Member | Contract |
| --- | --- |
| `isDesktop` | `true` |
| `platform` | Node `process.platform` (`win32` on the shipped build) |
| `windowsStore` | `true` when this process is the Microsoft Store / MSIX package. `false` for NSIS and for `npm start`. The page can hide its own update UI when this is `true`. |
| `appVersion` | String from `app.getVersion()` via synchronous IPC `timehub:get-version`. Same value as `package.json` for this build, and the same string the tray shows. Read this for heartbeats. It is not a literal in `preload.js`. |
| `getIdleSeconds()` / `getIdle()` / `onIdle(cb)` | Machine idle from `powerMonitor`. Also dispatched as `timehub-native-idle`. |
| `monitoringSupported` | `true`. The shell can capture when asked. |
| `captureScreen(opts)` | One primary-screen JPEG, base64 with no `data:` prefix, or `null`. Called only by the page. |
| `setLiveViewBorder(on)` | Show or hide the “screen is being viewed” border. |
| `getUpdateState()` | `{ status: "idle" \| "ready" \| "error", version: string \| null, message: string \| null }` |
| `onUpdateReady(cb)` | `cb({ version })` when a download is ready. Replays immediately if one is already ready. Returns an unsubscribe function. |
| `onUpdateError(cb)` | `cb({ message })` when a check or download fails. Replays if the latest status is still an error. Returns an unsubscribe function. |
| `restartToUpdate()` | Promise. Resolves `true` when a download is staged and quit-and-install was requested. Resolves `false` in dev or before a download. A following update error means the installer did not start. |

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

The Store `.appx` is never signed with `CSC_LINK`. `scripts/sign-windows.js` returns without signing `*.appx`, then NSIS files still go through electron-builder's signer when a certificate is present. Partner Center re-signs the package. A certificate whose subject is not the Partner Center publisher would make a signed Store package fail submission, so the artifact is left unsigned on purpose. `CSC_LINK` is not required to produce it.

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

`npm run dist` writes an unsigned `dist/TimeHub-Setup.exe` and an unsigned `dist/TimeHub-<version>.appx` (`--publish never`). `npm run smoke` syntax-checks the shell and, on Windows or any machine with a display, launches Electron to assert `window.timehubNative.appVersion` equals `app.getVersion()`.

Icons live in `build/icon.ico` (installer, exe, tray) and `build/icon.png`. They are listed in `build.files` after `node_modules/**/*` and unpacked from the asar. electron-builder otherwise excludes its `build/` resource directory from the packaged app, which would leave the tray with no icon. Store tiles live in `build/appx/` and are packaging assets only. Regenerate with `python3 scripts/make-icon.py` (needs Pillow) and commit the icon files and the tiles.

CI is [`.github/workflows/ci.yml`](.github/workflows/ci.yml): on pull requests and on `main`, `windows-latest` runs `npm ci`, `npm run smoke`, and `npm run dist`. It uploads the exe and the appx as workflow artifacts. It does not publish and does not receive signing secrets.

## Microsoft Store

Company Partner Center account: [https://storedeveloper.microsoft.com](https://storedeveloper.microsoft.com). Confirm the one-time company fee at signup (it has been about $99) and finish business verification before the first submission. This path is in addition to the NSIS installer. Keep NSIS for IT and for anyone who should keep GitHub auto-update. A user who installs both gets two apps; uninstall the NSIS copy before using the Store app, or leave NSIS as the only IT deployment.

`npm run dist` adds an `appx` target next to NSIS. The file is `dist/TimeHub-<version>.appx`. Partner Center accepts that APPX package as the MSIX submission. `latest.yml` does not list it.

### Product identity

The upload is rejected unless these three strings match Partner Center → Product identity exactly. After the company account is verified, reserve the name **TimeHub** (if it is taken, reserve a fallback such as **TimeHub by MindTech**), then paste the values over the `PLACEHOLDER` strings.

| Partner Center field | Where to paste it | Optional env override |
| --- | --- | --- |
| Package / Identity / Name | `package.json` `build.appx.identityName` | `TIMEHUB_APPX_IDENTITY_NAME` |
| Package / Identity / Publisher | `package.json` `build.appx.publisher` | `TIMEHUB_APPX_PUBLISHER` |
| Package / Properties / Publisher display name | `package.json` `build.appx.publisherDisplayName` | `TIMEHUB_APPX_PUBLISHER_DISPLAY_NAME` |

`build.appx.publisher` is the full `CN=...` value, not the display name. Do not invent a GUID. `npm run dist` and `npm run publish` load [`electron-builder.config.js`](electron-builder.config.js), which uses the env vars when they are non-empty and otherwise the `package.json` strings. The comments in that file name the same three fields. `build.appx.applicationId` stays `TimeHub` even when the identity name starts with a digit.

### Listing and certification

The privacy policy URL is required on the Partner Center listing, because the app handles personal data, idle time, and screenshots. The policy has to cover screenshots and idle data. This repo does not host that policy. Put the URL on the listing.

Also needed on the listing: an IARC age rating (a productivity app is often 3+ / Everyone), at least one screenshot, category Productivity or Business, a support contact, price, and markets.

Notes for certification, for the “Notes for certification” box:

- TimeHub is a Windows desktop shell with native behavior, not a website wrapper. It reports whole-computer idle through `powerMonitor`, keeps a tray icon, captures the screen only through `desktopCapturer` when the page asks, and starts at login through a `windows.startupTask` extension.
- Screen monitoring and idle are employer-managed and consent-based. The shell does not upload. The signed-in web app asks for a capture only after the company has monitoring on, the person has accepted the notice, and they are clocked in.
- `runFullTrust` is the desktop-bridge capability those Win32 features need. It is a restricted capability; the justification is the paragraph above.
- Provide a test account for [https://app.timehub.company](https://app.timehub.company).

Certification often takes 1–3 business days.

### Store updates and start at login

Each release still has to be uploaded to Partner Center. The GitHub release attaches `TimeHub-<version>.appx` next to `TimeHub-Setup.exe` so that file is easy to find. The shell on a Store install does not call electron-updater. `window.timehubNative.windowsStore` is `true` there.

Start at login stays on for the Store build. [`build/appx-startup-task.xml`](build/appx-startup-task.xml) declares StartupTask `TimeHub` with `Enabled=true`, which is what makes a packaged desktop app open at login. The tray checkbox reads and changes that task. It does not call `app.setLoginItemSettings` on a Store install. If Windows reports the task as disabled by the user or by policy, only Settings → Apps → Startup can turn it back on. A later manual start does not force it back on.

Tiles are generated from `build/icon.png` into `build/appx/` (`StoreLogo.png`, `Square44x44Logo.png`, `Square150x150Logo.png`, `Wide310x150Logo.png`, plus the large tile, small tile, badge, and splash).

## Not in this repo

- macOS / Linux installers, Apple notarization
- The web app, Stripe, Supabase
- A purchased Authenticode certificate or Azure Trusted Signing account
- Crash reporting. A Sentry (or similar) DSN is not configured; add it later from the environment rather than a half-set-up SDK
