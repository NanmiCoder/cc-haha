!include "LogicLib.nsh"
!include "getProcessInfo.nsh"
!include "${BUILD_RESOURCES_DIR}\check-install-processes.nsh"
!define /ifndef INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!define /ifndef UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
Var pid
Var ccHahaProcessDiagnostic
Var ccHahaProcessHelperWriteBlocked

!ifndef BUILD_UNINSTALLER
Var ccHahaRecoveryDone
Var ccHahaPerUserInstallLocation
Var ccHahaPerMachineInstallLocation
Var ccHahaPerUserUninstallString
Var ccHahaPerMachineUninstallString

Function CcHahaUninstallerParent
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  StrCpy $R2 0

  cc_haha_uninstall_parent_find_first_quote:
    StrCpy $R1 $R0 1 $R2
    StrCmp $R1 "" cc_haha_uninstall_parent_invalid
    StrCmp $R1 '"' cc_haha_uninstall_parent_after_first_quote
    IntOp $R2 $R2 + 1
    Goto cc_haha_uninstall_parent_find_first_quote

  cc_haha_uninstall_parent_after_first_quote:
    IntOp $R2 $R2 + 1
    StrCpy $R0 $R0 "" $R2
    StrCpy $R2 0

  cc_haha_uninstall_parent_find_second_quote:
    StrCpy $R1 $R0 1 $R2
    StrCmp $R1 "" cc_haha_uninstall_parent_invalid
    StrCmp $R1 '"' cc_haha_uninstall_parent_have_file
    IntOp $R2 $R2 + 1
    Goto cc_haha_uninstall_parent_find_second_quote

  cc_haha_uninstall_parent_have_file:
    StrCpy $R0 $R0 $R2
    StrLen $R2 $R0

  cc_haha_uninstall_parent_find_slash:
    IntOp $R2 $R2 - 1
    IntCmp $R2 0 cc_haha_uninstall_parent_invalid 0 0
    StrCpy $R1 $R0 1 $R2
    StrCmp $R1 "\" cc_haha_uninstall_parent_done
    Goto cc_haha_uninstall_parent_find_slash

  cc_haha_uninstall_parent_invalid:
    StrCpy $R0 ""
    Goto cc_haha_uninstall_parent_done

  cc_haha_uninstall_parent_done:
    StrCpy $R0 $R0 $R2
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

Function CcHahaFinalInstallDir
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5

  StrCpy $R1 "${APP_FILENAME}"
  StrLen $R2 $R1
  StrLen $R3 $R0
  StrCpy $R4 0

  cc_haha_final_install_find_name:
    IntCmp $R4 $R3 cc_haha_final_install_append 0 cc_haha_final_install_append
    StrCpy $R5 $R0 $R2 $R4
    StrCmp $R5 $R1 cc_haha_final_install_done
    IntOp $R4 $R4 + 1
    Goto cc_haha_final_install_find_name

  cc_haha_final_install_append:
    StrCpy $R0 "$R0\${APP_FILENAME}"

  cc_haha_final_install_done:
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

Function CcHahaCanSkipLegacyRecovery
  Push $R3
  Push $R0
  Push $R1
  Push $R2

  StrCpy $R0 "0"
  ${If} $8 != "trusted-user"
    Goto cc_haha_skip_recovery_done
  ${EndIf}
  ${If} $ccHahaPerUserInstallLocation == ""
    Goto cc_haha_skip_recovery_done
  ${EndIf}
  ${If} $ccHahaPerMachineInstallLocation != ""
    Goto cc_haha_skip_recovery_done
  ${EndIf}
  ${If} $ccHahaPerMachineUninstallString != ""
    Goto cc_haha_skip_recovery_done
  ${EndIf}
  StrCmp $ccHahaPerUserInstallLocation $INSTDIR 0 cc_haha_skip_recovery_done

  ReadEnvStr $R1 APPDATA
  ${If} $R1 == ""
    Goto cc_haha_skip_recovery_done
  ${EndIf}
  ReadEnvStr $R0 CLAUDE_CONFIG_DIR
  ${If} $R0 != ""
    StrCpy $R0 "0"
    Goto cc_haha_skip_recovery_done
  ${EndIf}
  StrCpy $R0 "0"

  IfFileExists "$ccHahaPerUserInstallLocation\CLAUDE_CONFIG_DIR\*.*" cc_haha_skip_recovery_done 0
  IfFileExists "$R1\Claude Code Haha\app-mode.json" cc_haha_check_default_mode 0
  StrCpy $R0 "1"
  Goto cc_haha_skip_recovery_done

  cc_haha_check_default_mode:
    ClearErrors
    FileOpen $R2 "$R1\Claude Code Haha\app-mode.json" r
    IfErrors cc_haha_skip_recovery_done 0
    FileRead $R2 $R3
    StrCmp $R3 '{$\n' 0 cc_haha_close_mode_file
    FileRead $R2 $R3
    StrCmp $R3 '  "mode": "default",$\n' 0 cc_haha_close_mode_file
    FileRead $R2 $R3
    StrCmp $R3 '  "portable_dir": null$\n' 0 cc_haha_close_mode_file
    FileRead $R2 $R3
    StrCmp $R3 '}' 0 cc_haha_close_mode_file
    ClearErrors
    FileRead $R2 $R3
    IfErrors 0 cc_haha_close_mode_file
    StrCpy $R0 "1"

  cc_haha_close_mode_file:
    FileClose $R2

  cc_haha_skip_recovery_done:
    StrCpy $R3 $R0
    Pop $R2
    Pop $R1
    Pop $R0
    Exch $R3
