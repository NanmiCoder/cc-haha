; One pinned official v0.7.8 x64 uninstaller mistakes external shared helpers
; for this app when PowerShell cannot run. This is an admission check only:
; removal uses only the current uninstaller's guarded customRemoveFiles path.
!ifndef BUILD_UNINSTALLER
Var ccHahaCompatReady
Var ccHahaCompatFirstExit22
Var ccHahaCompatAttempted
Var ccHahaCompatRoot
Var ccHahaCompatOldFile
Var ccHahaCompatOldCopy
Var ccHahaCompatUninstallString
Var ccHahaCompatIdentity
Var ccHahaCompatPlainResult
Var ccHahaCompatTreeResult
Var ccHahaCompatTreeEntries
Var ccHahaCompatTreeDepth
Var ccHahaCompatExternalMatch
Var ccHahaCompatFault

; RegOpenKeyEx reports ERROR_FILE_NOT_FOUND for an absent key. Access denied,
; unexpected registry views and every other query result remain unknown.
!macro CcHahaCompatRequireAbsent _HIVE _KEY _VIEW _FAIL
  System::Call 'advapi32::RegOpenKeyExW(p ${_HIVE}, w "${_KEY}", i 0, i ${_VIEW}, *p .R8) i.R9'
  ${If} $R9 == 0
    System::Call 'advapi32::RegCloseKey(p R8)'
  ${EndIf}
  StrCmp $R9 2 0 ${_FAIL}
!macroend

; REG_SZ only, no expansion, explicit 64-bit view and a bounded byte buffer.
!macro CcHahaCompatReadUserString _KEY _VALUE _OUT _FAIL
  System::Call 'advapi32::RegGetValueW(p 0x80000001, w "${_KEY}", w "${_VALUE}", i 0x10010002, p 0, w .R7, *i ${NSIS_MAX_STRLEN}) i.R9'
  StrCmp $R9 0 0 ${_FAIL}
  StrCpy ${_OUT} $R7
!macroend

; Reject aliases and every reparse point in the directory's ancestor chain.
; A canonical drive path on a fixed local volume is the only admitted shape.
Function CcHahaCompatPlainRoot
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R6
  Push $R7
  Push $R8
  StrCpy $ccHahaCompatPlainResult 0
  StrLen $R2 $R0
  IntCmp $R2 3 cc_haha_plain_root_done cc_haha_plain_root_done 0
  StrCpy $R1 $R0 2 1
  StrCmp $R1 ":\" 0 cc_haha_plain_root_done
  StrCpy $R1 $R0 3
  System::Call 'kernel32::GetDriveTypeW(w R1) i.R3'
  StrCmp $R3 3 0 cc_haha_plain_root_done
  !insertmacro CcHahaReadFinalProcessPath "$R0" $R3
  StrCmp $R3 "\\?\$R0" 0 cc_haha_plain_root_done
  StrCpy $R2 2
  cc_haha_plain_root_next:
    StrCpy $R1 $R0 1 $R2
    ${If} $R1 == "\"
    ${OrIf} $R1 == ""
      StrCpy $R3 $R0 $R2
      ${If} $R2 == 2
        StrCpy $R3 "$R3\"
      ${EndIf}
      System::Call 'kernel32::GetFileAttributesW(w R3) i.R7'
      StrCmp $R7 -1 cc_haha_plain_root_done
      IntOp $R8 $R7 & 0x410
      StrCmp $R8 16 0 cc_haha_plain_root_done
    ${EndIf}
    StrCmp $R1 "" cc_haha_plain_root_safe
    IntOp $R2 $R2 + 1
    Goto cc_haha_plain_root_next
  cc_haha_plain_root_safe:
    StrCpy $ccHahaCompatPlainResult 1
  cc_haha_plain_root_done:
    Pop $R8
    Pop $R7
    Pop $R6
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
FunctionEnd

