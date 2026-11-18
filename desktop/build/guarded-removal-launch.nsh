!ifndef CC_HAHA_GUARDED_REMOVAL_LAUNCH
!define CC_HAHA_GUARDED_REMOVAL_LAUNCH

!ifdef BUILD_UNINSTALLER
  !define CC_HAHA_GUARD_PREFIX "un."
!else
  !define CC_HAHA_GUARD_PREFIX ""
!endif

!ifdef BUILD_UNINSTALLER
Var ccHahaGuardMode
Var ccHahaGuardEntryError
!endif
Var ccHahaGuardRoot
Var ccHahaGuardCapabilities
Var ccHahaGuardHandles
Var ccHahaGuardCount
Var ccHahaGuardOk
Var ccHahaGuardPath
Var ccHahaGuardPathOffset
Var ccHahaGuardIdentity
Var ccHahaGuardInformation
Var ccHahaGuardStandard
Var ccHahaGuardApplication
Var ccHahaGuardExtraArguments
Var ccHahaGuardIsUninstaller
Var ccHahaGuardExpectedHash
Var ccHahaGuardExpectedBytes
Var ccHahaGuardConfigHash
Var ccHahaGuardConfigBytes
Var ccHahaGuardCode
Var ccHahaGuardConfig
Var ccHahaGuardCodeDirectories
Var ccHahaGuardCodeDirectoryCount
Var ccHahaGuardAttributes
Var ccHahaGuardAttributesInitialized
Var ccHahaGuardList
Var ccHahaGuardStartup
Var ccHahaGuardProcessInformation
Var ccHahaGuardEnvironment
Var ccHahaGuardProcess
Var ccHahaGuardThread
Var ccHahaGuardResumed
Var ccHahaGuardExit
Var ccHahaGuardCommand
Var ccHahaGuardParent
Var ccHahaGuardParentArguments
Var ccHahaGuardOwnProcess
Var ccHahaGuardProcessTimes
!ifdef BUILD_UNINSTALLER
Var ccHahaGuardParentRecord
Var ccHahaGuardParentPid
Var ccHahaGuardParentLow
Var ccHahaGuardParentHigh
!endif

; Every directory capability is its original READ_ATTRIBUTES/shareALL/nofollow
; handle plus volume/file ID DWORDs. Only real handles enter the inherited list.
; Bounds reject oversized paths/chains instead of truncating either CLI.
!define CC_HAHA_GUARD_MAX_DIRECTORIES 32
!define CC_HAHA_GUARD_RECORD_BYTES 16
!define CC_HAHA_GUARD_BUFFER_BYTES 512

!macro CcHahaGuardFunctions
Function ${CC_HAHA_GUARD_PREFIX}CcHahaGuardCheckParent
  System::Store S
  StrCpy $ccHahaGuardOk 1
  ${If} $ccHahaGuardParent != ""
  ${AndIf} $ccHahaGuardParent != 0
    System::Call 'kernel32::WaitForSingleObject(p $ccHahaGuardParent, i 0) i.R0'
    ${If} $R0 != 258
      StrCpy $ccHahaGuardOk 0
    ${EndIf}
  ${EndIf}
  System::Store L
FunctionEnd

Function ${CC_HAHA_GUARD_PREFIX}CcHahaGuardCloseWeak
  System::Store S
  StrCpy $ccHahaGuardOk 1
  StrCpy $R0 0
  ${While} $R0 < $ccHahaGuardCount
    IntOp $R1 $R0 * ${CC_HAHA_GUARD_RECORD_BYTES}
    IntOp $R1 $R1 + $ccHahaGuardHandles
    System::Call '*$R1(p .R2)'
    ${If} $R2 != 0
      System::Call 'kernel32::CloseHandle(p R2) i.R3'
      ${If} $R3 == 0
        StrCpy $ccHahaGuardOk 0
      ${Else}
        System::Call '*$R1(p 0)'
      ${EndIf}
    ${EndIf}
    IntOp $R0 $R0 + 1
  ${EndWhile}
  System::Store L
FunctionEnd

Function ${CC_HAHA_GUARD_PREFIX}CcHahaGuardFreeWeak
  Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardCloseWeak
  ${If} $ccHahaGuardOk == 1
    System::Free $ccHahaGuardHandles
    StrCpy $ccHahaGuardHandles 0
    StrCpy $ccHahaGuardCount 0
  ${EndIf}
FunctionEnd

Function ${CC_HAHA_GUARD_PREFIX}CcHahaGuardDiscard
  Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardFreeWeak
  System::Free $ccHahaGuardInformation
  System::Free $ccHahaGuardStandard
  StrCpy $ccHahaGuardInformation 0
  StrCpy $ccHahaGuardStandard 0
FunctionEnd

; The path iterator is shared by capture and revalidation. It emits exactly
; drive-root, each ancestor, and the leaf installation directory.
Function ${CC_HAHA_GUARD_PREFIX}CcHahaGuardNextPath
  StrCpy $ccHahaGuardPath ""
  cc_haha_guard_path_next:
    StrCpy $R0 $ccHahaGuardRoot 1 $ccHahaGuardPathOffset
    ${If} $R0 == "\"
    ${OrIf} $R0 == ""
      StrCpy $ccHahaGuardPath $ccHahaGuardRoot $ccHahaGuardPathOffset
      ${If} $ccHahaGuardPathOffset == 2
        StrCpy $ccHahaGuardPath "$ccHahaGuardPath\"
      ${EndIf}
      IntOp $ccHahaGuardPathOffset $ccHahaGuardPathOffset + 1
      Return
    ${EndIf}
    IntOp $ccHahaGuardPathOffset $ccHahaGuardPathOffset + 1
    Goto cc_haha_guard_path_next
FunctionEnd

