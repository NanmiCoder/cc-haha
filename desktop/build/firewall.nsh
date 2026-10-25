; firewall.nsh — cc-haha H5 LAN firewall rules for the Windows installer (Win10/Win11).
;
; The H5 phone-access port is chosen at runtime (fixedPort setting or a
; sticky ephemeral port), so install time cannot know it. Instead of a
; port-scoped rule, create inbound allow rules scoped to the installed
; executables (main app + bundled claude-sidecar binaries); Windows matches
; the rule to whatever port those programs listen on. Scope is LocalSubnet,
; mirroring the manual fix-cc-haha-h5(admin).ps1 helper.
;
; Best-effort by design: per-user installs run without administrator rights,
; and security software may block netsh, so a failure must never abort setup.

!include "LogicLib.nsh"

!define CC_HAHA_FW_RULE_NAME "Claude Code Haha H5 (LAN)"

; Add one program-scoped inbound allow rule, skipping silently when the
; executable is absent from this package (e.g. the other Windows arch).
!macro CcHahaFwAddRule _TAG _PROGRAM
  IfFileExists "${_PROGRAM}" cc_haha_fw_add_${_TAG} 0
  Goto cc_haha_fw_done_${_TAG}

  cc_haha_fw_add_${_TAG}:
    nsExec::ExecToStack '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="${CC_HAHA_FW_RULE_NAME}" dir=in action=allow program="${_PROGRAM}" remoteip=localsubnet profile=any enable=yes description="cc-haha H5 LAN access (localsubnet only)"'
    Pop $R0
    Pop $R1
    ${If} $R0 != 0
      DetailPrint "Firewall rule was not created for ${_PROGRAM} (netsh exit $R0): $R1"
      DetailPrint "Administrator rights are required; run fix-cc-haha-h5(admin).ps1 as administrator to set it up later."
    ${Else}
      DetailPrint "Firewall rule added: ${CC_HAHA_FW_RULE_NAME} -> ${_PROGRAM}"
    ${EndIf}

  cc_haha_fw_done_${_TAG}:
!macroend

; Delete every rule carrying the shared display name. Fresh installs have no
; rule to delete and netsh exits non-zero, so the failure is only reported
; when _REPORT is 1 (uninstall); install/update treat it as cleanup.
!macro CcHahaFwDeleteRules _REPORT
  nsExec::ExecToStack '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="${CC_HAHA_FW_RULE_NAME}"'
  Pop $R0
  Pop $R1
  ${If} $R0 == 0
    DetailPrint "Removed firewall rule ${CC_HAHA_FW_RULE_NAME}."
  ${ElseIf} ${_REPORT} == 1
    DetailPrint "Firewall rule ${CC_HAHA_FW_RULE_NAME} was not removed (netsh exit $R0): $R1"
    DetailPrint "Remove it manually if it is no longer wanted."
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
!macro customInstall
  ; Recreate the rules on every install/update so the stored program paths
  ; always match the current installation directory.
  !insertmacro CcHahaFwDeleteRules 0
  !insertmacro CcHahaFwAddRule app "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !insertmacro CcHahaFwAddRule sidecar_x64 "$INSTDIR\resources\app.asar.unpacked\src-tauri\binaries\claude-sidecar-x86_64-pc-windows-msvc.exe"
  !insertmacro CcHahaFwAddRule sidecar_arm64 "$INSTDIR\resources\app.asar.unpacked\src-tauri\binaries\claude-sidecar-aarch64-pc-windows-msvc.exe"
  !insertmacro CcHahaFwAddRule sidecar_legacy "$INSTDIR\resources\app.asar.unpacked\src-tauri\binaries\claude-sidecar.exe"
!macroend
!endif

!ifdef BUILD_UNINSTALLER
!macro customUnInstall
  !insertmacro CcHahaFwDeleteRules 1
!macroend
!endif
