import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSandboxedTestEnvironment } from './test-environment'
import { renderInstallProcessHelperNsh } from '../../desktop/scripts/generate-install-process-helper-nsh'

function decodeFileWrites(nsh: string): string {
  return [...nsh.matchAll(/^\s*FileWrite \$0 "(.*)"$/gm)]
    .map(([, literal]) => literal!.replace(/\$(\$|\\"|\\n)/g, (_, escape: string) =>
      escape === '$' ? '$' : escape === '\\"' ? '"' : '\n'))
    .join('')
}

describe('Windows installer process matching', () => {
  test.skipIf(process.platform !== 'win32')('handles blocked helper writes and old-uninstaller results in native NSIS', () => {
    const compiler = process.env.CC_HAHA_TEST_MAKENSIS ?? path.join(
      process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis',
      'nsis-3.0.4.1-nsis-3.0.4.1', 'Bin', 'makensis.exe',
    )
    const templates = process.env.CC_HAHA_TEST_NSIS_TEMPLATES
      ?? path.resolve('desktop/node_modules/app-builder-lib/templates/nsis')
    if (!existsSync(compiler) || !existsSync(path.join(templates, 'include/getProcessInfo.nsh'))) {
      throw new Error('Native NSIS regression requires electron-builder dependencies and its cached compiler, or CC_HAHA_TEST_MAKENSIS/CC_HAHA_TEST_NSIS_TEMPLATES')
    }
    const installer = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const checkStart = installer.indexOf('!macro customCheckAppRunning')
    const writeStart = installer.indexOf('!insertmacro IS_POWERSHELL_AVAILABLE', checkStart)
    const writeEnd = installer.indexOf('  StrCpy $ccHahaProcessDiagnostic ""', writeStart)
    expect(writeStart).toBeGreaterThan(checkStart)
    expect(writeEnd).toBeGreaterThan(writeStart)
    // Expand the actual hook's write/fallback transition, rather than copying it.
    const writeHook = installer.slice(installer.indexOf('\n', writeStart) + 1, writeEnd)
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-nsis-write-'))
    const env = createSandboxedTestEnvironment(path.join(root, 'home'))
    const cases = [
      { name: 'locked', target: 'locked', result: 0, exit: 0 },
      { name: 'locked-uninstall-failure', target: 'locked', result: 2, exit: 0 },
      { name: 'directory', target: 'directory', result: 2, exit: 0 },
      { name: 'normal', target: 'normal', result: 0, exit: 0 },
      { name: 'unrelated-uninstall-failure', target: 'normal', result: 2, exit: 2 },
      { name: 'running-app-with-stale-error', target: 'locked', result: 22, exit: 2 },
    ]
    try {
      for (const fixture of cases) {
        const executable = path.join(root, `${fixture.name}.exe`)
        const journal = path.join(root, `${fixture.name}.log`)
        const extracted = path.join(root, `${fixture.name}.ps1`)
        const script = String.raw`
Unicode true
RequestExecutionLevel user
SilentInstall silent
AllowSkipFiles off
Name "Isolated installer write regression"
OutFile "${executable}"
!addincludedir "${templates}\include"
!define APP_GUID "cc-haha-nsis-test-no-user-state"
!define UNINSTALL_APP_KEY "cc-haha-nsis-test-no-user-state"
!define APP_FILENAME "isolated-test"
!define PRODUCT_FILENAME "isolated-test"
!define BUILD_RESOURCES_DIR "${path.resolve('desktop/build')}"
!include "${path.resolve('desktop/build/installer.nsh')}"
LoadLanguageFile "${'${NSISDIR}'}\Contrib\Language files\English.nlf"
LangString uninstallFailed 1033 "Uninstall failed"
Var IsPowerShellAvailable
Var lockedHandle
Var journalHandle
Section
  InitPluginsDir
  StrCpy $IsPowerShellAvailable 0
  ${fixture.target === 'directory' ? 'CreateDirectory "$PLUGINSDIR\\check-install-processes.ps1"' : ''}
  ${fixture.target === 'locked' ? `System::Call 'kernel32::CreateFileW(w "$PLUGINSDIR\\check-install-processes.ps1", i 0x40000000, i 0, p 0, i 2, i 0x80, p 0) p.s'\n  Pop $lockedHandle` : ''}
${writeHook}
  ${fixture.target === 'locked' ? "System::Call 'kernel32::CloseHandle(p $lockedHandle)'" : ''}
  FileOpen $journalHandle "${journal}" w
  FileWrite $journalHandle "blocked=$ccHahaProcessHelperWriteBlocked; powershell=$IsPowerShellAvailable$\n"
  FileClose $journalHandle
  ${fixture.target === 'normal' ? `CopyFiles /SILENT "$PLUGINSDIR\\check-install-processes.ps1" "${extracted}"` : ''}
  StrCpy $R0 ${fixture.result}
  ${fixture.result === 22 ? 'SetErrors' : 'ClearErrors'}
  !insertmacro CcHahaHandleOldUninstallerResult
  FileOpen $journalHandle "${journal}" a
  FileSeek $journalHandle 0 END
  FileWrite $journalHandle "continued$\n"
  FileClose $journalHandle
SectionEnd
`
        const source = path.join(root, `${fixture.name}.nsi`)
        writeFileSync(source, script)
        const compile = spawnSync(compiler, ['/V2', source], { env, encoding: 'utf8', timeout: 15_000 })
        expect(compile.error, compile.stderr || compile.stdout).toBeUndefined()
        expect(compile.status, compile.stderr || compile.stdout).toBe(0)
        const run = spawnSync(executable, ['/S'], { env, timeout: 10_000, windowsHide: true })
        expect(run.error).toBeUndefined()
        expect(run.status, fixture.name).toBe(fixture.exit)
        const trace = readFileSync(journal, 'utf8')
        const blocked = fixture.target !== 'normal'
        expect(trace, fixture.name).toContain(`blocked=${blocked ? 1 : 0}; powershell=${blocked ? 1 : 0}`)
        expect(trace.includes('continued'), fixture.name).toBe(fixture.exit === 0)
        if (!blocked) {
          expect(readFileSync(extracted, 'utf8')).toBe(
            readFileSync('desktop/build/check-install-processes.ps1', 'utf8').replace(/\r\n/g, '\n'),
          )
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  test('uses a directory-boundary-aware process helper', () => {
    const installerHook = readFileSync('desktop/build/installer.nsh', 'utf8')
    const processHelper = readFileSync(
      'desktop/build/check-install-processes.ps1',
      'utf8',
    )

    expect(installerHook).not.toContain('!insertmacro _CHECK_APP_RUNNING')
    expect(installerHook).toContain('check-install-processes.ps1')
    expect(installerHook).toContain('!macro CcHahaFindInstallProcess')
    expect(installerHook).toContain('!macro CcHahaKillInstallProcess')
    expect(installerHook).toContain('-InstallerPid "$pid"')
    expect(installerHook).toContain('-InstallerParentPid "$1"')
    expect(installerHook).toContain('tasklist /FI "USERNAME eq %USERNAME%" /FO CSV /NH >')
    expect(installerHook).toContain('tasklist process enumeration failed')
    expect(installerHook).toContain('fallback process filtering failed')
    expect(installerHook).toMatch(
      /tasklist process enumeration failed[\s\S]*StrCpy \$\{_RETURN\} 0/,
    )
    expect(installerHook).toMatch(
      /fallback process filtering failed[\s\S]*StrCpy \$\{_RETURN\} 0/,
    )
    expect(installerHook).toContain('claude-sidecar-x86_64-pc-windows-msvc.exe')
    expect(installerHook).toContain('claude-sidecar-aarch64-pc-windows-msvc.exe')
    expect(installerHook).toContain('/C:"OpenConsole.exe"')
    expect(installerHook).toContain('/C:"winpty-agent.exe"')
    expect(installerHook).toContain('/C:"rg.exe"')
    expect(installerHook).toContain('bundled terminal/search helper')
    expect(installerHook).toContain('Differently named child processes cannot be attributed')
    expect(installerHook).not.toContain('| "$FindPath"')

    expect(processHelper).toContain('function Test-PathInsideInstallDirectory')
    expect(processHelper).toContain(
      '$rootWithSeparator = $resolvedRoot + [IO.Path]::DirectorySeparatorChar',
    )
    expect(processHelper).toContain('[StringComparison]::OrdinalIgnoreCase')
    expect(processHelper).toContain('$process.ProcessId -eq $InstallerPid')
    expect(processHelper).not.toContain('$process.ProcessId -eq $InstallerParentPid')
    expect(processHelper).toContain('Matched protected install process:')
    expect(processHelper).toContain('Blocked unknown-path application process:')
    expect(processHelper).toContain('$unknownPathMatches.Add($process)')
    expect(installerHook).not.toContain('taskkill')
    expect(installerHook).toContain('refusing to terminate by image name')
    expect(installerHook.match(/SetErrorLevel 22/g)).toHaveLength(2)
    expect(installerHook).toMatch(
      /MessageBox MB_OKCANCEL[\s\S]*SetErrorLevel 22\s+Quit/,
    )
    expect(installerHook).toMatch(
      /MessageBox MB_RETRYCANCEL[\s\S]*SetErrorLevel 22\s+Quit/,
    )
  })

  test('writes the process helper without a fatal File extraction (#1486)', () => {
    const installerHook = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const processHelper = readFileSync('desktop/build/check-install-processes.ps1', 'utf8').replace(/\r\n/g, '\n')
    const helperWriter = readFileSync('desktop/build/check-install-processes.nsh', 'utf8').replace(/\r\n/g, '\n')

    // NSIS aborts setup when `File` cannot write; security tools block .ps1 in %TEMP%.
    expect(installerHook).not.toMatch(/^\s*File\b.*check-install-processes\.ps1/m)
    expect(installerHook).toContain('!include "${BUILD_RESOURCES_DIR}\\check-install-processes.nsh"')
    expect(helperWriter).not.toMatch(/^\s*File\b/m)
    expect(helperWriter).toMatch(/ClearErrors\s+FileOpen \$0 "\$\{_PATH\}" w\s+\$\{If\} \$\{Errors\}\s+StrCpy \$\{_WRITE_FAILED\} "1"/)
    expect(helperWriter).toContain('StrCpy ${_WRITE_FAILED} "0"')
    expect(helperWriter).toMatch(/\$\{If\} \$\{Errors\}\s+StrCpy \$\{_WRITE_FAILED\} "1"\s+\$\{EndIf\}\s+FileClose/)

    // The committed writer is generated from, and reproduces, the real helper.
    expect(helperWriter).toBe(renderInstallProcessHelperNsh(processHelper))
    expect(decodeFileWrites(helperWriter)).toBe(processHelper)

    const checkAppRunning = installerHook.slice(
      installerHook.indexOf('!macro customCheckAppRunning'),
      installerHook.indexOf('cc_haha_stop_process:'),
    )
    expect(checkAppRunning).toMatch(
      /!insertmacro IS_POWERSHELL_AVAILABLE[\s\S]*!insertmacro CcHahaWriteInstallProcessHelper "\$PLUGINSDIR\\check-install-processes\.ps1" \$ccHahaProcessHelperWriteBlocked[\s\S]*?\$\{If\} \$ccHahaProcessHelperWriteBlocked == "1"\s+\$\{OrIfNot\} \$\{FileExists\} "\$PLUGINSDIR\\check-install-processes\.ps1"[\s\S]*?StrCpy \$IsPowerShellAvailable 1/,
    )

    // A helper that never ran (missing file, launch error) must not read as "no process".
    const findProcess = installerHook.slice(
      installerHook.indexOf('!macro CcHahaFindInstallProcess'),
      installerHook.indexOf('!macro CcHahaKillInstallProcess'),
    )
    expect(findProcess).toMatch(
      /\$\{If\} \$\{_RETURN\} != 0\s+\$\{AndIf\} \$\{_RETURN\} != 1[\s\S]*?StrCpy \$IsPowerShellAvailable 1\s+\$\{EndIf\}\s+\$\{EndIf\}\s+\$\{If\} \$IsPowerShellAvailable != 0\s+Delete "\$PLUGINSDIR\\cc-haha-processes\.csv"/,
    )
  })

  test('installs over the old version when its uninstaller cannot write the helper (#1486)', () => {
    const installerHook = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const handler = installerHook.slice(
      installerHook.indexOf('!macro CcHahaHandleOldUninstallerResult'),
      installerHook.indexOf('!macro customUnInstallCheck\n'),
    )

    expect(installerHook).toMatch(
      /!macro customUnInstallCheck\s+!insertmacro CcHahaHandleOldUninstallerResult\s+!macroend/,
    )
    expect(installerHook).toMatch(
      /!macro customUnInstallCheckCurrentUser\s+!insertmacro CcHahaHandleOldUninstallerResult\s+!macroend/,
    )
    // Overwrite in place only when this installer hit the same blocked helper
    // write, and never when the old uninstaller saw the app running (exit 22).
    expect(installerHook).toMatch(
      /!insertmacro CcHahaWriteInstallProcessHelper[\s\S]*?StrCpy \$ccHahaProcessHelperWriteBlocked "1"/,
    )
    expect(handler).toMatch(
      /^\s*\$\{If\} \$R0 != 0\s+\$\{AndIf\} \$R0 != 22\s+\$\{AndIf\} \$ccHahaProcessHelperWriteBlocked == "1"\s+DetailPrint `[^`]*installing over the existing files\.`/m,
    )
    // The launch-error branch must not swallow exit code 22 (ExecWait keeps the
    // error flag when the in-place retry runs), and other failures still quit.
    expect(handler).toMatch(/\$\{ElseIf\} \$R0 != 22\s+\$\{AndIf\} \$\{Errors\}/)
    expect(handler).toMatch(/\$\{ElseIf\} \$R0 != 0\s+MessageBox [^\n]*\$\(uninstallFailed\)[\s\S]*?SetErrorLevel 2\s+Quit\s+\$\{EndIf\}/)
    expect(handler.match(/Quit/g)).toHaveLength(1)
  })

  test('keeps sibling-prefix and real install process cases in Windows smoke', () => {
    const installerSmoke = readFileSync(
      'desktop/scripts/windows-installer-smoke.ps1',
      'utf8',
    )

    expect(installerSmoke).toContain("$siblingDir = \"$installDir Tools\"")
    expect(installerSmoke).toContain("$siblingProbe = Join-Path $siblingDir 'Claude Code Haha.exe'")
    expect(installerSmoke).toContain('Sibling-prefix process remains running')
    expect(installerSmoke).toContain('Install-directory parent process detection')
    expect(installerSmoke).toContain('Install-directory process was not terminated')
    expect(installerSmoke).toContain("$bundledHelperProbe = Join-Path $siblingDir 'OpenConsole.exe'")
    expect(installerSmoke).toContain('No-CLR external bundled-helper process reinstall')
    expect(installerSmoke).toMatch(
      /No-CLR external bundled-helper process reinstall' -ExpectedExitCode 22/,
    )
    expect(installerSmoke).toContain('No-CLR exact-image fallback terminated an external bundled-helper')
  })
})