; Check the whole tree before reusing the template's recursive removal. A
; junction nested in resources is as unsafe as one in the install root.
Function CcHahaCompatPlainTree
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  StrCpy $ccHahaCompatTreeResult 0
  IntOp $ccHahaCompatTreeDepth $ccHahaCompatTreeDepth + 1
  IntCmp $ccHahaCompatTreeDepth 128 cc_haha_plain_tree_done 0 cc_haha_plain_tree_done
  System::Call 'kernel32::GetFileAttributesW(w R0) i.R3'
  StrCmp $R3 -1 cc_haha_plain_tree_done
  IntOp $R5 $R3 & 0x400
  StrCmp $R5 0 0 cc_haha_plain_tree_done
  IntOp $R5 $R3 & 0x10
  StrCmp $R5 0 cc_haha_plain_tree_safe
  StrLen $R5 $R0
  IntOp $R5 $R5 + 2
  IntCmp $R5 ${NSIS_MAX_STRLEN} cc_haha_plain_tree_done 0 cc_haha_plain_tree_done
  System::Alloc 592
  Pop $R2
  StrCmp $R2 0 cc_haha_plain_tree_done
  System::Call 'kernel32::FindFirstFileW(w "$R0\*", p R2) p.R1 ?e'
  Pop $R6
  ${If} $R1 == -1
    StrCmp $R6 2 0 cc_haha_plain_tree_free
    StrCpy $ccHahaCompatTreeResult 1
    Goto cc_haha_plain_tree_free
  ${EndIf}
  cc_haha_plain_tree_next:
    System::Call '*$R2(i, i, i, i, i, i, i, i, i, i, i, &w260 .R4)'
    StrCmp $R4 "." cc_haha_plain_tree_advance
    StrCmp $R4 ".." cc_haha_plain_tree_advance
    StrLen $R5 $R0
    StrLen $R6 $R4
    IntOp $R5 $R5 + $R6
    IntOp $R5 $R5 + 1
    IntCmp $R5 ${NSIS_MAX_STRLEN} cc_haha_plain_tree_close 0 cc_haha_plain_tree_close
    IntOp $ccHahaCompatTreeEntries $ccHahaCompatTreeEntries + 1
    Push "$R0\$R4"
    Call CcHahaCompatPlainTree
    StrCmp $ccHahaCompatTreeResult 1 0 cc_haha_plain_tree_close
  cc_haha_plain_tree_advance:
    StrCpy $ccHahaCompatTreeResult 0
    System::Call 'kernel32::FindNextFileW(p R1, p R2) i.R5 ?e'
    Pop $R6
    StrCmp $R5 0 0 cc_haha_plain_tree_next
    StrCmp $R6 18 0 cc_haha_plain_tree_close
    StrCpy $ccHahaCompatTreeResult 1
  cc_haha_plain_tree_close:
    System::Call 'kernel32::FindClose(p R1) i.R5'
    ${If} $R5 == 0
      StrCpy $ccHahaCompatTreeResult 0
    ${EndIf}
  cc_haha_plain_tree_free:
    System::Free $R2
    Goto cc_haha_plain_tree_done
  cc_haha_plain_tree_safe:
    StrCpy $ccHahaCompatTreeResult 1
  cc_haha_plain_tree_done:
    IntOp $ccHahaCompatTreeDepth $ccHahaCompatTreeDepth - 1
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
FunctionEnd

!macro CcHahaCompatFileFingerprint _FILE _HASH _BYTES _FAIL
  ClearErrors
  FileOpen $R6 "${_FILE}" r
  IfErrors ${_FAIL}
  FileSeek $R6 0 END $R7
  FileClose $R6
  IfErrors ${_FAIL}
  StrCmp $R7 ${_BYTES} 0 ${_FAIL}
  ${StdUtils.HashFile} $R7 "SHA2-256" "${_FILE}"
  StrCmp $R7 "${_HASH}" 0 ${_FAIL}
!macroend