; R1 is the existing capability, not a path reopen. R2/R3/R4 receive its
; volume/idlow/idhigh only after attributes, delete-pending and canonical checks.
Function ${CC_HAHA_GUARD_PREFIX}CcHahaGuardReadIdentity
  StrCpy $ccHahaGuardIdentity 0
  System::Call 'kernel32::GetFileType(p R1) i.R5'
  StrCmp $R5 1 0 cc_haha_guard_identity_done
  System::Call 'kernel32::GetFileInformationByHandle(p R1, p $ccHahaGuardInformation) i.R5'
  StrCmp $R5 0 cc_haha_guard_identity_done
  System::Call '*$ccHahaGuardInformation(i.R5, i, i, i, i, i, i, i.R2, i, i, i, i.R4, i.R3)'
  IntOp $R5 $R5 & 0x410
  StrCmp $R5 16 0 cc_haha_guard_identity_done
  ${If} $R3 == 0
  ${AndIf} $R4 == 0
    Goto cc_haha_guard_identity_done
  ${EndIf}
  System::Call 'kernel32::GetFileInformationByHandleEx(p R1, i 1, p $ccHahaGuardStandard, i 24) i.R5'
  StrCmp $R5 0 cc_haha_guard_identity_done
  System::Call '*$ccHahaGuardStandard(l, l, i, &i1.R5, &i1.R6)'
  StrCmp $R5 0 0 cc_haha_guard_identity_done
  StrCmp $R6 1 0 cc_haha_guard_identity_done
  System::Call 'kernel32::GetFinalPathNameByHandleW(p R1, w .R5, i ${NSIS_MAX_STRLEN}, i 0) i.R6'
  IntCmp $R6 0 cc_haha_guard_identity_done cc_haha_guard_identity_done 0
  IntCmp $R6 ${NSIS_MAX_STRLEN} cc_haha_guard_identity_done 0 cc_haha_guard_identity_done
  StrCmp $R5 "\\?\$ccHahaGuardPath" 0 cc_haha_guard_identity_done
  StrCpy $ccHahaGuardIdentity 1
  cc_haha_guard_identity_done:
FunctionEnd

Function ${CC_HAHA_GUARD_PREFIX}CcHahaGuardAllocate
  StrCpy $ccHahaGuardOk 0
  ${If} $ccHahaGuardHandles == ""
    StrCpy $ccHahaGuardHandles 0
  ${EndIf}
  StrCmp $ccHahaGuardHandles 0 0 cc_haha_guard_allocate_done
  System::Alloc ${CC_HAHA_GUARD_BUFFER_BYTES}
  Pop $ccHahaGuardHandles
  System::Alloc 52
  Pop $ccHahaGuardInformation
  System::Alloc 24
  Pop $ccHahaGuardStandard
  StrCpy $ccHahaGuardCount 0
  StrCmp $ccHahaGuardHandles 0 cc_haha_guard_allocate_done
  StrCmp $ccHahaGuardInformation 0 cc_haha_guard_allocate_done
  StrCmp $ccHahaGuardStandard 0 cc_haha_guard_allocate_done
  StrCpy $ccHahaGuardOk 1
  cc_haha_guard_allocate_done:
FunctionEnd

!ifndef BUILD_UNINSTALLER
Function ${CC_HAHA_GUARD_PREFIX}CcHahaGuardCapture
  System::Store S
  Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardValidateRoot
  StrCmp $ccHahaGuardOk 1 0 cc_haha_guard_capture_done
  Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardAllocate
  StrCmp $ccHahaGuardOk 1 0 cc_haha_guard_capture_done
  StrCpy $ccHahaGuardOk 0
  StrCpy $ccHahaGuardCapabilities ""
  StrCpy $ccHahaGuardPathOffset 2
  cc_haha_guard_capture_next:
    IntCmp $ccHahaGuardCount ${CC_HAHA_GUARD_MAX_DIRECTORIES} cc_haha_guard_capture_done 0 cc_haha_guard_capture_done
    Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardNextPath
    System::Call 'kernel32::CreateFileW(w "$ccHahaGuardPath", i 0x80, i 7, p 0, i 3, i 0x2200000, p 0) p.R1'
    StrCmp $R1 -1 cc_haha_guard_capture_done
    StrCmp $R1 0 cc_haha_guard_capture_done
    IntOp $R7 $ccHahaGuardCount * ${CC_HAHA_GUARD_RECORD_BYTES}
    IntOp $R7 $R7 + $ccHahaGuardHandles
    System::Call '*$R7(p R1, i 0, i 0, i 0)'
    IntOp $ccHahaGuardCount $ccHahaGuardCount + 1
    Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardReadIdentity
    StrCmp $ccHahaGuardIdentity 1 0 cc_haha_guard_capture_done
    System::Call '*$R7(p R1, i R2, i R3, i R4)'
    IntFmt $R1 "%u" $R1
    IntFmt $R2 "%u" $R2
    IntFmt $R3 "%u" $R3
    IntFmt $R4 "%u" $R4
    StrCpy $R8 "$R1:$R2:$R3:$R4"
    StrLen $R5 $R8
    StrLen $R6 $ccHahaGuardCapabilities
    IntOp $R5 $R5 + $R6
    IntOp $R5 $R5 + 2
    IntCmp $R5 ${NSIS_MAX_STRLEN} cc_haha_guard_capture_done 0 cc_haha_guard_capture_done
    ${If} $ccHahaGuardCapabilities == ""
      StrCpy $ccHahaGuardCapabilities $R8
    ${Else}
      StrCpy $ccHahaGuardCapabilities "$ccHahaGuardCapabilities,$R8"
    ${EndIf}
    StrCmp $ccHahaGuardPath $ccHahaGuardRoot 0 cc_haha_guard_capture_next
    StrCpy $ccHahaGuardOk 1
  cc_haha_guard_capture_done:
    System::Store L
FunctionEnd
!endif

Function ${CC_HAHA_GUARD_PREFIX}CcHahaGuardValidateRoot
  System::Store S
  StrCpy $ccHahaGuardOk 0
  StrLen $R0 $ccHahaGuardRoot
  IntCmp $R0 3 cc_haha_guard_root_done cc_haha_guard_root_done 0
  StrCpy $R1 $ccHahaGuardRoot 2 1
  StrCmp $R1 ":\" 0 cc_haha_guard_root_done
  StrCpy $R1 $ccHahaGuardRoot 3
  System::Call 'kernel32::GetDriveTypeW(w R1) i.R2'
  StrCmp $R2 3 0 cc_haha_guard_root_done
  IntOp $R0 $R0 - 1
  StrCpy $R1 $ccHahaGuardRoot 1 $R0
  StrCmp $R1 "\" cc_haha_guard_root_done
  StrCpy $R0 0
  cc_haha_guard_root_character:
    StrCpy $R1 $ccHahaGuardRoot 1 $R0
    StrCmp $R1 "" cc_haha_guard_root_safe
    StrCmp $R1 '$\"' cc_haha_guard_root_done
    StrCmp $R1 "$\r" cc_haha_guard_root_done
    StrCmp $R1 "$\n" cc_haha_guard_root_done
    StrCmp $R1 "$\t" cc_haha_guard_root_done
    StrCpy $R1 $ccHahaGuardRoot 2 $R0
    StrCmp $R1 "--" cc_haha_guard_root_done
    IntOp $R0 $R0 + 1
    Goto cc_haha_guard_root_character
  cc_haha_guard_root_safe:
    StrCpy $ccHahaGuardOk 1
  cc_haha_guard_root_done:
    System::Store L
FunctionEnd

