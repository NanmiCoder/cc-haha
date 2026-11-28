; Frozen real production macro definitions before residual-match protection.
; Source: 3babd7615c2a4abf6408e5d50d3a2615ce429dce:desktop/build/installer.nsh
; SHA256 of the three LF-normalized definitions joined by one LF: 036389dcf8b0d94a5acb344453b5b18439d7a94dd71a5928aab98a99de76bb19
; Source-only NSIS fixture; not a released installer or uninstaller.

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