!macro CcHahaCompatIdentityBody _FAIL
  ; TokenElevation is a fixed DWORD, never a successful zero-byte size probe.
  System::Call 'advapi32::OpenProcessToken(p -1, i 8, *p .R1) i.R2'
  StrCmp $R2 0 ${_FAIL}
  StrCpy $R3 1
  StrCpy $R4 0
  System::Call 'advapi32::GetTokenInformation(p R1, i 20, *i .R3, i 4, *i .R4) i.R2'
  System::Call 'kernel32::CloseHandle(p R1) i.R5'
  StrCmp $R2 0 ${_FAIL}
  StrCmp $R3 0 0 ${_FAIL}
  StrCmp $R4 4 0 ${_FAIL}
  StrCmp $R5 0 ${_FAIL}
  !insertmacro CcHahaCompatRequireAbsent 0x80000002 "${INSTALL_REGISTRY_KEY}" 0x20119 ${_FAIL}
  !insertmacro CcHahaCompatRequireAbsent 0x80000002 "${UNINSTALL_REGISTRY_KEY}" 0x20119 ${_FAIL}
  !insertmacro CcHahaCompatRequireAbsent 0x80000002 "${INSTALL_REGISTRY_KEY}" 0x20219 ${_FAIL}
  !insertmacro CcHahaCompatRequireAbsent 0x80000002 "${UNINSTALL_REGISTRY_KEY}" 0x20219 ${_FAIL}
  !ifdef UNINSTALL_REGISTRY_KEY_2
    !insertmacro CcHahaCompatRequireAbsent 0x80000002 "${UNINSTALL_REGISTRY_KEY_2}" 0x20119 ${_FAIL}
    !insertmacro CcHahaCompatRequireAbsent 0x80000002 "${UNINSTALL_REGISTRY_KEY_2}" 0x20219 ${_FAIL}
    !insertmacro CcHahaCompatRequireAbsent 0x80000001 "${UNINSTALL_REGISTRY_KEY_2}" 0x20219 ${_FAIL}
  !endif
  !insertmacro CcHahaCompatReadUserString "${INSTALL_REGISTRY_KEY}" "InstallLocation" $R2 ${_FAIL}
  ; Different spelling can name a distinct object in a case-sensitive NTFS
  ; parent. The old source/capability root and selected target must be literal.
  StrCmpS $R2 $ccHahaCompatRoot 0 ${_FAIL}
  StrCmpS $R2 $INSTDIR 0 ${_FAIL}
  !insertmacro CcHahaCompatReadUserString "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion" $R2 ${_FAIL}
  StrCmp $R2 "0.7.8" 0 ${_FAIL}
  !insertmacro CcHahaCompatReadUserString "${UNINSTALL_REGISTRY_KEY}" "UninstallString" $R2 ${_FAIL}
  StrCmp $R2 '$\"$ccHahaCompatRoot\Uninstall Claude Code Haha.exe$\" /currentuser' 0 ${_FAIL}
  StrCmp $R2 $ccHahaCompatUninstallString 0 ${_FAIL}
  ; Do not feed option-looking directory names to option helpers through the
  ; final _?= argument in this narrowly admitted preserve-data invocation.
  StrCpy $R4 0
  StrCpy $R2 $ccHahaCompatRoot 2 $R4
  ${While} $R2 != ""
    StrCmp $R2 "--" ${_FAIL}
    IntOp $R4 $R4 + 1
    StrCpy $R2 $ccHahaCompatRoot 2 $R4
  ${EndWhile}
  ; HKCU\Software can be shared between registry views. If a 32-bit view is
  ; present, it must describe exactly the same installation, never a second one.
  !insertmacro CcHahaCompatCheckUser32 "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$ccHahaCompatRoot" ${_FAIL}
  !insertmacro CcHahaCompatCheckUser32 "${UNINSTALL_REGISTRY_KEY}" "UninstallString" "$ccHahaCompatUninstallString" ${_FAIL}
  !insertmacro CcHahaCompatCheckUser32 "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion" "0.7.8" ${_FAIL}
  ReadEnvStr $R2 CLAUDE_CONFIG_DIR
  StrCmp $R2 "" 0 ${_FAIL}
  ReadEnvStr $R2 CC_HAHA_APP_PORTABLE_DIR
  StrCmp $R2 "" 0 ${_FAIL}
  ReadEnvStr $R2 APPDATA
  StrCmp $R2 "" ${_FAIL}
  System::Call 'kernel32::GetFileAttributesW(w R2) i.R3'
  StrCmp $R3 -1 ${_FAIL}
  IntOp $R3 $R3 & 0x10
  StrCmp $R3 16 0 ${_FAIL}
  System::Call 'kernel32::GetFileAttributesW(w "$R2\Claude Code Haha\app-mode.json") i.R3 ?e'
  Pop $R4
  ${If} $R3 == -1
    ${If} $R4 != 2
    ${AndIf} $R4 != 3
      Goto ${_FAIL}
    ${EndIf}
  ${Else}
    IntOp $R3 $R3 & 0x410
    StrCmp $R3 0 0 ${_FAIL}
  ${EndIf}
  ; Reuse the existing strict default-mode/legacy-data gate after proving the
  ; token and registry identity. Recovery success alone does not admit portable
  ; mode, an unknown app-mode.json, or a managed config override.
  Push $8
  StrCpy $8 "trusted-user"
  Call CcHahaCanSkipLegacyRecovery
  Pop $R2
  Pop $8
  StrCmp $R2 1 0 ${_FAIL}
  StrCmp $ccHahaCompatOldFile "$ccHahaCompatRoot\Uninstall Claude Code Haha.exe" 0 ${_FAIL}
  Push "$ccHahaCompatRoot"
  Call CcHahaCompatPlainRoot
  StrCmp $ccHahaCompatPlainResult 1 0 ${_FAIL}
  StrCpy $ccHahaCompatTreeDepth 0
  StrCpy $ccHahaCompatTreeEntries 0
  Push "$ccHahaCompatRoot"
  Call CcHahaCompatPlainTree
  StrCmp $ccHahaCompatTreeResult 1 0 ${_FAIL}
  !insertmacro CcHahaCompatFileFingerprint "$ccHahaCompatOldFile" "b0242b31b839cc8bf40ba4ac492004629bcf8ed28f8648d8c46b1797f7befb60" 174881 ${_FAIL}
  !insertmacro CcHahaCompatFileFingerprint "$ccHahaCompatOldCopy" "b0242b31b839cc8bf40ba4ac492004629bcf8ed28f8648d8c46b1797f7befb60" 174881 ${_FAIL}