Function ${CC_HAHA_GUARD_PREFIX}CcHahaGuardRevalidate
  System::Store S
  StrCpy $ccHahaGuardOk 0
  StrCpy $ccHahaGuardPathOffset 2
  StrCpy $R8 0
  cc_haha_guard_revalidate_next:
    IntCmp $R8 $ccHahaGuardCount cc_haha_guard_revalidate_done 0 cc_haha_guard_revalidate_done
    Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardNextPath
    IntOp $R7 $R8 * ${CC_HAHA_GUARD_RECORD_BYTES}
    IntOp $R7 $R7 + $ccHahaGuardHandles
    System::Call '*$R7(p.R1)'
    StrCmp $R1 0 cc_haha_guard_revalidate_done
    Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardReadIdentity
    StrCmp $ccHahaGuardIdentity 1 0 cc_haha_guard_revalidate_done
    System::Call '*$R7(p, i.R5, i.R6, i.R9)'
    StrCmp $R2 $R5 0 cc_haha_guard_revalidate_done
    StrCmp $R3 $R6 0 cc_haha_guard_revalidate_done
    StrCmp $R4 $R9 0 cc_haha_guard_revalidate_done
    IntOp $R8 $R8 + 1
    StrCmp $ccHahaGuardPath $ccHahaGuardRoot 0 cc_haha_guard_revalidate_next
    StrCmp $R8 $ccHahaGuardCount 0 cc_haha_guard_revalidate_done
    StrCpy $ccHahaGuardOk 1
  cc_haha_guard_revalidate_done:
    System::Store L
FunctionEnd

; A canonical uint32 parser. No StrToInt fallback, signed values, overflow,
; whitespace, exponent or truncated number is accepted from the child CLI.
!ifdef BUILD_UNINSTALLER
Function ${CC_HAHA_GUARD_PREFIX}CcHahaGuardParseDword
  StrCpy $R9 0
  StrLen $R5 $R2
  IntCmp $R5 0 cc_haha_guard_uint_done cc_haha_guard_uint_done 0
  IntCmp $R5 10 0 0 cc_haha_guard_uint_done
  StrCpy $R6 $R2 1
  ${If} $R6 == "0"
  ${AndIf} $R5 != 1
    Goto cc_haha_guard_uint_done
  ${EndIf}
  StrCpy $R5 0
  cc_haha_guard_uint_digit:
    StrCpy $R6 $R2 1 $R5
    StrCmp $R6 "" cc_haha_guard_uint_bound
    StrCmp $R6 "0" cc_haha_guard_uint_advance
    StrCmp $R6 "1" cc_haha_guard_uint_advance
    StrCmp $R6 "2" cc_haha_guard_uint_advance
    StrCmp $R6 "3" cc_haha_guard_uint_advance
    StrCmp $R6 "4" cc_haha_guard_uint_advance
    StrCmp $R6 "5" cc_haha_guard_uint_advance
    StrCmp $R6 "6" cc_haha_guard_uint_advance
    StrCmp $R6 "7" cc_haha_guard_uint_advance
    StrCmp $R6 "8" cc_haha_guard_uint_advance
    StrCmp $R6 "9" 0 cc_haha_guard_uint_done
    cc_haha_guard_uint_advance:
      IntOp $R5 $R5 + 1
      Goto cc_haha_guard_uint_digit
  cc_haha_guard_uint_bound:
    System::Int64Op $R2 <= 4294967295
    Pop $R9
  cc_haha_guard_uint_done:
FunctionEnd
!endif

