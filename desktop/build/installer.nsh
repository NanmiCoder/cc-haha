!include "LogicLib.nsh"
!include "getProcessInfo.nsh"
!include "${BUILD_RESOURCES_DIR}\check-install-processes.nsh"
!include "${BUILD_RESOURCES_DIR}\guarded-removal-launch.nsh"
!define /ifndef INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!define /ifndef UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
Var pid
Var ccHahaProcessDiagnostic
Var ccHahaProcessHelperWriteBlocked
Var ccHahaFallbackOutput

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
; Clobbers R1, R6, R7 and R8; the caller saves them. Opening the actual file or
; directory resolves aliases on both sides of the comparison. An existence
; query cannot distinguish a missing directory from denied access.
!macro CcHahaReadFinalProcessPath _PATH _RETURN
  ; FILE_READ_ATTRIBUTES, share read|write|delete, OPEN_EXISTING, BACKUP_SEMANTICS
  System::Call 'kernel32::CreateFileW(w "${_PATH}", i 0x80, i 7, p 0, i 3, i 0x02000000, p 0) p.R6'
  StrCpy ${_RETURN} ""
  ${If} $R6 <> -1
    System::Call 'kernel32::GetFinalPathNameByHandleW(p R6, w .R7, i ${NSIS_MAX_STRLEN}, i 0) i.R8'
    System::Call 'kernel32::CloseHandle(p R6)'
    StrLen $R1 $R7
    ${If} $R8 > 0
    ${AndIf} $R8 < ${NSIS_MAX_STRLEN}
    ${AndIf} $R8 = $R1
      ; VOLUME_NAME_DOS returns an extended drive or UNC path. Do not accept an
      ; unexpected namespace as proof that a process belongs to other software.
      StrCpy $R1 $R7 8
      ${If} $R1 == "\\?\UNC\"
        StrCpy ${_RETURN} $R7
      ${Else}
        StrCpy $R1 $R7 4
        ${If} $R1 == "\\?\"
          StrCpy $R1 $R7 2 5
          ${If} $R1 == ":\"
            StrCpy ${_RETURN} $R7
          ${Else}
            StrCpy ${_RETURN} ""
          ${EndIf}
        ${Else}
          StrCpy ${_RETURN} ""
        ${EndIf}
      ${EndIf}
    ${Else}
      StrCpy ${_RETURN} ""
    ${EndIf}
  ${EndIf}
!macroend

!macro CcHahaAttributeFallbackMatches _FILE _RETURN
  Push $0  ; canonical installation directory, empty means unknown
  Push $R1 ; scratch
  Push $R2 ; process snapshot
  Push $R3 ; PROCESSENTRY32W
  Push $R4 ; process id
  Push $R5 ; image name
  Push $R6 ; handles, then scratch
  Push $R7 ; executable path
  Push $R8 ; call results
  Push $R9 ; processes that block setup
  StrCpy $R9 ""
  !insertmacro CcHahaReadFinalProcessPath "$INSTDIR" $0
  ${If} $0 == ""
    StrCpy $R9 " (the install directory could not be resolved);"
  ${Else}
    StrCpy $R8 $0 1 -1
    ${If} $R8 != "\"
      StrCpy $0 "$0\"
    ${EndIf}
    StrCpy $R8 $0 1 -1
    ${If} $R8 != "\"
      StrCpy $0 ""
      StrCpy $R9 " (the install directory path is too long);"
    ${EndIf}
  ${EndIf}

  ; TH32CS_SNAPPROCESS
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p.R2'
  ${If} $R2 = -1
    StrCpy $R9 " (the process list could not be read);"
  ${Else}
    System::Alloc 1024
    Pop $R3
    ${If} $R3 = 0
      StrCpy $R9 " (the process list buffer could not be allocated);"
    ${Else}
      ; dwSize of the 32-bit PROCESSENTRY32W this installer stub uses.
      System::Call '*$R3(i 556)'
      System::Call 'kernel32::Process32FirstW(p R2, p R3) i.R8'
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
            System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i R4) p.R6'
            ${If} $R6 <> 0
              System::Call 'kernel32::QueryFullProcessImageNameW(p R6, i 0, w .R7, *i ${NSIS_MAX_STRLEN}) i.R8'
              ${If} $R8 = 0
                StrCpy $R7 ""
              ${EndIf}
              System::Call 'kernel32::CloseHandle(p R6)'
            ${EndIf}
            ${If} $R7 == ""
              StrCpy $R9 "$R9 $R5 (PID $R4, path unavailable);"
            ${ElseIf} $0 == ""
              StrCpy $R9 "$R9 $R5 (PID $R4, install directory could not be resolved);"
            ${Else}
              !insertmacro CcHahaReadFinalProcessPath "$R7" $R7
              StrLen $R6 $0
              StrCpy $R6 $R7 $R6
              ${If} $R7 == ""
                StrCpy $R9 "$R9 $R5 (PID $R4, path identity unavailable);"
              ${ElseIf} $R6 == $0
                StrCpy $R9 "$R9 $R5 (PID $R4);"
              !ifdef CC_HAHA_LEGACY_COMPAT_TEMPLATE
              ${Else}
                StrCpy $ccHahaCompatExternalMatch 1
              !endif
              ${EndIf}
            ${EndIf}
          ${EndIf}
        ${EndIf}
        ; Capture the API error before any plug-in cleanup can overwrite it.
        System::Call 'kernel32::Process32NextW(p R2, p R3) i.R8 ?e'
        Pop $R6
        ${If} $R8 = 0
        ${AndIf} $R6 <> 18 ; ERROR_NO_MORE_FILES is the only successful end
          StrCpy $R9 "$R9 (the process list could not be completed);"
        ${EndIf}
      ${EndWhile}
      System::Free $R3
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p R2)'
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