!macroend

!macro CcHahaCompatCheckUser32 _KEY _VALUE _EXPECTED _FAIL
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "${_KEY}", i 0, i 0x20219, *p .R8) i.R9'
  ${If} $R9 == 0
    System::Call 'advapi32::RegCloseKey(p R8)'
    System::Call 'advapi32::RegGetValueW(p 0x80000001, w "${_KEY}", w "${_VALUE}", i 0x10020002, p 0, w .R7, *i ${NSIS_MAX_STRLEN}) i.R9'
    StrCmp $R9 0 0 ${_FAIL}
    StrCmp $R7 "${_EXPECTED}" 0 ${_FAIL}
  ${Else}
    StrCmp $R9 2 0 ${_FAIL}
  ${EndIf}
!macroend

; Consume no caller registers. The installer functions are emitted by the
; supported customHeader, before the vendor's install-section variables exist.
!macro CcHahaLegacyCompatFunctions
Function CcHahaCompatValidateIdentity
  System::Store S
  StrCpy $ccHahaCompatIdentity 0
  !insertmacro CcHahaCompatIdentityBody cc_haha_compat_identity_done
  StrCpy $ccHahaCompatIdentity 1
  cc_haha_compat_identity_done:
    System::Store L
FunctionEnd

Function CcHahaCompatValidateFaultAndProcesses
  System::Store S
  StrCpy $ccHahaCompatFault 0
  ; Reproduce the legacy PowerShell failure. Only an actual numeric child exit
  ; is evidence; nsExec timeout/error and every query failure stay blocked.
  nsExec::Exec /TIMEOUT=30000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -C "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"`
  Pop $R2
  ${If} $R2 == 0
    nsExec::Exec /TIMEOUT=30000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -C "if ((Get-ExecutionPolicy -Scope Process) -eq 'Restricted') { exit 1 } else { exit 0 }"`
    Pop $R2
  ${EndIf}
  System::Call 'shlwapi::StrToIntExW(w R2, i 0, *i .R3) i.R4'
  StrCmp $R4 0 cc_haha_compat_fault_done
  ${If} $R3 == 0
    StrCmp $ccHahaProcessHelperWriteBlocked 1 0 cc_haha_compat_fault_done
    !insertmacro CcHahaWriteInstallProcessHelper "$PLUGINSDIR\cc-haha-compat-process-check.ps1" $R3
    StrCmp $R3 1 0 cc_haha_compat_fault_done
  ${EndIf}
  Delete "$PLUGINSDIR\cc-haha-processes.csv"
  nsExec::Exec /TIMEOUT=30000 '"$SYSDIR\cmd.exe" /D /C tasklist /FO CSV /NH > "$PLUGINSDIR\cc-haha-processes.csv"'
  Pop $R0
  StrCmp $R0 0 0 cc_haha_compat_fault_done
  !insertmacro CcHahaFilterFallbackProcesses "${APP_EXECUTABLE_FILENAME}" "$PLUGINSDIR\cc-haha-processes.csv" $R0 $ccHahaFallbackOutput
  ; At least one original name hit must be an external shared helper. No hit
  ; cannot reproduce this old-uninstaller defect; unknown results also stop.
  StrCmp $R0 0 0 cc_haha_compat_fault_done
  StrCpy $ccHahaCompatExternalMatch 0
  !insertmacro CcHahaAttributeFallbackMatches "${APP_EXECUTABLE_FILENAME}" $R0
  StrCmp $R0 1 0 cc_haha_compat_fault_done
  !insertmacro CcHahaVerifyFallbackRemainder "${APP_EXECUTABLE_FILENAME}" $R0 "$SYSDIR\cmd.exe"
  StrCmp $R0 1 0 cc_haha_compat_fault_done
  StrCmp $ccHahaCompatExternalMatch 1 0 cc_haha_compat_fault_done
  StrCpy $ccHahaCompatFault 1
  cc_haha_compat_fault_done:
    System::Store L