; Private extraction remains within the existing NSIS same-SID trust boundary.
; Held nonreparse ancestor, code and config handles prevent ordinary rename,
; rewrite or delete of the exact verified launch resources while they are used.
Function ${CC_HAHA_GUARD_PREFIX}CcHahaGuardPinCode
  System::Store S
  StrCpy $ccHahaGuardOk 0
  System::Alloc 128
  Pop $ccHahaGuardCodeDirectories
  StrCmp $ccHahaGuardCodeDirectories 0 cc_haha_guard_code_done
  StrCpy $ccHahaGuardCodeDirectoryCount 0
  StrCpy $R9 $ccHahaGuardRoot
  StrCpy $ccHahaGuardRoot $PLUGINSDIR
  StrCpy $ccHahaGuardPathOffset 2
  cc_haha_guard_code_directory:
    IntCmp $ccHahaGuardCodeDirectoryCount ${CC_HAHA_GUARD_MAX_DIRECTORIES} cc_haha_guard_code_root_done 0 cc_haha_guard_code_root_done
    Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardNextPath
    System::Call 'kernel32::CreateFileW(w "$ccHahaGuardPath", i 0x80, i 3, p 0, i 3, i 0x2200000, p 0) p.R1'
    StrCmp $R1 -1 cc_haha_guard_code_root_done
    StrCmp $R1 0 cc_haha_guard_code_root_done
    IntOp $R7 $ccHahaGuardCodeDirectoryCount * 4
    IntOp $R7 $R7 + $ccHahaGuardCodeDirectories
    System::Call '*$R7(p R1)'
    IntOp $ccHahaGuardCodeDirectoryCount $ccHahaGuardCodeDirectoryCount + 1
    Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardReadIdentity
    StrCmp $ccHahaGuardIdentity 1 0 cc_haha_guard_code_root_done
    StrCmp $ccHahaGuardPath $ccHahaGuardRoot 0 cc_haha_guard_code_directory
    System::Call 'kernel32::CreateFileW(w "$ccHahaGuardApplication", i 0x81, i 1, p 0, i 3, i 0x2200000, p 0) p.R1'
    StrCpy $ccHahaGuardCode $R1
    StrCmp $ccHahaGuardCode -1 cc_haha_guard_code_root_done
    StrCmp $ccHahaGuardCode 0 cc_haha_guard_code_root_done
    System::Call 'kernel32::GetFileInformationByHandle(p $ccHahaGuardCode, p $ccHahaGuardInformation) i.R1'
    StrCmp $R1 0 cc_haha_guard_code_root_done
    System::Call '*$ccHahaGuardInformation(i.R1)'
    IntOp $R1 $R1 & 0x410
    StrCmp $R1 0 0 cc_haha_guard_code_root_done
    System::Call 'kernel32::GetFinalPathNameByHandleW(p $ccHahaGuardCode, w .R1, i ${NSIS_MAX_STRLEN}, i 0) i.R2'
    IntCmp $R2 0 cc_haha_guard_code_root_done cc_haha_guard_code_root_done 0
    StrCmp $R1 "\\?\$ccHahaGuardApplication" 0 cc_haha_guard_code_root_done
    IntCmp $R2 ${NSIS_MAX_STRLEN} cc_haha_guard_code_root_done 0 cc_haha_guard_code_root_done
    System::Call 'kernel32::GetFileSizeEx(p $ccHahaGuardCode, *l .R1) i.R2'
    StrCmp $R2 0 cc_haha_guard_code_root_done
    StrCmp $R1 $ccHahaGuardExpectedBytes 0 cc_haha_guard_code_root_done
    ${StdUtils.HashFile} $R1 "SHA2-256" "$ccHahaGuardApplication"
    StrCmp $R1 $ccHahaGuardExpectedHash 0 cc_haha_guard_code_root_done
    ${If} $ccHahaGuardIsUninstaller != 1
      System::Call 'kernel32::CreateFileW(w "$ccHahaGuardApplication.config", i 0x81, i 1, p 0, i 3, i 0x2200000, p 0) p.R1'
      StrCpy $ccHahaGuardConfig $R1
      StrCmp $ccHahaGuardConfig -1 cc_haha_guard_code_root_done
      StrCmp $ccHahaGuardConfig 0 cc_haha_guard_code_root_done
      System::Call 'kernel32::GetFileInformationByHandle(p $ccHahaGuardConfig, p $ccHahaGuardInformation) i.R1'
      StrCmp $R1 0 cc_haha_guard_code_root_done
      System::Call '*$ccHahaGuardInformation(i.R1)'
      IntOp $R1 $R1 & 0x410
      StrCmp $R1 0 0 cc_haha_guard_code_root_done
      System::Call 'kernel32::GetFinalPathNameByHandleW(p $ccHahaGuardConfig, w .R1, i ${NSIS_MAX_STRLEN}, i 0) i.R2'
      IntCmp $R2 0 cc_haha_guard_code_root_done cc_haha_guard_code_root_done 0
      StrCmp $R1 "\\?\$ccHahaGuardApplication.config" 0 cc_haha_guard_code_root_done
      IntCmp $R2 ${NSIS_MAX_STRLEN} cc_haha_guard_code_root_done 0 cc_haha_guard_code_root_done
      System::Call 'kernel32::GetFileSizeEx(p $ccHahaGuardConfig, *l .R1) i.R2'
      StrCmp $R2 0 cc_haha_guard_code_root_done
      StrCmp $R1 $ccHahaGuardConfigBytes 0 cc_haha_guard_code_root_done
      ${StdUtils.HashFile} $R1 "SHA2-256" "$ccHahaGuardApplication.config"
      StrCmp $R1 $ccHahaGuardConfigHash 0 cc_haha_guard_code_root_done
    ${EndIf}
    ; Retained code/config keep this directory nonempty. Verify the retained
    ; directory objects again after locking those exact ordinary files.
    StrCpy $ccHahaGuardPathOffset 2
    StrCpy $R8 0
    cc_haha_guard_code_recheck:
      Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardNextPath
      IntOp $R7 $R8 * 4
      IntOp $R7 $R7 + $ccHahaGuardCodeDirectories
      System::Call '*$R7(p.R1)'
      Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardReadIdentity
      StrCmp $ccHahaGuardIdentity 1 0 cc_haha_guard_code_root_done
      IntOp $R8 $R8 + 1
      IntCmp $R8 $ccHahaGuardCodeDirectoryCount 0 cc_haha_guard_code_recheck cc_haha_guard_code_root_done
      StrCmp $ccHahaGuardPath $ccHahaGuardRoot 0 cc_haha_guard_code_root_done
      StrCpy $ccHahaGuardOk 1
  cc_haha_guard_code_root_done:
    StrCpy $ccHahaGuardRoot $R9
  cc_haha_guard_code_done:
    System::Store L
FunctionEnd

Function ${CC_HAHA_GUARD_PREFIX}CcHahaGuardUnpinCode
  System::Store S
  StrCpy $ccHahaGuardOk 1
  ${If} $ccHahaGuardCode != 0
  ${AndIf} $ccHahaGuardCode != -1
    System::Call 'kernel32::CloseHandle(p $ccHahaGuardCode) i.R0'
    ${If} $R0 == 0
      StrCpy $ccHahaGuardOk 0
    ${Else}
      StrCpy $ccHahaGuardCode 0
    ${EndIf}
  ${EndIf}
  ${If} $ccHahaGuardConfig != 0
  ${AndIf} $ccHahaGuardConfig != -1
    System::Call 'kernel32::CloseHandle(p $ccHahaGuardConfig) i.R0'
    ${If} $R0 == 0
      StrCpy $ccHahaGuardOk 0
    ${Else}
      StrCpy $ccHahaGuardConfig 0
    ${EndIf}
  ${EndIf}
  StrCpy $R0 0
  ${While} $R0 < $ccHahaGuardCodeDirectoryCount
    IntOp $R1 $R0 * 4
    IntOp $R1 $R1 + $ccHahaGuardCodeDirectories
    System::Call '*$R1(p.R2)'
    System::Call 'kernel32::CloseHandle(p R2) i.R3'
    ${If} $R3 == 0
      StrCpy $ccHahaGuardOk 0
    ${EndIf}
    IntOp $R0 $R0 + 1
  ${EndWhile}
  System::Free $ccHahaGuardCodeDirectories
  StrCpy $ccHahaGuardCodeDirectories 0
  StrCpy $ccHahaGuardCodeDirectoryCount 0
  System::Store L
FunctionEnd