!macro CcHahaFilterFallbackProcesses _FILE _CSV _RETURN _OUTPUT
  nsExec::ExecToStack /TIMEOUT=30000 '"$SYSDIR\findstr.exe" /I /L /C:"${_FILE}" /C:"claude-sidecar-x86_64-pc-windows-msvc.exe" /C:"claude-sidecar-aarch64-pc-windows-msvc.exe" /C:"claude-sidecar.exe" /C:"OpenConsole.exe" /C:"winpty-agent.exe" /C:"rg.exe" "${_CSV}"'
  Pop ${_RETURN}
  Pop ${_OUTPUT}
!macroend

!macro CcHahaVerifyFallbackRemainder _FILE _RETURN _CMD
  Push $R1
  Push $R2
  Push $R3
  StrCpy ${_RETURN} 0
  StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable; the original tasklist matches could not all be verified; blocking setup. Close the matching processes manually."

  ; Native attribution has already rejected every exact app/sidecar name and
  ; every exact shared helper whose path is internal or unreadable. Remove only
  ; those positively external shared names and our own PID from the original
  ; CSV. A literal hit such as foorg.exe must remain protected even though the
  ; native census does not classify that image as an exact shared-helper name.
  ClearErrors
  FileOpen $R1 "$PLUGINSDIR\cc-haha-fallback-allowed.txt" w
  ${IfNot} ${Errors}
    ClearErrors
    FileWrite $R1 '^"OpenConsole[.]exe","$\r$\n^"winpty-agent[.]exe","$\r$\n^"rg[.]exe","$\r$\n^"[^"]*","$pid",$\r$\n'
    StrCpy $R2 0
    ${If} ${Errors}
      StrCpy $R2 1
    ${EndIf}
    ClearErrors
    FileClose $R1
    ${If} ${Errors}
      StrCpy $R2 1
    ${EndIf}
    ${If} $R2 == 0
      Delete "$PLUGINSDIR\cc-haha-fallback-unattributed.csv"
      ${IfNot} ${FileExists} "$PLUGINSDIR\cc-haha-fallback-unattributed.csv"
        nsExec::Exec /TIMEOUT=30000 '"${_CMD}" /D /C ""$SYSDIR\findstr.exe" /V /R /I /G:"$PLUGINSDIR\cc-haha-fallback-allowed.txt" "$PLUGINSDIR\cc-haha-processes.csv" > "$PLUGINSDIR\cc-haha-fallback-unattributed.csv""'
        Pop $R2
        ; tasklist also contains System rows, so a successful exclusion leaves
        ; output and returns 0. Any other result, including timeout/error or a
        ; failed redirection, must not authorize continuing from a stale file.
        ${If} $R2 == 0
        ${AndIf} ${FileExists} "$PLUGINSDIR\cc-haha-fallback-unattributed.csv"
          !insertmacro CcHahaFilterFallbackProcesses "${_FILE}" "$PLUGINSDIR\cc-haha-fallback-unattributed.csv" $R2 $R3
          ${If} $R2 == 1
            StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable; every original tasklist match is the installer itself or an exact shared helper verified outside the install directory, so setup continues."
            StrCpy ${_RETURN} 1
          ${ElseIf} $R2 == 0
            StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable; these original tasklist matches have no verified external path:$\r$\n$R3$\r$\nClose them manually."
          ${Else}
            StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable; residual process filtering failed (result: $R2); blocking setup."
          ${EndIf}
        ${Else}
          StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable; tasklist match verification failed (result: $R2); blocking setup."
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $R3
  Pop $R2
  Pop $R1
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
      !insertmacro CcHahaFilterFallbackProcesses "${_FILE}" "$PLUGINSDIR\cc-haha-processes.csv" ${_RETURN} $ccHahaFallbackOutput
      ${If} ${_RETURN} == 0
        StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable; the main app, a known sidecar, or a bundled terminal/search helper is running with an unknown path, possibly in another user's session. Close it manually."
        !insertmacro CcHahaAttributeFallbackMatches "${_FILE}" ${_RETURN}
        ${If} ${_RETURN} == 1
          !insertmacro CcHahaVerifyFallbackRemainder "${_FILE}" ${_RETURN} "$CmdPath"
        ${EndIf}
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
  !ifdef BUILD_UNINSTALLER
    !insertmacro CcHahaGuardCheckUninstallerEntry cc_haha_guarded_process_check_done
  !endif
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
  !else
    cc_haha_guarded_process_check_done:
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
!include "${BUILD_RESOURCES_DIR}\legacy-uninstaller-compat.nsh"
!endif