FunctionEnd

Function CcHahaCompatValidateRemoval
  System::Store S
  StrCpy $ccHahaCompatIdentity 0
  !insertmacro CcHahaCompatRequireAbsent 0x80000001 "${INSTALL_REGISTRY_KEY}" 0x20119 cc_haha_compat_removal_done
  !insertmacro CcHahaCompatRequireAbsent 0x80000001 "${UNINSTALL_REGISTRY_KEY}" 0x20119 cc_haha_compat_removal_done
  !insertmacro CcHahaCompatRequireAbsent 0x80000001 "${INSTALL_REGISTRY_KEY}" 0x20219 cc_haha_compat_removal_done
  !insertmacro CcHahaCompatRequireAbsent 0x80000001 "${UNINSTALL_REGISTRY_KEY}" 0x20219 cc_haha_compat_removal_done
  !insertmacro CcHahaCompatRequireAbsent 0x80000002 "${INSTALL_REGISTRY_KEY}" 0x20119 cc_haha_compat_removal_done
  !insertmacro CcHahaCompatRequireAbsent 0x80000002 "${UNINSTALL_REGISTRY_KEY}" 0x20119 cc_haha_compat_removal_done
  !insertmacro CcHahaCompatRequireAbsent 0x80000002 "${INSTALL_REGISTRY_KEY}" 0x20219 cc_haha_compat_removal_done
  !insertmacro CcHahaCompatRequireAbsent 0x80000002 "${UNINSTALL_REGISTRY_KEY}" 0x20219 cc_haha_compat_removal_done
  !ifdef UNINSTALL_REGISTRY_KEY_2
    !insertmacro CcHahaCompatRequireAbsent 0x80000001 "${UNINSTALL_REGISTRY_KEY_2}" 0x20119 cc_haha_compat_removal_done
    !insertmacro CcHahaCompatRequireAbsent 0x80000001 "${UNINSTALL_REGISTRY_KEY_2}" 0x20219 cc_haha_compat_removal_done
    !insertmacro CcHahaCompatRequireAbsent 0x80000002 "${UNINSTALL_REGISTRY_KEY_2}" 0x20119 cc_haha_compat_removal_done
    !insertmacro CcHahaCompatRequireAbsent 0x80000002 "${UNINSTALL_REGISTRY_KEY_2}" 0x20219 cc_haha_compat_removal_done
  !endif
  System::Call 'kernel32::GetFileAttributesW(w "$ccHahaCompatRoot") i.R1 ?e'
  Pop $R2
  ${If} $R1 == -1
    StrCmp $R2 2 cc_haha_compat_removal_safe
    StrCmp $R2 3 cc_haha_compat_removal_safe cc_haha_compat_removal_done
  ${EndIf}
  ; The parent installer's current directory may keep an empty root open.
  Push "$ccHahaCompatRoot"
  Call CcHahaCompatPlainRoot
  StrCmp $ccHahaCompatPlainResult 1 0 cc_haha_compat_removal_done
  StrCpy $ccHahaCompatTreeDepth 0
  StrCpy $ccHahaCompatTreeEntries 0
  Push "$ccHahaCompatRoot"
  Call CcHahaCompatPlainTree
  StrCmp $ccHahaCompatTreeResult 1 0 cc_haha_compat_removal_done
  StrCmp $ccHahaCompatTreeEntries 0 0 cc_haha_compat_removal_done
  cc_haha_compat_removal_safe:
    StrCpy $ccHahaCompatIdentity 1
  cc_haha_compat_removal_done:
    System::Store L