Function ${CC_HAHA_GUARD_PREFIX}CcHahaGuardLaunch
  System::Store S
  StrCpy $ccHahaGuardExit 22
  StrCpy $ccHahaGuardResumed 0
  StrCpy $ccHahaGuardProcess 0
  StrCpy $ccHahaGuardThread 0
  StrCpy $ccHahaGuardAttributes 0
  StrCpy $ccHahaGuardAttributesInitialized 0
  StrCpy $ccHahaGuardList 0
  StrCpy $ccHahaGuardStartup 0
  StrCpy $ccHahaGuardProcessInformation 0
  StrCpy $ccHahaGuardEnvironment 0
  StrCpy $ccHahaGuardOwnProcess 0
  StrCpy $ccHahaGuardProcessTimes 0
  !ifndef BUILD_UNINSTALLER
    StrCpy $ccHahaGuardParent 0
  !endif
  StrCpy $ccHahaGuardCode 0
  StrCpy $ccHahaGuardConfig 0
  StrCpy $ccHahaGuardCodeDirectories 0
  StrCpy $ccHahaGuardCodeDirectoryCount 0
  ; An implicit current-directory handle in the parent must not keep the
  ; installation root delete-pending after the explicit weak handoff.
  ClearErrors
  SetOutPath $SYSDIR
  IfErrors cc_haha_guard_launch_done
  Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardCheckParent
  StrCmp $ccHahaGuardOk 1 0 cc_haha_guard_launch_done
  Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardRevalidate
  StrCmp $ccHahaGuardOk 1 0 cc_haha_guard_launch_done
  Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardPinCode
  StrCmp $ccHahaGuardOk 1 0 cc_haha_guard_launch_done
  StrLen $R0 $ccHahaGuardApplication
  StrLen $R1 $ccHahaGuardExtraArguments
  IntOp $R0 $R0 + $R1
  StrLen $R1 $ccHahaGuardRoot
  IntOp $R0 $R0 + $R1
  ${If} $ccHahaGuardIsUninstaller == 1
    IntOp $R0 $R0 + $R1
  ${EndIf}
  StrLen $R1 $ccHahaGuardCapabilities
  IntOp $R0 $R0 + $R1
  ; A real, minimally granted process capability binds the child's direct
  ; parent lifetime without pseudo handles, PID reuse or an IPC marker.
  System::Call 'kernel32::GetCurrentProcessId() i.R1'
  StrCmp $R1 0 cc_haha_guard_launch_done
  System::Call 'kernel32::OpenProcess(i 0x101000, i 1, i R1) p.R2'
  StrCpy $ccHahaGuardOwnProcess $R2
  StrCmp $ccHahaGuardOwnProcess 0 cc_haha_guard_launch_done
  System::Alloc 32
  Pop $ccHahaGuardProcessTimes
  StrCmp $ccHahaGuardProcessTimes 0 cc_haha_guard_launch_done
  IntOp $R3 $ccHahaGuardProcessTimes + 8
  IntOp $R4 $ccHahaGuardProcessTimes + 16
  IntOp $R5 $ccHahaGuardProcessTimes + 24
  System::Call 'kernel32::GetProcessTimes(p $ccHahaGuardOwnProcess, p $ccHahaGuardProcessTimes, p R3, p R4, p R5) i.R3'
  StrCmp $R3 0 cc_haha_guard_launch_done
  System::Call '*$ccHahaGuardProcessTimes(i.R3, i.R4)'
  IntFmt $R1 "%u" $R1
  IntFmt $R2 "%u" $R2
  IntFmt $R3 "%u" $R3
  IntFmt $R4 "%u" $R4
  StrCpy $ccHahaGuardParentArguments "$R2:$R1:$R3:$R4"
  StrLen $R1 $ccHahaGuardParentArguments
  IntOp $R0 $R0 + $R1
  IntOp $R0 $R0 + 102
  IntCmp $R0 ${NSIS_MAX_STRLEN} cc_haha_guard_launch_done 0 cc_haha_guard_launch_done
  StrCpy $ccHahaGuardCommand '$\"$ccHahaGuardApplication$\" $ccHahaGuardExtraArguments --cc-guarded-removal=1 --root=$\"$ccHahaGuardRoot$\" --capabilities=$\"$ccHahaGuardCapabilities$\" --parent=$\"$ccHahaGuardParentArguments$\"'
  ${If} $ccHahaGuardIsUninstaller == 1
    StrCpy $ccHahaGuardCommand "$ccHahaGuardCommand _?=$ccHahaGuardRoot"
  ${EndIf}
  ; Query/allocate/init is required; a guessed attribute-list size is invalid.
  StrCpy $R0 0
  System::Call 'kernel32::InitializeProcThreadAttributeList(p 0, i 1, i 0, *i.R0) i.R1 ?e'
  Pop $R2
  StrCmp $R1 0 0 cc_haha_guard_launch_done
  StrCmp $R2 122 0 cc_haha_guard_launch_done
  IntCmp $R0 0 cc_haha_guard_launch_done cc_haha_guard_launch_done 0
  System::Alloc $R0
  Pop $ccHahaGuardAttributes
  StrCmp $ccHahaGuardAttributes 0 cc_haha_guard_launch_done
  System::Call 'kernel32::InitializeProcThreadAttributeList(p $ccHahaGuardAttributes, i 1, i 0, *i R0) i.R1'
  StrCmp $R1 0 cc_haha_guard_launch_done
  StrCpy $ccHahaGuardAttributesInitialized 1
  IntOp $R0 $ccHahaGuardCount + 1
  IntOp $R0 $R0 * 4
  System::Alloc $R0
  Pop $ccHahaGuardList
  StrCmp $ccHahaGuardList 0 cc_haha_guard_launch_done
  StrCpy $R8 0
  ${While} $R8 < $ccHahaGuardCount
    IntOp $R1 $R8 * ${CC_HAHA_GUARD_RECORD_BYTES}
    IntOp $R1 $R1 + $ccHahaGuardHandles
    System::Call '*$R1(p.R2)'
    System::Call 'kernel32::SetHandleInformation(p R2, i 1, i 1) i.R3'
    StrCmp $R3 0 cc_haha_guard_launch_done
    IntOp $R1 $R8 * 4
    IntOp $R1 $R1 + $ccHahaGuardList
    System::Call '*$R1(p R2)'
    IntOp $R8 $R8 + 1
  ${EndWhile}
  IntOp $R1 $ccHahaGuardCount * 4
  IntOp $R1 $R1 + $ccHahaGuardList
  System::Call '*$R1(p $ccHahaGuardOwnProcess)'
  System::Call 'kernel32::UpdateProcThreadAttribute(p $ccHahaGuardAttributes, i 0, p 0x20002, p $ccHahaGuardList, i R0, p 0, p 0) i.R1'
  StrCmp $R1 0 cc_haha_guard_launch_done
  System::Alloc 72
  Pop $ccHahaGuardStartup
  StrCmp $ccHahaGuardStartup 0 cc_haha_guard_launch_done
  System::Call 'ntdll::RtlZeroMemory(p $ccHahaGuardStartup, i 72)'
  System::Call '*$ccHahaGuardStartup(i 72)'
  IntOp $R0 $ccHahaGuardStartup + 68
  System::Call '*$R0(p $ccHahaGuardAttributes)'
  System::Alloc 16
  Pop $ccHahaGuardProcessInformation
  StrCmp $ccHahaGuardProcessInformation 0 cc_haha_guard_launch_done
  System::Call 'ntdll::RtlZeroMemory(p $ccHahaGuardProcessInformation, i 16)'
  System::Alloc 32768
  Pop $ccHahaGuardEnvironment
  StrCmp $ccHahaGuardEnvironment 0 cc_haha_guard_launch_done
  System::Call 'ntdll::RtlZeroMemory(p $ccHahaGuardEnvironment, i 32768)'
  StrCpy $R7 $ccHahaGuardEnvironment
  !insertmacro CcHahaGuardEnvironmentEntry "APPDATA=$APPDATA"
  !insertmacro CcHahaGuardEnvironmentEntry "LOCALAPPDATA=$LOCALAPPDATA"
  !insertmacro CcHahaGuardEnvironmentEntry "PATH=$SYSDIR"
  !insertmacro CcHahaGuardEnvironmentEntry "SystemRoot=$WINDIR"
  !insertmacro CcHahaGuardEnvironmentEntry "TEMP=$TEMP"
  !insertmacro CcHahaGuardEnvironmentEntry "TMP=$TEMP"
  !insertmacro CcHahaGuardEnvironmentEntry "USERPROFILE=$PROFILE"
  !insertmacro CcHahaGuardEnvironmentEntry "WINDIR=$WINDIR"
  ; 32-bit NSIS: STARTUPINFOW=68, STARTUPINFOEXW=72, PI=16, HANDLE=4.
  ; The primary thread cannot run before every parent weak handle is closed.
  ; The quoted CLI is data, not part of System::Call's argument syntax.
  StrCpy $R0 $ccHahaGuardCommand
  System::Call 'kernel32::CreateProcessW(w "$ccHahaGuardApplication", w R0, p 0, p 0, i 1, i 0x8080404, p $ccHahaGuardEnvironment, w "$SYSDIR", p $ccHahaGuardStartup, p $ccHahaGuardProcessInformation) i.R0'
  StrCmp $R0 0 cc_haha_guard_launch_done
  System::Call '*$ccHahaGuardProcessInformation(p.R1, p.R2, i, i)'
  StrCpy $ccHahaGuardProcess $R1
  StrCpy $ccHahaGuardThread $R2
  StrCmp $ccHahaGuardProcess 0 cc_haha_guard_launch_done
  StrCmp $ccHahaGuardThread 0 cc_haha_guard_launch_done
  Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardCloseWeak
  StrCmp $ccHahaGuardOk 1 0 cc_haha_guard_launch_done
  System::Call 'kernel32::CloseHandle(p $ccHahaGuardOwnProcess) i.R0'
  StrCmp $R0 0 cc_haha_guard_launch_done
  StrCpy $ccHahaGuardOwnProcess 0
  Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardCheckParent
  StrCmp $ccHahaGuardOk 1 0 cc_haha_guard_launch_done
  ; Once ResumeThread is attempted, an unexpected result cannot justify
  ; killing a thread that may already have executed backend code.
  StrCpy $ccHahaGuardResumed "unknown"
  System::Call 'kernel32::ResumeThread(p $ccHahaGuardThread) i.R0'
  StrCmp $R0 1 0 cc_haha_guard_launch_done
  StrCpy $ccHahaGuardResumed 1
  cc_haha_guard_launch_wait:
    Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardCheckParent
    StrCmp $ccHahaGuardOk 1 0 cc_haha_guard_launch_done
    ; No timeout/TerminateProcess is allowed after mutation may have begun.
    System::Call 'kernel32::WaitForSingleObject(p $ccHahaGuardProcess, i 250) i.R0'
    StrCmp $R0 258 cc_haha_guard_launch_wait
    StrCmp $R0 0 0 cc_haha_guard_launch_done
    System::Call 'kernel32::GetExitCodeProcess(p $ccHahaGuardProcess, *i.R0) i.R1'
    StrCmp $R1 0 cc_haha_guard_launch_done
    StrCmp $R0 0 0 cc_haha_guard_launch_done
    Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardCheckParent
    StrCmp $ccHahaGuardOk 1 0 cc_haha_guard_launch_done
    StrCpy $ccHahaGuardExit 0
  cc_haha_guard_launch_done:
    ${If} $ccHahaGuardProcess != 0
      ${If} $ccHahaGuardResumed == 0
        ; This is solely our never-resumed child, before any backend mutation.
        System::Call 'kernel32::TerminateProcess(p $ccHahaGuardProcess, i 22) i.R0'
      ${EndIf}
      System::Call 'kernel32::CloseHandle(p $ccHahaGuardProcess) i.R0'
      ${If} $R0 == 0
        StrCpy $ccHahaGuardExit 22
      ${EndIf}
    ${EndIf}
    ${If} $ccHahaGuardThread != 0
      System::Call 'kernel32::CloseHandle(p $ccHahaGuardThread) i.R0'
      ${If} $R0 == 0
        StrCpy $ccHahaGuardExit 22
      ${EndIf}
    ${EndIf}
    ${If} $ccHahaGuardAttributesInitialized == 1
      System::Call 'kernel32::DeleteProcThreadAttributeList(p $ccHahaGuardAttributes)'
    ${EndIf}
    System::Free $ccHahaGuardAttributes
    System::Free $ccHahaGuardList
    System::Free $ccHahaGuardStartup
    System::Free $ccHahaGuardProcessInformation
    System::Free $ccHahaGuardEnvironment
    System::Free $ccHahaGuardProcessTimes
    ${If} $ccHahaGuardOwnProcess != 0
      System::Call 'kernel32::CloseHandle(p $ccHahaGuardOwnProcess) i.R0'
      ${If} $R0 == 0
        StrCpy $ccHahaGuardExit 22
      ${EndIf}
    ${EndIf}
    Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardFreeWeak
    ${If} $ccHahaGuardOk != 1
      StrCpy $ccHahaGuardExit 22
    ${EndIf}
    Call ${CC_HAHA_GUARD_PREFIX}CcHahaGuardUnpinCode
    ${If} $ccHahaGuardOk != 1
      StrCpy $ccHahaGuardExit 22
    ${EndIf}
    System::Free $ccHahaGuardInformation
    System::Free $ccHahaGuardStandard
    StrCpy $ccHahaGuardInformation 0
    StrCpy $ccHahaGuardStandard 0
    System::Store L
