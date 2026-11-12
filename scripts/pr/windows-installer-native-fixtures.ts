import { createHash } from 'node:crypto'

const canonicalRoot = String.raw`\\?\C:\Fixture\Install`
const externalImage = String.raw`\\?\C:\Fixture\Install Tools\helper.exe`
const internalImage = String.raw`\\?\c:\fixture\install\resources\helper.exe`

export const fallbackApiCases = [
  ...['OpenConsole.exe', 'winpty-agent.exe', 'rg.exe'].flatMap(image => [
    { name: `external-${image}`, image, path: externalImage, expected: 1 },
    { name: `internal-${image}`, image, path: internalImage, expected: 0 },
  ]),
  { name: 'unique-app', image: 'Claude Code Haha.exe', expected: 0 },
  { name: 'unique-sidecar', image: 'claude-sidecar.exe', expected: 0 },
  { name: 'unique-x64-sidecar', image: 'claude-sidecar-x86_64-pc-windows-msvc.exe', expected: 0 },
  { name: 'unique-arm64-sidecar', image: 'claude-sidecar-aarch64-pc-windows-msvc.exe', expected: 0 },
  { name: 'self', image: 'Claude Code Haha.exe', pid: 9999, expected: 1 },
  { name: 'root-open-error', fault: 'root-open', expected: 0 },
  { name: 'root-final-error', fault: 'root-final', expected: 0 },
  { name: 'root-final-size', fault: 'root-size', expected: 0 },
  { name: 'root-final-truncated', fault: 'root-truncated', expected: 0 },
  { name: 'root-final-namespace', root: String.raw`\\?\Volume{unknown}\Install`, expected: 0 },
  { name: 'process-open-error', fault: 'process-open', expected: 0 },
  { name: 'process-query-error', fault: 'process-query', expected: 0 },
  { name: 'process-file-error', fault: 'process-file', expected: 0 },
  { name: 'process-final-error', fault: 'process-final', expected: 0 },
  { name: 'process-final-size', fault: 'process-size', expected: 0 },
  { name: 'process-final-truncated', fault: 'process-truncated', expected: 0 },
  { name: 'process-final-namespace', path: String.raw`\Device\Unknown\helper.exe`, expected: 0 },
  { name: 'snapshot-error', fault: 'snapshot', expected: 0 },
  { name: 'first-error', fault: 'first', expected: 0 },
  { name: 'next-error', fault: 'next', expected: 0 },
  { name: 'allocation-error', fault: 'allocation', expected: 0 },
  // The kernel boundary returns the same identity through an alternate opened
  // path. These are API fixtures, not a claim of native SUBST/SMB coverage.
  { name: 'alias-inside', root: String.raw`\\?\D:\Moved\Install`, path: String.raw`\\?\D:\Moved\Install\helper.exe`, expected: 0 },
  { name: 'unc-inside', root: String.raw`\\?\UNC\host\share\Install`, path: String.raw`\\?\UNC\host\share\Install\helper.exe`, expected: 0 },
  { name: 'unc-sibling', root: String.raw`\\?\UNC\host\share\Install`, path: String.raw`\\?\UNC\host\share\Install Tools\helper.exe`, expected: 1 },
] as const

