; TimeHub NSIS customisation (picked up by electron-builder via nsis.include).
;
; Replaces electron-builder 24's "is the app running?" check, which is broken
; for per-user installs: it runs `%SYSTEMROOT%\System32\cmd.exe ...` through
; nsExec, nsExec does not expand %SYSTEMROOT%, the command fails to start and
; the failure is read as "not running". The installer then never closes
; TimeHub, the old version's uninstaller cannot remove the locked TimeHub.exe,
; and after five tries the user sees "TimeHub cannot be closed. Please close it
; manually and click Retry to continue."
;
; This version uses $SYSDIR (expanded by NSIS itself), then closes TimeHub
; without asking:
;   1. if the installed copy is 1.3.1 or later, asks it to quit cleanly
;      (TimeHub.exe --timehub-quit, handled through its single-instance lock)
;      and waits up to ~5 s; older copies skip this step,
;   2. force-kills every TimeHub.exe of this user with its child processes
;      (taskkill /F /T), which also ends the device-monitor PowerShell helper,
;   3. only if that still fails (e.g. TimeHub was started "as administrator")
;      shows the Retry / Cancel message.
; It is used by both the installer and the uninstaller.

!macro timehubFindApp _RESULT
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO csv | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}"`
  !else
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO csv | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}"`
  !endif
  Pop ${_RESULT} ; "0" = running; "1" = not running; "error" = could not check
!macroend

; No USERNAME filter here: taskkill hangs when /T is combined with /FI
; "USERNAME eq ..." (seen on Windows 11). Without admin rights it can only end
; this user's processes anyway.
!macro timehubKillApp
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $R9
!macroend

!macro customCheckAppRunning

  !insertmacro timehubFindApp $R0
  ${if} $R0 == 0
    DetailPrint `Closing "${PRODUCT_NAME}"...`

    ; $R2 = 1 when it is worth waiting for a clean exit.
    StrCpy $R2 0
    ${if} ${isUpdated}
      ; An auto-update already asked the app to quit; give it a moment.
      StrCpy $R2 1
    ${elseIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ; Ask it to quit cleanly, but only if the installed copy is 1.3.1+.
      ; Older copies do not know --timehub-quit and would just pop their
      ; window up, so they go straight to the force-close below. Only run
      ; while TimeHub is running, so this never starts TimeHub by itself.
      ClearErrors
      GetDllVersion "$INSTDIR\${APP_EXECUTABLE_FILENAME}" $R3 $R4
      ${ifNot} ${Errors}
        IntOp $R5 $R3 >> 16          ; major
        IntOp $R6 $R3 & 0xFFFF       ; minor
        IntOp $R7 $R4 >> 16          ; patch
        IntOp $R5 $R5 * 1000000
        IntOp $R6 $R6 * 1000
        IntOp $R5 $R5 + $R6
        IntOp $R5 $R5 + $R7
        ${if} $R5 >= 1003001
          Exec `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --timehub-quit`
          StrCpy $R2 1
        ${endIf}
      ${endIf}
    ${endIf}

    ; Wait up to ~5 s for a clean exit.
    ${if} $R2 == 1
      StrCpy $R1 0
      timehubWaitLoop:
        Sleep 500
        !insertmacro timehubFindApp $R0
        ${if} $R0 != 0
          Goto timehubClosed
        ${endIf}
        IntOp $R1 $R1 + 1
        IntCmp $R1 5 0 timehubWaitLoop 0
    ${endIf}

    ; Still running: force it, with its child processes.
    StrCpy $R1 0
    timehubKillLoop:
      IntOp $R1 $R1 + 1
      !insertmacro timehubKillApp
      Sleep 1000
      !insertmacro timehubFindApp $R0
      ${if} $R0 != 0
        Goto timehubClosed
      ${endIf}
      ${if} $R1 < 3
        Goto timehubKillLoop
      ${endIf}
      ; Most likely running elevated. Silent installs give up (no prompt).
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY timehubRetry
      Quit
    timehubRetry:
      StrCpy $R1 0
      Goto timehubKillLoop

    timehubClosed:
      ; Let Windows release file handles before files are replaced.
      Sleep 500
  ${endIf}
!macroend