FunctionEnd
!macroend

!macro CcHahaGuardEnvironmentEntry _ENTRY
  StrCpy $R0 "${_ENTRY}"
  System::Call 'kernel32::lstrcpyW(p R7, w R0) p.R1'
  StrCmp $R1 $R7 0 cc_haha_guard_launch_done
  StrLen $R0 $R0
  IntOp $R0 $R0 + 1
  IntOp $R0 $R0 * 2
  IntOp $R7 $R7 + $R0
!macroend

!ifdef BUILD_UNINSTALLER
!macro CcHahaGuardUninstallerFunctions
Function un.CcHahaGuardReceiveParent
  System::Store S
  StrCpy $ccHahaGuardOk 0
  System::Alloc 16
  Pop $ccHahaGuardParentRecord
  System::Alloc 32
  Pop $ccHahaGuardProcessTimes
  StrCmp $ccHahaGuardParentRecord 0 cc_haha_guard_parent_done
  StrCmp $ccHahaGuardProcessTimes 0 cc_haha_guard_parent_done
  StrCpy $R8 0
  StrCpy $R4 0
  StrCpy $R2 ""
  cc_haha_guard_parent_character:
    StrCpy $R0 $ccHahaGuardParentArguments 1 $R8
    ${If} $R0 != ":"
    ${AndIf} $R0 != ""
      StrLen $R1 $R2
      IntCmp $R1 10 cc_haha_guard_parent_done 0 cc_haha_guard_parent_done
      StrCpy $R2 "$R2$R0"
      IntOp $R8 $R8 + 1
      Goto cc_haha_guard_parent_character
    ${EndIf}
    Call un.CcHahaGuardParseDword
    StrCmp $R9 1 0 cc_haha_guard_parent_done
    IntOp $R1 $R4 * 4
    IntOp $R1 $R1 + $ccHahaGuardParentRecord
    System::Call '*$R1(i R2)'
    IntOp $R4 $R4 + 1
    StrCpy $R2 ""
    ${If} $R4 < 4
      StrCmp $R0 ":" 0 cc_haha_guard_parent_done
      IntOp $R8 $R8 + 1
      Goto cc_haha_guard_parent_character
    ${EndIf}
    StrCmp $R0 "" 0 cc_haha_guard_parent_done
    System::Call '*$ccHahaGuardParentRecord(p.R1, i.R2, i.R3, i.R4)'
    StrCpy $ccHahaGuardParent $R1
    StrCpy $ccHahaGuardParentPid $R2
    StrCpy $ccHahaGuardParentLow $R3
    StrCpy $ccHahaGuardParentHigh $R4
    IntFmt $R1 "%u" $R1
    StrCmp $R1 0 cc_haha_guard_parent_done
    System::Int64Op $R1 >= 4294967280
    Pop $R2
    StrCmp $R2 1 cc_haha_guard_parent_done
    StrCpy $R2 0
    ${While} $R2 < $ccHahaGuardCount
      IntOp $R3 $R2 * ${CC_HAHA_GUARD_RECORD_BYTES}
      IntOp $R3 $R3 + $ccHahaGuardHandles
      System::Call '*$R3(p.R4)'
      IntFmt $R4 "%u" $R4
      StrCmp $R1 $R4 cc_haha_guard_parent_done
      IntOp $R2 $R2 + 1
    ${EndWhile}
    System::Call 'kernel32::GetHandleInformation(p $ccHahaGuardParent, *i.R0) i.R1'
    StrCmp $R1 0 cc_haha_guard_parent_done
    IntOp $R0 $R0 & 1
    StrCmp $R0 1 0 cc_haha_guard_parent_done
    System::Call 'kernel32::SetHandleInformation(p $ccHahaGuardParent, i 1, i 0) i.R0'
    StrCmp $R0 0 cc_haha_guard_parent_done
    System::Call 'kernel32::GetProcessId(p $ccHahaGuardParent) i.R0'
    StrCmp $R0 0 cc_haha_guard_parent_done
    StrCmp $R0 $ccHahaGuardParentPid 0 cc_haha_guard_parent_done
    IntOp $R1 $ccHahaGuardProcessTimes + 8
    IntOp $R2 $ccHahaGuardProcessTimes + 16
    IntOp $R3 $ccHahaGuardProcessTimes + 24
    System::Call 'kernel32::GetProcessTimes(p $ccHahaGuardParent, p $ccHahaGuardProcessTimes, p R1, p R2, p R3) i.R4'
    StrCmp $R4 0 cc_haha_guard_parent_done
    System::Call '*$ccHahaGuardProcessTimes(i.R0, i.R1)'
    StrCmp $R0 $ccHahaGuardParentLow 0 cc_haha_guard_parent_done
    StrCmp $R1 $ccHahaGuardParentHigh 0 cc_haha_guard_parent_done
    ${If} $R0 == 0
    ${AndIf} $R1 == 0
      Goto cc_haha_guard_parent_done
    ${EndIf}
    Call un.CcHahaGuardCheckParent
  cc_haha_guard_parent_done:
    System::Free $ccHahaGuardParentRecord
    System::Free $ccHahaGuardProcessTimes
    StrCpy $ccHahaGuardParentRecord 0
    StrCpy $ccHahaGuardProcessTimes 0
    System::Store L
