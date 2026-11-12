; Frozen original PR #1883 macro for the unresolved-root before/after regression.
; Source commit: 2e3905a51bdc24e7b9b08b6e049020b316eb9166
; Source installer.nsh Git blob: 7634363949820a26a8aa7c479402b53b7d2c2a7d
; Only its OS call boundaries are instrumented by the native test harness.
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