FunctionEnd

Function CcHahaRecoverLegacy
  ReadRegStr $4 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $5 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R0 == ""
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    !endif
  ${EndIf}
  ${If} $4 == ""
  ${AndIf} $R0 != ""
    Push $R0
    Call CcHahaUninstallerParent
    Pop $4
  ${EndIf}
  ReadRegStr $R1 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R1 == ""
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ReadRegStr $R1 HKLM "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    !endif
  ${EndIf}
  ${If} $5 == ""
  ${AndIf} $R1 != ""
    Push $R1
    Call CcHahaUninstallerParent
    Pop $5
  ${EndIf}

  Push "$INSTDIR"
  Call CcHahaFinalInstallDir
  Pop $9

  ${If} $4 == ""
  ${AndIf} $5 == ""
    StrCpy $0 "0"
    StrCpy $1 "No registered installation needs legacy data recovery"
    DetailPrint "$1"
    Return
  ${EndIf}

  InitPluginsDir
  File /oname=$PLUGINSDIR\recover-legacy-install-data.ps1 "${BUILD_RESOURCES_DIR}\recover-legacy-install-data.ps1"

  ReadEnvStr $2 APPDATA
  ReadEnvStr $3 USERPROFILE
  ReadEnvStr $6 CLAUDE_CONFIG_DIR
  ReadEnvStr $7 CC_HAHA_APP_PORTABLE_DIR
  ${If} $2 == ""
    StrCpy $0 "21"
    StrCpy $1 "missing current-user APPDATA"
    Return
  ${EndIf}
  ${If} $3 == ""
    StrCpy $0 "21"
    StrCpy $1 "missing current-user USERPROFILE"
    Return
  ${EndIf}

  DetailPrint "Checking registered installations for legacy Claude Code Haha data..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\recover-legacy-install-data.ps1" -PerUserInstallDir "$4" -PerMachineInstallDir "$5" -CandidateInstallDir "$9" -UserDataDir "$2\Claude Code Haha" -RecoveryRoot "$3\Claude Code Haha Data\Recovered" -ProcessName "${PRODUCT_FILENAME}.exe" -ActiveConfigDir "$6" -ActiveConfigManaged "$7" -InstallerIdentitySafety "$8"'
  Pop $0
  Pop $1
FunctionEnd

!macro CcHahaRunLegacyRecovery
  ${If} $ccHahaRecoveryDone != "1"
    ReadRegStr $ccHahaPerUserInstallLocation HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $ccHahaPerMachineInstallLocation HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $ccHahaPerUserUninstallString HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ReadRegStr $ccHahaPerMachineUninstallString HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ${If} $ccHahaPerUserUninstallString == ""
        ReadRegStr $ccHahaPerUserUninstallString HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      ${EndIf}
      ${If} $ccHahaPerMachineUninstallString == ""
        ReadRegStr $ccHahaPerMachineUninstallString HKLM "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      ${EndIf}
    !endif

    ${If} $ccHahaPerUserInstallLocation == ""
    ${AndIf} $ccHahaPerMachineInstallLocation == ""
    ${AndIf} $ccHahaPerUserUninstallString == ""
    ${AndIf} $ccHahaPerMachineUninstallString == ""
      StrCpy $ccHahaRecoveryDone "1"
      DetailPrint "No registered installation needs legacy data recovery"
    ${Else}
      StrCpy $8 "trusted-user"
      ${If} ${UAC_IsAdmin}
      ${AndIfNot} ${UAC_IsInnerInstance}
        StrCpy $8 "untrusted-elevated"
      ${EndIf}
      ${If} ${UAC_IsInnerInstance}
        StrCpy $8 "trusted-uac-outer"
      ${EndIf}

      Call CcHahaCanSkipLegacyRecovery
      Pop $R0
      ${If} $R0 == "1"
        StrCpy $ccHahaRecoveryDone "1"
        DetailPrint "No legacy data candidates found for the registered per-user installation"
      ${Else}
        ${If} ${UAC_IsInnerInstance}
          !insertmacro UAC_AsUser_Call Function CcHahaRecoverLegacy ${UAC_SYNCREGISTERS}|${UAC_SYNCOUTDIR}|${UAC_SYNCINSTDIR}
        ${Else}
          Call CcHahaRecoverLegacy
        ${EndIf}

        ${If} $0 != "0"
          DetailPrint "Legacy data recovery stopped the installer (helper exit code: $0; output: $1)"
          ${If} $1 == ""
            StrCpy $1 "Recovery helper failed without diagnostic output (exit code $0)"
          ${EndIf}
          StrCpy $R2 "$1" 360
          MessageBox MB_ICONSTOP|MB_OK "Claude Code Haha stopped setup before removing the old version. Reason: $R2$\r$\n$\r$\nClose the app and retry. If the reason mentions an elevated installer, launch setup normally instead of using Run as administrator.$\r$\n$\r$\nClaude Code Haha 已在删除旧版本前停止安装。原因：$R2$\r$\n$\r$\n请关闭旧程序后重试；如果原因提到安装器权限过高，请直接双击运行，不要使用“以管理员身份运行”。旧版本和原数据尚未删除。" /SD IDOK
          SetErrorLevel 20
          Quit
        ${EndIf}
        StrCpy $ccHahaRecoveryDone "1"
        DetailPrint "Legacy Claude Code Haha data safety check completed"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