FunctionEnd

Function CcHahaTryTrustedLegacyRemoval
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  !insertmacro CcHahaTrustedLegacyRemovalBody
  ; Also release capabilities when the old uninstaller succeeded, failed with
  ; another exit, or failed admission. They must never pin the next install.
  Call CcHahaGuardDiscard
  ${If} $ccHahaGuardOk != 1
    StrCpy $R0 22
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
FunctionEnd
!macroend

; Inserted after the vendor copyFile and before its retry counter. Preserve
; the original launch path and retry behavior for every unrecognized case.
!macro CcHahaPrepareLegacyCompat
  Push $R9
  StrCpy $R9 0
  IfErrors 0 +2
    StrCpy $R9 1
  StrCpy $ccHahaCompatReady 0
  StrCpy $ccHahaCompatFirstExit22 0
  ${If} $R9 == 0
  ${AndIf} $ccHahaCompatAttempted != 1
  ${AndIf} $ccHahaRecoveryDone == 1
  ${AndIf} $installMode == "CurrentUser"
  ${AndIfNot} ${UAC_IsAdmin}
  ${AndIfNot} ${UAC_IsInnerInstance}
  ${AndIfNot} ${isDeleteAppData}
  ${AndIf} "${APP_GUID}" == "f01cf2f0-8fe7-55b9-af4b-027bcf9c2cfe"
  ${AndIf} "${UNINSTALL_APP_KEY}" == "f01cf2f0-8fe7-55b9-af4b-027bcf9c2cfe"
  ${AndIf} "${INSTALL_REGISTRY_KEY}" == "Software\f01cf2f0-8fe7-55b9-af4b-027bcf9c2cfe"
  ${AndIf} "${UNINSTALL_REGISTRY_KEY}" == "Software\Microsoft\Windows\CurrentVersion\Uninstall\f01cf2f0-8fe7-55b9-af4b-027bcf9c2cfe"
  ${AndIf} "${PRODUCT_FILENAME}" == "Claude Code Haha"
  ${AndIf} "${APP_FILENAME}" == "Claude Code Haha"
  ${AndIf} ${IsNativeAMD64}
    ${If} $rootKey == "SHELL_CONTEXT"
    ${OrIf} $rootKey == "HKEY_CURRENT_USER"
      StrCpy $ccHahaCompatRoot $installationDir
      StrCpy $ccHahaCompatOldFile $uninstallerFileName
      StrCpy $ccHahaCompatOldCopy $uninstallerFileNameTemp
      StrCpy $ccHahaCompatUninstallString $uninstallString
      Call CcHahaCompatValidateIdentity
      ${If} $ccHahaCompatIdentity == 1
        Call CcHahaCompatValidateFaultAndProcesses
        ${If} $ccHahaCompatFault == 1
          StrCpy $ccHahaGuardRoot $ccHahaCompatRoot
          Call CcHahaGuardCapture
          ${If} $ccHahaGuardOk == 1
            StrCpy $ccHahaCompatReady 1
          ${Else}
            Call CcHahaGuardDiscard
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $R9 == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $R9
!macroend