FunctionEnd

Function un.CcHahaGuardReceive
  System::Store S
  StrCpy $ccHahaGuardEntryError 0
  IfErrors 0 +2
    StrCpy $ccHahaGuardEntryError 1
  ; Parse once, before any default CHECK_APP_RUNNING code could kill a process.
  ${If} $ccHahaGuardMode != ""
    Goto cc_haha_guard_receive_done
  ${EndIf}
  StrCpy $ccHahaGuardMode 0
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--cc-guarded-removal" $R1
  IfErrors cc_haha_guard_receive_done
  StrCpy $ccHahaGuardMode "invalid"
  StrCmp $R1 "=1" 0 cc_haha_guard_receive_done
  ClearErrors
  ${GetOptions} $R0 "--root=" $ccHahaGuardRoot
  IfErrors cc_haha_guard_receive_done
  ClearErrors
  ${GetOptions} $R0 "--capabilities=" $ccHahaGuardCapabilities
  IfErrors cc_haha_guard_receive_done
  ClearErrors
  ${GetOptions} $R0 "--parent=" $ccHahaGuardParentArguments
  IfErrors cc_haha_guard_receive_done
  StrCmp $ccHahaGuardRoot $INSTDIR 0 cc_haha_guard_receive_done
  ; Exact preserve-data invocation; no extra/duplicate option can silently
  ; reach the vendor data, registry or shortcut cleanup with different flags.
  StrCpy $R1 '/S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated --cc-guarded-removal=1 --root=$\"$ccHahaGuardRoot$\" --capabilities=$\"$ccHahaGuardCapabilities$\" --parent=$\"$ccHahaGuardParentArguments$\"'
  StrCmp $R0 $R1 cc_haha_guard_receive_arguments
  StrCpy $R1 "$R1 _?=$ccHahaGuardRoot"
  StrCmp $R0 $R1 0 cc_haha_guard_receive_done
  cc_haha_guard_receive_arguments:
  Call un.CcHahaGuardValidateRoot
  StrCmp $ccHahaGuardOk 1 0 cc_haha_guard_receive_done
  Call un.CcHahaGuardAllocate
  StrCmp $ccHahaGuardOk 1 0 cc_haha_guard_receive_done
  StrCpy $R8 0
  StrCpy $R4 0
  StrCpy $R2 ""
  StrCpy $R3 $ccHahaGuardHandles
  cc_haha_guard_receive_character:
    StrCpy $R0 $ccHahaGuardCapabilities 1 $R8
    ${If} $R0 != ":"
    ${AndIf} $R0 != ","
    ${AndIf} $R0 != ""
      StrLen $R1 $R2
      IntCmp $R1 10 cc_haha_guard_receive_done 0 cc_haha_guard_receive_done
      StrCpy $R2 "$R2$R0"
      IntOp $R8 $R8 + 1
      Goto cc_haha_guard_receive_character
    ${EndIf}
    Call un.CcHahaGuardParseDword
    StrCmp $R9 1 0 cc_haha_guard_receive_done
    IntOp $R1 $R4 * 4
    IntOp $R1 $R1 + $R3
    System::Call '*$R1(i R2)'
    IntOp $R4 $R4 + 1
    StrCpy $R2 ""
    ${If} $R4 < 4
      StrCmp $R0 ":" 0 cc_haha_guard_receive_done
      IntOp $R8 $R8 + 1
      Goto cc_haha_guard_receive_character
    ${EndIf}
    StrCmp $R0 ":" cc_haha_guard_receive_done
    System::Call '*$R3(p.R1)'
    IntFmt $R1 "%u" $R1
    StrCmp $R1 0 cc_haha_guard_receive_done
    System::Int64Op $R1 >= 4294967280
    Pop $R2
    StrCmp $R2 1 cc_haha_guard_receive_done
    System::Call 'kernel32::GetHandleInformation(p R1, *i.R2) i.R5'
    StrCmp $R5 0 cc_haha_guard_receive_done
    IntOp $R2 $R2 & 1
    StrCmp $R2 1 0 cc_haha_guard_receive_done
    System::Call 'kernel32::GetFileType(p R1) i.R2'
    StrCmp $R2 1 0 cc_haha_guard_receive_done
    StrCpy $R2 0
    ${While} $R2 < $ccHahaGuardCount
      IntOp $R5 $R2 * ${CC_HAHA_GUARD_RECORD_BYTES}
      IntOp $R5 $R5 + $ccHahaGuardHandles
      System::Call '*$R5(p.R6)'
      StrCmp $R1 $R6 cc_haha_guard_receive_done
      IntOp $R2 $R2 + 1
    ${EndWhile}
    ; Retain ownership before clearing inheritance; a failure remains fatal.
    IntOp $ccHahaGuardCount $ccHahaGuardCount + 1
    System::Call 'kernel32::SetHandleInformation(p R1, i 1, i 0) i.R2'
    StrCmp $R2 0 cc_haha_guard_receive_done
    StrCmp $R0 "" cc_haha_guard_receive_validate
    IntCmp $ccHahaGuardCount ${CC_HAHA_GUARD_MAX_DIRECTORIES} cc_haha_guard_receive_done 0 cc_haha_guard_receive_done
    IntOp $R3 $R3 + ${CC_HAHA_GUARD_RECORD_BYTES}
    StrCpy $R4 0
    StrCpy $R2 ""
    IntOp $R8 $R8 + 1
    Goto cc_haha_guard_receive_character
  cc_haha_guard_receive_validate:
    Call un.CcHahaGuardRevalidate
    StrCmp $ccHahaGuardOk 1 0 cc_haha_guard_receive_done
    Call un.CcHahaGuardReceiveParent
    StrCmp $ccHahaGuardOk 1 0 cc_haha_guard_receive_done
    ; The backend repeats fixed product/token/registry/source identity before
    ; freezing the root; inheritable handles alone do not authorize deletion.
    StrCpy $ccHahaGuardMode 1
  cc_haha_guard_receive_done:
    ; The ordinary vendor branch sees exactly the incoming error state.
    ; A missing compatibility option must not introduce GetOptions' error.
    ${If} $ccHahaGuardMode == 0
      ${If} $ccHahaGuardEntryError == 1
        SetErrors
      ${Else}
        ClearErrors
      ${EndIf}
    ${EndIf}
    System::Store L