export function nsisLiteral(value: string) {
  return value.replace(/\$/g, '$$$$').replace(/"/g, '$\\"')
}

export function readFallbackMacros(source: string, historical = false) {
  const attribution = source.match(/!macro CcHahaAttributeFallbackMatches[^\n]*\n[\s\S]*?\n!macroend/)?.[0]
  if (!attribution) throw new Error('The real fallback attribution macro is missing')
  if (historical) {
    const digest = createHash('sha256').update(attribution).digest('hex')
    if (digest !== 'e9ddc289ea77cfe3e066c792c7d0b4994ccb9bc81ab9a695c199d872ceb81f7b') {
      throw new Error('The frozen original PR macro changed')
    }
    return attribution
  }
  const identity = source.match(/!macro CcHahaReadFinalProcessPath[^\n]*\n[\s\S]*?\n!macroend/)?.[0]
  if (!identity) throw new Error('The real final-path macro is missing')
  return `${identity}\n${attribution}`
}

export function renderFallbackApiHarness(macros: string, executable: string, journal: string, missingRoot: string) {
  const calls = new Set<string>()
  // Instrument OS call results only. Every branch, register save/restore and
  // structure access below is the actual NSIS production macro, not a TS model.
  const instrumented = macros.replace(/System::Call 'kernel32::([^']+)'/g, (_line, signature: string) => {
    let api = signature.slice(0, signature.indexOf('('))
    calls.add(api)
    let argument = 'unused'
    if (api === 'CreateFileW') argument = signature.includes('w R1') ? '$R1' : '${_PATH}'
    if (api === 'CloseHandle') argument = signature.includes('R2') ? '$R2' : '$R6'
    if (api === 'GetLongPathNameW') api = signature.includes('w R1') ? 'GetLongRoot' : 'GetLongProcess'
    return `!insertmacro FixtureKernelCall ${api} ${signature.includes('?e') ? 1 : 0} "${argument}"`
  }).replace('System::Alloc 1024', '!insertmacro FixtureAlloc')
    .replace('System::Free $R3', 'System::Free $R3\n      IntOp $fixtureAllocations $fixtureAllocations - 1')
  for (const name of ['CreateToolhelp32Snapshot', 'Process32FirstW', 'Process32NextW', 'OpenProcess', 'QueryFullProcessImageNameW', 'CloseHandle']) {
    if (!calls.has(name)) throw new Error(`No real ${name} boundary to instrument`)
  }
  const fixtures = fallbackApiCases.map(fixture => {
    const item = fixture as { name: string; image?: string; path?: string; root?: string; fault?: string; pid?: number }
    return String.raw`
  ${'${If}'} $fixtureCase == "${item.name}"
    StrCpy $fixtureName "${item.image ?? 'OpenConsole.exe'}"
    StrCpy $fixtureRoot "${nsisLiteral(item.root ?? canonicalRoot)}"
    StrCpy $fixturePath "${nsisLiteral(item.path ?? externalImage)}"
    StrCpy $fixtureFault "${item.fault ?? ''}"
    StrCpy $fixturePid ${item.pid ?? 4242}
  ${'${EndIf}'}`
  }).join('\n')
  return String.raw`
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Isolated fallback API regression"
OutFile "${nsisLiteral(executable)}"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
Var pid
Var ccHahaProcessDiagnostic
Var fixtureCase
Var fixtureArgs
Var fixtureName
Var fixtureRoot
Var fixturePath
Var fixtureFault
Var fixturePid
Var fixtureHandles
Var fixtureAllocations
Var fixtureBadClose
Var fixtureJournal
Var fixtureResult
Var fixtureCanary

!macro FixtureAlloc
  ${'${If}'} $fixtureFault == "allocation"
    Push 0
  ${'${Else}'}
    System::Alloc 1024
    IntOp $fixtureAllocations $fixtureAllocations + 1
  ${'${EndIf}'}
!macroend

!macro FixtureKernelCall _API _CAPTURE_ERROR _ARGUMENT
  !if "${'${_API}'}" == "CreateFileW"
    ${'${If}'} "${'${_ARGUMENT}'}" == "$INSTDIR"
      StrCpy $R6 101
      ${'${If}'} $fixtureFault == "root-open"
        StrCpy $R6 -1
      ${'${EndIf}'}
    ${'${Else}'}
      StrCpy $R6 201
      ${'${If}'} $fixtureFault == "process-file"
        StrCpy $R6 -1
      ${'${EndIf}'}
    ${'${EndIf}'}
    ${'${If}'} $R6 <> -1
      IntOp $fixtureHandles $fixtureHandles + 1
    ${'${EndIf}'}
  !else if "${'${_API}'}" == "GetFinalPathNameByHandleW"
    ${'${If}'} $R6 = 101
      StrCpy $R7 $fixtureRoot
      StrLen $R8 $R7
      ${'${If}'} $fixtureFault == "root-final"
        StrCpy $R8 0
      ${'${ElseIf}'} $fixtureFault == "root-size"
        StrCpy $R8 ${'${NSIS_MAX_STRLEN}'}
      ${'${ElseIf}'} $fixtureFault == "root-truncated"
        IntOp $R8 $R8 + 1
      ${'${EndIf}'}
    ${'${Else}'}
      StrCpy $R7 $fixturePath
      StrLen $R8 $R7
      ${'${If}'} $fixtureFault == "process-final"
        StrCpy $R8 0
      ${'${ElseIf}'} $fixtureFault == "process-size"
        StrCpy $R8 ${'${NSIS_MAX_STRLEN}'}
      ${'${ElseIf}'} $fixtureFault == "process-truncated"
        IntOp $R8 $R8 + 1
      ${'${EndIf}'}
    ${'${EndIf}'}
  !else if "${'${_API}'}" == "CreateToolhelp32Snapshot"
    StrCpy $R2 501
    ${'${If}'} $fixtureFault == "snapshot"
      StrCpy $R2 -1
    ${'${Else}'}
      IntOp $fixtureHandles $fixtureHandles + 1
    ${'${EndIf}'}
  !else if "${'${_API}'}" == "Process32FirstW"
    System::Call '*$R3(i 556, i 0, i $fixturePid, i 0, i 0, i 1, i 0, i 0, i 0, &w260 "$fixtureName")'
    StrCpy $R8 1
    ${'${If}'} $fixtureFault == "first"
      StrCpy $R8 0
    ${'${EndIf}'}
  !else if "${'${_API}'}" == "Process32NextW"
    StrCpy $R8 0
    !if ${'${_CAPTURE_ERROR}'} == 1
      ${'${If}'} $fixtureFault == "next"
        Push 5
      ${'${Else}'}
        Push 18
      ${'${EndIf}'}
    !endif
  !else if "${'${_API}'}" == "OpenProcess"
    StrCpy $R6 301
    ${'${If}'} $fixtureFault == "process-open"
      StrCpy $R6 0
    ${'${Else}'}
      IntOp $fixtureHandles $fixtureHandles + 1
    ${'${EndIf}'}
  !else if "${'${_API}'}" == "QueryFullProcessImageNameW"
    StrCpy $R7 "Z:\opened-alias\helper.exe"
    StrCpy $R8 1
    ${'${If}'} $fixtureFault == "process-query"
      StrCpy $R8 0
    ${'${EndIf}'}
  !else if "${'${_API}'}" == "CloseHandle"
    ${'${If}'} "${'${_ARGUMENT}'}" == 101
    ${'${OrIf}'} "${'${_ARGUMENT}'}" == 201
    ${'${OrIf}'} "${'${_ARGUMENT}'}" == 301
    ${'${OrIf}'} "${'${_ARGUMENT}'}" == 501
      IntOp $fixtureHandles $fixtureHandles - 1
    ${'${Else}'}
      StrCpy $fixtureBadClose 1
    ${'${EndIf}'}
  !else if "${'${_API}'}" == "GetFullPathNameW"
    StrCpy $R7 $INSTDIR
    StrLen $R8 $R7
  !else if "${'${_API}'}" == "GetLongRoot"
    StrCpy $R7 $INSTDIR
    StrLen $R8 $R7
  !else if "${'${_API}'}" == "GetLongProcess"
    StrCpy $R6 "C:\external\helper.exe"
    StrLen $R8 $R6
  !else
    !error "Uninstrumented API ${'${_API}'}"
  !endif
!macroend

${instrumented}

Section
  ${'${GetParameters}'} $fixtureArgs
  ${'${GetOptions}'} $fixtureArgs "/CASE=" $fixtureCase
  StrCpy $INSTDIR "${nsisLiteral(missingRoot)}"
  StrCpy $pid 9999
  StrCpy $fixtureHandles 0
  StrCpy $fixtureAllocations 0
  StrCpy $fixtureBadClose 0
${fixtures}
  StrCpy $0 "caller-zero"
  StrCpy $R1 "caller-one"
  StrCpy $R7 "caller-seven"
  Push "stack-canary"
  StrCpy $R0 0
  !insertmacro CcHahaAttributeFallbackMatches "Claude Code Haha.exe" $R0
  StrCpy $fixtureResult $R0
  StrCpy $R0 0
  !insertmacro CcHahaAttributeFallbackMatches "Claude Code Haha.exe" $R0
  StrCpy $fixtureResult "$fixtureResult,$R0"
  StrCpy $R0 0
  !insertmacro CcHahaAttributeFallbackMatches "Claude Code Haha.exe" $R0
  StrCpy $fixtureResult "$fixtureResult,$R0"
  Pop $fixtureCanary
  FileOpen $fixtureJournal "${nsisLiteral(journal)}" w
  FileWrite $fixtureJournal "results=$fixtureResult;handles=$fixtureHandles;allocations=$fixtureAllocations;badClose=$fixtureBadClose;stack=$fixtureCanary;zero=$0;one=$R1;seven=$R7; $ccHahaProcessDiagnostic"
  FileClose $fixtureJournal
SectionEnd
`
}
