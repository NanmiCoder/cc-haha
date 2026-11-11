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

; electron-builder's IS_POWERSHELL_AVAILABLE runs Get-ExecutionPolicy in
; Windows PowerShell 5.1. When setup inherits a PowerShell 7 PSModulePath (it
; was started from pwsh, or by an app or tool running in pwsh), 5.1 tries to
; load PowerShell 7's Microsoft.PowerShell.Security, the command fails, and
; setup treats PowerShell as unavailable. The tasklist fallback then cannot see
; executable paths and tells the user to close the running app manually.
; Removing the variable lets every PowerShell child build its own default path.
!macro CcHahaUseDefaultPowerShellModulePath
  System::Call 'kernel32::SetEnvironmentVariable(w "PSModulePath", p 0)'
!macroend

; The tasklist fallback below matches image names only, and other software
; ships three of them: Windows Terminal's console host is OpenConsole.exe, and
; Claude Code and VS Code bundle rg.exe. An open terminal therefore made every
; upgrade stop at "close it manually" (#1879). Reading a process's executable
; path needs no PowerShell, so those three shared names only block setup when
; the process runs from the install directory, or when that cannot be told (its
; path or the install directory cannot be read), which stays fail-closed. The
; names only this app uses still block on the name alone. Keep the names in
; sync with the findstr list in CcHahaFindInstallProcess.
!macro CcHahaAttributeFallbackMatches _FILE _RETURN
  Push $0  ; install directory as the kernel resolves it, "" if it does not exist, "*" if unknown
  Push $R1 ; install directory as given, long form, with a trailing backslash
  Push $R2 ; process snapshot
  Push $R3 ; PROCESSENTRY32W
  Push $R4 ; process id
  Push $R5 ; image name
  Push $R6 ; handles, then scratch
  Push $R7 ; executable path
  Push $R8 ; call results
  Push $R9 ; processes that block setup
  StrCpy $R9 ""
  StrCpy $R1 "$INSTDIR"
  System::Call 'kernel32::GetFullPathNameW(w R1, i ${NSIS_MAX_STRLEN}, w .R7, p 0) i.R8'
  ${If} $R8 <> 0
    StrCpy $R1 $R7
  ${EndIf}
  System::Call 'kernel32::GetLongPathNameW(w R1, w .R7, i ${NSIS_MAX_STRLEN}) i.R8'
  ${If} $R8 <> 0
    StrCpy $R1 $R7
  ${EndIf}
  StrCpy $R8 $R1 1 -1
  ${If} $R8 != "\"
    StrCpy $R1 "$R1\"
  ${EndIf}

  ; A process path is reported after junctions, directory symlinks and SUBST
  ; drives are resolved, so the install directory is compared in that form too.
  StrCpy $0 ""
  ${If} ${FileExists} "$R1*.*"
    StrCpy $0 "*"
    ; FILE_READ_ATTRIBUTES, share read|write|delete, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS
    System::Call 'kernel32::CreateFileW(w R1, i 0x80, i 7, p 0, i 3, i 0x02000000, p 0) i.R6'
    ${If} $R6 <> -1
      ; FILE_NAME_NORMALIZED | VOLUME_NAME_DOS
      System::Call 'kernel32::GetFinalPathNameByHandleW(i R6, w .R7, i ${NSIS_MAX_STRLEN}, i 0) i.R8'
      System::Call 'kernel32::CloseHandle(i R6)'
      ${If} $R8 <> 0
      ${AndIf} $R8 < ${NSIS_MAX_STRLEN}
        StrCpy $R8 $R7 8
        ${If} $R8 == "\\?\UNC\"
          StrCpy $0 $R7 "" 8
          StrCpy $0 "\\$0"
        ${Else}
          StrCpy $0 $R7 "" 4
        ${EndIf}
        StrCpy $R8 $0 1 -1
        ${If} $R8 != "\"
          StrCpy $0 "$0\"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; TH32CS_SNAPPROCESS
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) i.R2'
  ${If} $R2 = -1
    StrCpy $R9 " (the process list could not be read);"
  ${Else}
    System::Alloc 1024
    Pop $R3
    ; dwSize of the 32-bit PROCESSENTRY32W this installer stub uses.
    System::Call '*$R3(i 556)'
    System::Call 'kernel32::Process32FirstW(i R2, p R3) i.R8'
    ${If} $R8 = 0
      StrCpy $R9 " (the process list could not be read);"
    ${EndIf}
    ${While} $R8 <> 0
      System::Call '*$R3(i, i, i .R4, i, i, i, i, i, i, &w260 .R5)'
      ${If} $R4 != $pid
        ${If} $R5 == "${_FILE}"
        ${OrIf} $R5 == "claude-sidecar-x86_64-pc-windows-msvc.exe"
        ${OrIf} $R5 == "claude-sidecar-aarch64-pc-windows-msvc.exe"
        ${OrIf} $R5 == "claude-sidecar.exe"
          StrCpy $R9 "$R9 $R5 (PID $R4);"
        ${ElseIf} $R5 == "OpenConsole.exe"
        ${OrIf} $R5 == "winpty-agent.exe"
        ${OrIf} $R5 == "rg.exe"
          StrCpy $R7 ""
          ; PROCESS_QUERY_LIMITED_INFORMATION
          System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i R4) i.R6'
          ${If} $R6 <> 0
            System::Call 'kernel32::QueryFullProcessImageNameW(i R6, i 0, w .R7, *i ${NSIS_MAX_STRLEN}) i.R8'
            ${If} $R8 = 0
              StrCpy $R7 ""
            ${EndIf}
            System::Call 'kernel32::CloseHandle(i R6)'
          ${EndIf}
          ${If} $R7 == ""
            StrCpy $R9 "$R9 $R5 (PID $R4, path unavailable);"
          ${ElseIf} $0 == "*"
            StrCpy $R9 "$R9 $R5 (PID $R4, install directory could not be resolved);"
          ${Else}
            System::Call 'kernel32::GetLongPathNameW(w R7, w .R6, i ${NSIS_MAX_STRLEN}) i.R8'
            ${If} $R8 <> 0
              StrCpy $R7 $R6
            ${EndIf}
            StrLen $R8 $R1
            StrCpy $R8 $R7 $R8
            StrLen $R6 $0
            StrCpy $R6 $R7 $R6
            ${If} $R8 == $R1
              StrCpy $R9 "$R9 $R5 (PID $R4);"
            ${ElseIf} $0 != ""
            ${AndIf} $R6 == $0
              StrCpy $R9 "$R9 $R5 (PID $R4);"
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
      System::Call 'kernel32::Process32NextW(i R2, p R3) i.R8'
    ${EndWhile}
    System::Free $R3
    System::Call 'kernel32::CloseHandle(i R2)'
  ${EndIf}

  ${If} $R9 == ""
    StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable; the matching image names belong to other software outside the install directory, so setup continues."
    StrCpy ${_RETURN} 1
  ${Else}
    StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable; these processes are the app itself, run from the install directory, or cannot be told apart (possibly another user's session):$R9 Close them manually."
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $0
!macroend

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
    ; No USERNAME filter: it makes tasklist look up the owner of every process,
    ; and that lookup can block forever, which froze setup and the silent
    ; uninstaller with no message. Image names are all this fallback matches; a
    ; same-named process of another user only makes it block setup with the
    ; close-manually message, the fail-closed direction. The timeout turns any
    ; other stall into the enumeration-failed message below: nsExec then pushes
    ; "timeout" (or "error") instead of an exit code, so the result checks must
    ; stay string tests (== / !=); an integer test reads those words as 0.
    nsExec::Exec /TIMEOUT=30000 '"$CmdPath" /D /C tasklist /FO CSV /NH > "$PLUGINSDIR\cc-haha-processes.csv"'
    Pop ${_RETURN}
    ${If} ${_RETURN} != 0
      StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable and tasklist process enumeration failed (exit code ${_RETURN}); blocking setup."
      StrCpy ${_RETURN} 0
    ${Else}
      nsExec::Exec /TIMEOUT=30000 '"$SYSDIR\findstr.exe" /I /L /C:"${_FILE}" /C:"claude-sidecar-x86_64-pc-windows-msvc.exe" /C:"claude-sidecar-aarch64-pc-windows-msvc.exe" /C:"claude-sidecar.exe" /C:"OpenConsole.exe" /C:"winpty-agent.exe" /C:"rg.exe" "$PLUGINSDIR\cc-haha-processes.csv"'
      Pop ${_RETURN}
      ${If} ${_RETURN} == 0
        StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable; the main app, a known sidecar, or a bundled terminal/search helper is running with an unknown path, possibly in another user's session. Close it manually."
        !insertmacro CcHahaAttributeFallbackMatches "${_FILE}" ${_RETURN}
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
  !insertmacro CcHahaUseDefaultPowerShellModulePath
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${If} $IsPowerShellAvailable == 0
    ; `File` aborts setup when a security tool blocks the .ps1 write (#1486);
    ; a failed FileWrite falls back to the tasklist path instead.
    !insertmacro CcHahaWriteInstallProcessHelper "$PLUGINSDIR\check-install-processes.ps1" $ccHahaProcessHelperWriteBlocked
    ; IfErrors consumes the flag. The writer returns an explicit status so an
    ; existing but locked file cannot mask an open or partial-write failure.
    ${If} $ccHahaProcessHelperWriteBlocked == "1"
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
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK
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