; Both !system and !execute use a shell on the pinned Mac compiler. Encode
; before command parsing, including ~ first so decoding is exactly one pass.
; The fixed Node program receives only data and never evaluates a path as JS.
!macro CcHahaEncodeBuildArgument _OUT _VALUE
  !searchreplace ${_OUT} "${_VALUE}" "~" "~7e"
  !searchreplace ${_OUT} "${${_OUT}}" "'" "~27"
  !searchreplace ${_OUT} "${${_OUT}}" "\" "~5c"
  !searchreplace ${_OUT} "${${_OUT}}" "$" "~24"
  !searchreplace ${_OUT} "${${_OUT}}" "`" "~60"
  !searchreplace ${_OUT} "${${_OUT}}" "%" "~25"
  !searchreplace ${_OUT} "${${_OUT}}" "!" "~21"
  !searchreplace ${_OUT} "${${_OUT}}" "^" "~5e"
!macroend

!macro CcHahaRunBuildHelper _MODE _ARG1 _ARG2
  !insertmacro CcHahaEncodeBuildArgument CC_HAHA_BUILD_SCRIPT "${BUILD_RESOURCES_DIR}/../scripts/nsis-legacy-compat.cjs"
  !insertmacro CcHahaEncodeBuildArgument CC_HAHA_BUILD_ARG1 "${_ARG1}"
  !insertmacro CcHahaEncodeBuildArgument CC_HAHA_BUILD_ARG2 "${_ARG2}"
  !execute "$\"node$\" -e $\"const d=s=>s.replace(/~([0-9a-f]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)));require(d(process.argv[1])).run(process.argv[2],process.argv.slice(3).map(d))$\" $\"${CC_HAHA_BUILD_SCRIPT}$\" ${_MODE} $\"${CC_HAHA_BUILD_ARG1}$\" $\"${CC_HAHA_BUILD_ARG2}$\"" = 0
  !undef CC_HAHA_BUILD_SCRIPT
  !undef CC_HAHA_BUILD_ARG1
  !undef CC_HAHA_BUILD_ARG2
!macroend

; This supported header runs before installer.nsi includes installUtil.nsh.
; Only installUtil is adapted, in a private per-compilation directory. The
; uninstaller uses the official customRemoveFiles hook and a byte-identical
; pinned default block. Default script selection and signIf remain intact.
!macro customHeader
  !ifdef BUILD_UNINSTALLER
    !tempfile CC_HAHA_NSIS_GUARDED_BOOTSTRAP
    !insertmacro CcHahaRunBuildHelper prepare-guarded "${BUILD_RESOURCES_DIR}/guarded-removal.cs" "${CC_HAHA_NSIS_GUARDED_BOOTSTRAP}"
    !include "${CC_HAHA_NSIS_GUARDED_BOOTSTRAP}"
    !delfile "${CC_HAHA_NSIS_GUARDED_BOOTSTRAP}"
    !undef CC_HAHA_NSIS_GUARDED_BOOTSTRAP
    !insertmacro CcHahaGuardFunctions
    !insertmacro CcHahaGuardUninstallerFunctions
  !else
  !tempfile CC_HAHA_NSIS_COMPAT_BOOTSTRAP
  !insertmacro CcHahaRunBuildHelper prepare "${UNINSTALLER_OUT_FILE}" "${CC_HAHA_NSIS_COMPAT_BOOTSTRAP}"
  !include "${CC_HAHA_NSIS_COMPAT_BOOTSTRAP}"
  !delfile "${CC_HAHA_NSIS_COMPAT_BOOTSTRAP}"
  !undef CC_HAHA_NSIS_COMPAT_BOOTSTRAP
  !insertmacro CcHahaGuardFunctions
  !insertmacro CcHahaLegacyCompatFunctions
  !endif
!macroend

!ifdef BUILD_UNINSTALLER
!macro customUnInit
  Call un.CcHahaGuardReceive
  ${If} $ccHahaGuardMode == "invalid"
    SetErrorLevel 22
    Quit
  ${EndIf}
!macroend

!macro customUnInstallSection
  !insertmacro CcHahaRunBuildHelper cleanup "${CC_HAHA_NSIS_GUARDED_DIRECTORY}" "${CC_HAHA_NSIS_GUARDED_OWNER}"
!macroend
!else
!macro customInstall
  !insertmacro CcHahaRunBuildHelper cleanup "${CC_HAHA_NSIS_COMPAT_DIRECTORY}" "${CC_HAHA_NSIS_COMPAT_OWNER}"
!macroend

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
; same block itself, install over the old files. Apart from the separately
; verified v0.7.8 trusted-removal path, exit 22 and other failures stay fatal.
!macro CcHahaHandleOldUninstallerResult
  !ifdef CC_HAHA_LEGACY_COMPAT_TEMPLATE
    Call CcHahaTryTrustedLegacyRemoval
  !endif
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