!endif

!macro CcHahaFindInstallProcess _FILE _RETURN
  ${If} $IsPowerShellAvailable == 0
    nsExec::ExecToStack '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\check-install-processes.ps1" -InstallDir "$INSTDIR" -ProcessName "${_FILE}" -Action Find -InstallerPid "$pid" -InstallerParentPid "$1"'
    Pop ${_RETURN}
    Pop $ccHahaProcessDiagnostic
    ${If} $ccHahaProcessDiagnostic != ""
      DetailPrint "$ccHahaProcessDiagnostic"
    ${EndIf}
    ; The helper only exits 0 (found or failed closed) or 1 (nothing found).
    ; Anything else means it never ran, e.g. a security tool removed it.
    ${If} ${_RETURN} != 0
    ${AndIf} ${_RETURN} != 1
      DetailPrint "PowerShell process helper did not run (result: ${_RETURN}); using the tasklist fallback."
      StrCpy $IsPowerShellAvailable 1
    ${EndIf}
  ${EndIf}
  ${If} $IsPowerShellAvailable != 0
    Delete "$PLUGINSDIR\cc-haha-processes.csv"
    !ifdef INSTALL_MODE_PER_ALL_USERS
      nsExec::Exec '"$CmdPath" /D /C tasklist /FO CSV /NH > "$PLUGINSDIR\cc-haha-processes.csv"'
    !else
      nsExec::Exec '"$CmdPath" /D /C tasklist /FI "USERNAME eq %USERNAME%" /FO CSV /NH > "$PLUGINSDIR\cc-haha-processes.csv"'
    !endif
    Pop ${_RETURN}
    ${If} ${_RETURN} != 0
      StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable and tasklist process enumeration failed (exit code ${_RETURN}); blocking setup."
      StrCpy ${_RETURN} 0
    ${Else}
      nsExec::Exec '"$SYSDIR\findstr.exe" /I /L /C:"${_FILE}" /C:"claude-sidecar-x86_64-pc-windows-msvc.exe" /C:"claude-sidecar-aarch64-pc-windows-msvc.exe" /C:"claude-sidecar.exe" /C:"OpenConsole.exe" /C:"winpty-agent.exe" /C:"rg.exe" "$PLUGINSDIR\cc-haha-processes.csv"'
      Pop ${_RETURN}
      ${If} ${_RETURN} == 0
        StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable; the main app, a known sidecar, or a bundled terminal/search helper is running with an unknown path. Close it manually."
      ${ElseIf} ${_RETURN} == 1
        StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable; exact-image fallback found no main app, known sidecar, or bundled terminal/search helper. Differently named child processes cannot be attributed without path data."
      ${Else}
        StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable and fallback process filtering failed (exit code ${_RETURN}); blocking setup."
        StrCpy ${_RETURN} 0
      ${EndIf}
    ${EndIf}
    DetailPrint "$ccHahaProcessDiagnostic"
  ${EndIf}
!macroend

