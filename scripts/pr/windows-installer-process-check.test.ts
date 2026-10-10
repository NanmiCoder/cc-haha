import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderInstallProcessHelperNsh } from '../../desktop/scripts/generate-install-process-helper-nsh'

function decodeFileWrites(nsh: string): string {
  return [...nsh.matchAll(/^\s*FileWrite \$0 "(.*)"$/gm)]
    .map(([, literal]) => literal!.replace(/\$(\$|\\"|\\n)/g, (_, escape: string) =>
      escape === '$' ? '$' : escape === '\\"' ? '"' : '\n'))
    .join('')
}

describe('Windows installer process matching', () => {
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
    expect(helperWriter).toMatch(/ClearErrors\s+FileOpen \$0 "\$\{_PATH\}" w\s+\$\{IfNot\} \$\{Errors\}/)

    // The committed writer is generated from, and reproduces, the real helper.
    expect(helperWriter).toBe(renderInstallProcessHelperNsh(processHelper))
    expect(decodeFileWrites(helperWriter)).toBe(processHelper)

    const checkAppRunning = installerHook.slice(
      installerHook.indexOf('!macro customCheckAppRunning'),
      installerHook.indexOf('cc_haha_stop_process:'),
    )
    expect(checkAppRunning).toMatch(
      /!insertmacro IS_POWERSHELL_AVAILABLE[\s\S]*!insertmacro CcHahaWriteInstallProcessHelper "\$PLUGINSDIR\\check-install-processes\.ps1"\s+\$\{If\} \$\{Errors\}\s+\$\{OrIfNot\} \$\{FileExists\} "\$PLUGINSDIR\\check-install-processes\.ps1"[\s\S]*?StrCpy \$IsPowerShellAvailable 1/,
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