; This is the only change in CheckResult. A real first launch returning 22
; reaches the existing post-hook immediately; retry/cancel is otherwise intact.
!macro CcHahaReturnForLegacyCompat22
  Push $R9
  StrCpy $R9 0
  IfErrors 0 +2
    StrCpy $R9 1
  ${If} $R0 == 22
  ${AndIf} $R5 == 1
  ${AndIf} $ccHahaCompatReady == 1
  ${AndIf} $R9 == 0
    StrCpy $ccHahaCompatFirstExit22 1
    Pop $R9
    ClearErrors
    Return
  ${EndIf}
  ${If} $R9 == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $R9
!macroend

!macro CcHahaTrustedLegacyRemovalBody
  ${If} $R0 == 22
  ${AndIf} $ccHahaCompatFirstExit22 == 1
  ${AndIf} $ccHahaCompatAttempted != 1
  ${AndIfNot} ${Errors}
    StrCpy $ccHahaCompatAttempted 1
    ; These are the original pre-old-launch objects, not replacement paths.
    Call CcHahaGuardRevalidate
    ${If} $ccHahaGuardOk != 1
      Goto cc_haha_compat_replacement_failed
    ${EndIf}
    Call CcHahaCompatValidateIdentity
    ${If} $ccHahaCompatIdentity == 1
      Call CcHahaCompatValidateFaultAndProcesses
      ${If} $ccHahaCompatFault == 1
        InitPluginsDir
        ; Bound at compilation to the generated, already signed current
        ; uninstaller. Never source this from the old install directory.
        ClearErrors
        File /oname=$PLUGINSDIR\cc-haha-current-uninstaller.exe "${UNINSTALLER_OUT_FILE}"
        IfErrors cc_haha_compat_replacement_failed
        !insertmacro CcHahaCompatFileFingerprint "$PLUGINSDIR\cc-haha-current-uninstaller.exe" "${CC_HAHA_CURRENT_UNINSTALLER_SHA256}" ${CC_HAHA_CURRENT_UNINSTALLER_BYTES} cc_haha_compat_replacement_failed
        ClearErrors
        StrCpy $ccHahaGuardApplication "$PLUGINSDIR\cc-haha-current-uninstaller.exe"
        StrCpy $ccHahaGuardExtraArguments "/S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated"
        StrCpy $ccHahaGuardIsUninstaller 1
        StrCpy $ccHahaGuardExpectedHash "${CC_HAHA_CURRENT_UNINSTALLER_SHA256}"
        StrCpy $ccHahaGuardExpectedBytes ${CC_HAHA_CURRENT_UNINSTALLER_BYTES}
        StrCpy $ccHahaGuardConfigHash ""
        StrCpy $ccHahaGuardConfigBytes 0
        Call CcHahaGuardLaunch
        StrCpy $R0 $ccHahaGuardExit
        ${If} $R0 == 0
          Call CcHahaCompatValidateRemoval
          ${If} $ccHahaCompatIdentity == 1
            DetailPrint "The pinned legacy uninstaller returned 22 for external helpers; the current uninstaller completed trusted per-user removal."
            ClearErrors
          ${Else}
            StrCpy $R0 22
          ${EndIf}
        ${Else}
          DetailPrint "Trusted legacy removal did not complete (exit code $R0); stopping setup."
          StrCpy $R0 22
          ClearErrors
        ${EndIf}
        Goto cc_haha_compat_replacement_done
        cc_haha_compat_replacement_failed:
          ; Retain failure even if a failed launch left a stale zero exit code.
          StrCpy $R0 22
          SetErrors
        cc_haha_compat_replacement_done:
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
!endif