!macro CcHahaKillInstallProcess _FILE _FORCE
  Push $0
  ${If} ${_FORCE} == 1
    StrCpy $0 "KillForce"
  ${Else}
    StrCpy $0 "Kill"
  ${EndIf}

  ${If} $IsPowerShellAvailable == 0
    nsExec::ExecToStack '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\check-install-processes.ps1" -InstallDir "$INSTDIR" -ProcessName "${_FILE}" -Action "$0" -InstallerPid "$pid" -InstallerParentPid "$1"'
    Pop $0
    Pop $ccHahaProcessDiagnostic
    ${If} $ccHahaProcessDiagnostic != ""
      DetailPrint "$ccHahaProcessDiagnostic"
    ${EndIf}
  ${Else}
    StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable; refusing to terminate by image name because the executable path is unknown. Close the app manually."
    DetailPrint "$ccHahaProcessDiagnostic"
  ${EndIf}
  Pop $0
!macroend

!macro customCheckAppRunning
  InitPluginsDir
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${If} $IsPowerShellAvailable == 0
    ; `File` aborts setup when a security tool blocks the .ps1 write (#1486);
    ; a failed FileWrite falls back to the tasklist path instead.
    !insertmacro CcHahaWriteInstallProcessHelper "$PLUGINSDIR\check-install-processes.ps1"
    ${If} ${Errors}
    ${OrIfNot} ${FileExists} "$PLUGINSDIR\check-install-processes.ps1"
      DetailPrint "Could not write the PowerShell process helper (often blocked by security software); using the tasklist fallback."
      StrCpy $IsPowerShellAvailable 1
      StrCpy $ccHahaProcessHelperWriteBlocked "1"
    ${EndIf}
  ${EndIf}
  StrCpy $ccHahaProcessDiagnostic ""
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${If} $3 != "${APP_EXECUTABLE_FILENAME}"
    ${If} ${isUpdated}
      Sleep 300
    ${EndIf}

    !insertmacro CcHahaFindInstallProcess "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      ${If} ${isUpdated}
        Sleep 1000
        Goto cc_haha_stop_process
      ${EndIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK cc_haha_stop_process
      SetErrorLevel 22
      Quit

      cc_haha_stop_process:
        DetailPrint "$(appClosing)"
        !insertmacro CcHahaKillInstallProcess "${APP_EXECUTABLE_FILENAME}" 0
        Sleep 300
        StrCpy $R1 0

      cc_haha_process_retry:
        IntOp $R1 $R1 + 1
        !insertmacro CcHahaFindInstallProcess "${APP_EXECUTABLE_FILENAME}" $R0
        ${If} $R0 == 0
          Sleep 1000
          !insertmacro CcHahaKillInstallProcess "${APP_EXECUTABLE_FILENAME}" 1
          !insertmacro CcHahaFindInstallProcess "${APP_EXECUTABLE_FILENAME}" $R0
          ${If} $R0 == 0
            DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
            Sleep 2000
          ${Else}
            Goto cc_haha_process_not_running
          ${EndIf}
        ${Else}
          Goto cc_haha_process_not_running
        ${EndIf}

        ${If} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)$\r$\n$\r$\n$ccHahaProcessDiagnostic" /SD IDCANCEL IDRETRY cc_haha_process_retry
          SetErrorLevel 22
          Quit
        ${Else}
          Goto cc_haha_process_retry
        ${EndIf}

      cc_haha_process_not_running:
    ${EndIf}
  ${EndIf}
  !ifndef BUILD_UNINSTALLER
    !insertmacro CcHahaRunLegacyRecovery
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  Function CcHahaRecoveryBeforeInstall
    ${If} ${UAC_IsInnerInstance}
      !insertmacro CcHahaRunLegacyRecovery
    ${EndIf}
    Abort
  FunctionEnd
  Page custom CcHahaRecoveryBeforeInstall
!macroend

; Installed 0.6.x and older uninstallers still extract the process helper with
; `File`, so a security tool that blocks the .ps1 write makes them abort in
; un.onInit before touching any file (#1486). electron-builder would then quit
; and strand the user on the old version. Only when this installer saw the
; same block itself, install over the old files; exit code 22 (the old
; uninstaller found the app running) and every other failure stay fatal.
!macro CcHahaHandleOldUninstallerResult
  ${If} $R0 != 0
  ${AndIf} $R0 != 22
  ${AndIf} $ccHahaProcessHelperWriteBlocked == "1"
    DetailPrint `Old uninstaller exited with code $R0 and this installer could not write its helper script either (security software); installing over the existing files.`
  ${ElseIf} $R0 != 22
  ${AndIf} ${Errors}
    DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  ${ElseIf} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro CcHahaHandleOldUninstallerResult
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro CcHahaHandleOldUninstallerResult
!macroend

!macro customInit
  StrCpy $ccHahaRecoveryDone "0"
  ${If} ${UAC_IsInnerInstance}
  ${AndIf} ${Silent}
    !insertmacro CcHahaRunLegacyRecovery
  ${EndIf}
!macroend
!endif