FunctionEnd

Function un.CcHahaGuardedRemove
  StrCpy $ccHahaGuardExit 22
  StrCmp $ccHahaGuardMode 1 0 cc_haha_guard_remove_done
  InitPluginsDir
  ClearErrors
  File /oname=$PLUGINSDIR\cc-haha-guarded-removal.exe "${CC_HAHA_GUARDED_HELPER_FILE}"
  IfErrors cc_haha_guard_remove_done
  ClearErrors
  File /oname=$PLUGINSDIR\cc-haha-guarded-removal.exe.config "${CC_HAHA_GUARDED_CONFIG_FILE}"
  IfErrors cc_haha_guard_remove_done
  StrCpy $ccHahaGuardApplication "$PLUGINSDIR\cc-haha-guarded-removal.exe"
  StrCpy $ccHahaGuardExtraArguments ""
  StrCpy $ccHahaGuardIsUninstaller 0
  StrCpy $ccHahaGuardExpectedHash "${CC_HAHA_GUARDED_HELPER_SHA256}"
  StrCpy $ccHahaGuardExpectedBytes ${CC_HAHA_GUARDED_HELPER_BYTES}
  StrCpy $ccHahaGuardConfigHash "${CC_HAHA_GUARDED_CONFIG_SHA256}"
  StrCpy $ccHahaGuardConfigBytes ${CC_HAHA_GUARDED_CONFIG_BYTES}
  ; The helper retains the same root/ancestor capabilities, establishes all
  ; strong/sentinel protections, closes its weak handles, then moves/prunes or
  ; restores in the same process. NSIS never recursively touches this branch.
  Call un.CcHahaGuardLaunch
  cc_haha_guard_remove_done:
    Call un.CcHahaGuardDiscard
    ${If} $ccHahaGuardOk != 1
      StrCpy $ccHahaGuardExit 22
    ${EndIf}
FunctionEnd
!macroend

!macro CcHahaGuardCheckUninstallerEntry _SKIP
  Call un.CcHahaGuardReceive
  ${If} $ccHahaGuardMode == "invalid"
    SetErrorLevel 22
    Quit
  ${EndIf}
  ${If} $ccHahaGuardMode == 1
    Goto ${_SKIP}
  ${EndIf}
!macroend

!macro customRemoveFiles
  ${If} $ccHahaGuardMode == 1
    SetOutPath $SYSDIR
    Call un.CcHahaGuardedRemove
    ${If} $ccHahaGuardExit != 0
      SetErrorLevel 22
      Quit
    ${EndIf}
  ${Else}
    ; Exact pinned vendor block, including its normal restore-on-error path.
    !insertmacro CcHahaVendorDefaultRemoveFiles
  ${EndIf}
!macroend
!endif

!endif
