import { describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createSandboxedTestEnvironment } from './test-environment'
import { renderInstallProcessHelperNsh } from '../../desktop/scripts/generate-install-process-helper-nsh'
import { fallbackApiCases, frozenResidualMacrosSha256, readFallbackMacros, renderFallbackApiHarness, renderResidualFindApiHarness, renderResidualFindNativeHarness, residualFindApiCases } from './windows-installer-native-fixtures'

function sha256(source: string | Buffer) {
  return createHash('sha256').update(source).digest('hex')
}

function preserveResidualEvidence(name: string, evidence: Record<string, unknown>, files: Record<string, string> = {}) {
  const directory = path.resolve('artifacts/windows-installer/residual-matches')
  mkdirSync(directory, { recursive: true })
  for (const [suffix, text] of Object.entries(files)) {
    writeFileSync(path.join(directory, `${name}.${suffix}`), text)
  }
  writeFileSync(path.join(directory, `${name}.json`), `${JSON.stringify({
    ...evidence,
    recordedAtUtc: new Date().toISOString(),
    platform: process.platform,
    frozenSourceCommit: '3babd7615c2a4abf6408e5d50d3a2615ce429dce',
    frozenResidualMacrosSha256,
    releasedPeRun: false,
    originalUserScenario: 'not_run',
  }, null, 2)}\n`)
}

function residualRunFiles(journal: string) {
  const files: Record<string, string> = {}
  for (const [suffix, file] of [['log', journal], ['csv', `${journal}.csv`], ['residual.csv', `${journal}.residual.csv`]]) {
    if (existsSync(file!)) files[suffix!] = readFileSync(file!, 'utf8')
  }
  return files
}

function decodeFileWrites(nsh: string): string {
  return [...nsh.matchAll(/^\s*FileWrite \$0 "(.*)"$/gm)]
    .map(([, literal]) => literal!.replace(/\$(\$|\\"|\\n)/g, (_, escape: string) =>
      escape === '$' ? '$' : escape === '\\"' ? '"' : '\n'))
    .join('')
}

describe('Windows installer process matching', () => {
  test('freezes the real 3bab whole-Find path and renders real findstr residual guards', () => {
    const frozenSource = readFileSync('scripts/pr/fixtures/installer-fallback-before-residual-matches.nsh', 'utf8').replace(/\r\n/g, '\n')
    const before = readFallbackMacros(frozenSource, { includeFind: true, frozenResidual: true })
    const current = readFallbackMacros(readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n'), { includeFind: true })
    expect(sha256(before)).toBe(frozenResidualMacrosSha256)
    expect(before.match(/^!macro /gm)).toHaveLength(3)
    expect(fallbackApiCases).toHaveLength(30)
    expect(() => readFallbackMacros(frozenSource.replace('so setup continues.', 'tampered'), { includeFind: true, frozenResidual: true })).toThrow('frozen 3bab')
    for (const macros of [before, current]) {
      const rendered = renderResidualFindApiHarness(macros, before, 'C:\\owned\\probe.exe', 'C:\\owned\\probe.log', 'C:\\owned\\missing')
      expect(rendered.match(/!insertmacro CcHahaFindInstallProcess /g)).toHaveLength(3)
      expect(rendered).toContain('!insertmacro FixtureOwnedTasklist')
      expect(rendered).not.toContain('/D /C tasklist')
      expect(rendered).toContain('nsExec::ExecToStack /TIMEOUT=30000 \'"$SYSDIR\\findstr.exe" /I /L')
      expect(rendered).toContain('Pop $fixtureFilterReturn')
      const native = renderResidualFindNativeHarness(macros, before, 'C:\\owned\\native.exe', 'C:\\owned\\native.log', 'C:\\owned\\install')
      expect(native).toContain(macros)
      expect(native).toContain('/D /C tasklist /FO CSV /NH')
      expect(native).not.toContain('FixtureKernelCall')
    }
  })

  test.skipIf(process.platform !== 'win32')('keeps every original findstr hit protected through the whole native Find macro', () => {
    const compiler = process.env.CC_HAHA_TEST_MAKENSIS
    if (!compiler || !existsSync(compiler)) throw new Error('Run the prepared Windows installer lane with its locked NSIS compiler')
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-find-api-'))
    const env = createSandboxedTestEnvironment(path.join(root, 'home'))
    const installer = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const before = readFallbackMacros(readFileSync('scripts/pr/fixtures/installer-fallback-before-residual-matches.nsh', 'utf8').replace(/\r\n/g, '\n'), { includeFind: true, frozenResidual: true })
    const current = readFallbackMacros(installer, { includeFind: true })
    try {
      for (const [version, macros] of [['before', before], ['current', current]] as const) {
        const executable = path.join(root, `${version}.exe`)
        const source = path.join(root, `${version}.nsi`)
        const journal = path.join(root, `${version}.log`)
        const rendered = renderResidualFindApiHarness(macros, before, executable, journal, path.join(root, 'missing-install'))
        writeFileSync(source, rendered)
        const compileStartedAtUtc = new Date().toISOString()
        const compile = spawnSync(compiler, ['/V2', source], { env, encoding: 'utf8', timeout: 30_000 })
        preserveResidualEvidence(`api-${version}-compile`, {
          mode: 'real-nsis-findstr-with-injected-kernel-results-and-owned-csv',
          compileStartedAtUtc, compileFinishedAtUtc: new Date().toISOString(),
          sourceSha256: sha256(rendered), macroSha256: sha256(macros),
          productionSourceSha256: sha256(installer), status: compile.status, error: compile.error?.message,
          executableSha256: existsSync(executable) ? sha256(readFileSync(executable)) : null,
        }, { nsi: rendered, 'compile.log': `${compile.stdout ?? ''}${compile.stderr ?? ''}` })
        expect(compile.error, compile.stderr || compile.stdout).toBeUndefined()
        expect(compile.status, compile.stderr || compile.stdout).toBe(0)
        for (const fixture of residualFindApiCases) {
          for (const file of [journal, `${journal}.csv`, `${journal}.residual.csv`]) rmSync(file, { force: true })
          const startedAtUtc = new Date().toISOString()
          const run = spawnSync(executable, ['/S', `/CASE=${fixture.name}`], { env, timeout: 30_000, windowsHide: true })
          const files = residualRunFiles(journal)
          const trace = files.log ?? ''
          const expected = version === 'before' ? 1 : fixture.expected
          preserveResidualEvidence(`api-${version}-${fixture.name}`, {
            mode: 'real-nsis-findstr-with-injected-kernel-results-and-owned-csv',
            startedAtUtc, finishedAtUtc: new Date().toISOString(), case: fixture.name,
            sourceSha256: sha256(rendered), macroSha256: sha256(macros),
            expectedSafeResult: fixture.expected, expectedObservedResult: expected,
            observedResults: trace.match(/results=([^;]+);/)?.[1] ?? null,
            exitCode: run.status, error: run.error?.message,
            processPathErrorActuallyObserved: false,
            faultBoundary: fixture.name === 'verification-command-launch-error'
              ? 'real Verify residual-command launch; fixture tasklist is intentionally unaffected'
              : fixture.name === 'unattributed-foorg-no-path-proof'
                ? 'OpenProcess would fail if requested; the exact-name census never requests foorg path'
                : fixture.name === 'pattern-file-open-error' ? 'real Verify pattern FileOpen against an owned directory' : null,
          }, files)
          expect(run.error, `${version}/${fixture.name}`).toBeUndefined()
          expect(run.status, `${version}/${fixture.name}`).toBe(0)
          expect(trace, `${version}/${fixture.name}`).toContain(`results=${expected},${expected},${expected};`)
          expect(trace).toContain('handles=0;allocations=0;badClose=0;')
          expect(trace).toContain('stack=stack-canary;zero=caller-zero;one=caller-one;two=caller-two;three=caller-three;seven=caller-seven;')
          expect(trace).toContain('originalFilter=0;')
          expect(trace).toContain(fixture.image)
          if (fixture.name === 'unattributed-foorg-no-path-proof') expect(trace).toContain('openCalls=0;')
          if (version === 'current' && fixture.expected === 1) expect(trace).toContain('verified outside the install directory')
          if (version === 'current' && fixture.name === 'verification-command-launch-error') expect(trace).toContain('tasklist match verification failed')
          if (version === 'current' && fixture.name === 'pattern-file-open-error') expect(trace).toContain('could not all be verified')
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)

  test.skipIf(process.platform !== 'win32')('fails closed at the real NSIS fallback API boundaries and preserves its stack', () => {
    const compiler = process.env.CC_HAHA_TEST_MAKENSIS
    if (!compiler || !existsSync(compiler)) {
      throw new Error('Run the prepared Windows installer lane with its locked NSIS compiler')
    }
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-api-'))
    const env = createSandboxedTestEnvironment(path.join(root, 'home'))
    const missingRoot = path.join(root, 'unreadable-or-missing-install')
    expect(existsSync(missingRoot)).toBe(false)
    const current = readFallbackMacros(readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n'))
    const before = readFallbackMacros(readFileSync('scripts/pr/fixtures/installer-fallback-before-root-identity.nsh', 'utf8').replace(/\r\n/g, '\n'), true)
    try {
      for (const [version, macros] of [['before', before], ['current', current]] as const) {
        const executable = path.join(root, `${version}.exe`)
        const source = path.join(root, `${version}.nsi`)
        const journal = path.join(root, `${version}.log`)
        writeFileSync(source, renderFallbackApiHarness(macros, executable, journal, missingRoot))
        const compile = spawnSync(compiler, ['/V2', source], { env, encoding: 'utf8', timeout: 30_000 })
        expect(compile.error, compile.stderr || compile.stdout).toBeUndefined()
        expect(compile.status, compile.stderr || compile.stdout).toBe(0)
        const cases = version === 'before'
          ? [{ name: 'root-open-error', expected: 1 }]
          : fallbackApiCases
        for (const fixture of cases) {
          const run = spawnSync(executable, ['/S', `/CASE=${fixture.name}`], { env, timeout: 15_000, windowsHide: true })
          expect(run.error, `${version}/${fixture.name}`).toBeUndefined()
          expect(run.status, `${version}/${fixture.name}`).toBe(0)
          const trace = readFileSync(journal, 'utf8')
          expect(trace, `${version}/${fixture.name}`).toContain(`results=${fixture.expected},${fixture.expected},${fixture.expected};`)
          expect(trace, `${version}/${fixture.name}`).toContain('handles=0;allocations=0;badClose=0;stack=stack-canary;zero=caller-zero;one=caller-one;seven=caller-seven;')
          if (version === 'before') {
            // The frozen original macro claims external ownership even when
            // the installation root could not be established. The current
            // macro must return 0 for this exact same native fixture.
            expect(trace).toContain('other software outside the install directory')
          } else if (fixture.expected === 0) {
            expect(trace).toContain('Close them manually.')
          }
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

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

  test('resets the PowerShell module path before deciding whether PowerShell is usable', () => {
    const installerHook = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const macro = installerHook.match(
      /!macro CcHahaUseDefaultPowerShellModulePath\n([\s\S]*?)!macroend/,
    )?.[1]
    expect(macro).toContain('System::Call \'kernel32::SetEnvironmentVariable(w "PSModulePath", p 0)\'')

    const checkStart = installerHook.indexOf('!macro customCheckAppRunning')
    const reset = installerHook.indexOf('!insertmacro CcHahaUseDefaultPowerShellModulePath', checkStart)
    const availability = installerHook.indexOf('!insertmacro IS_POWERSHELL_AVAILABLE', checkStart)
    expect(checkStart).toBeGreaterThan(-1)
    expect(reset).toBeGreaterThan(checkStart)
    expect(availability).toBeGreaterThan(reset)
  })

  test.skipIf(process.platform !== 'win32')('drops an inherited foreign PSModulePath before PowerShell children start in native NSIS', () => {
    const compiler = process.env.CC_HAHA_TEST_MAKENSIS ?? path.join(
      process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis',
      'nsis-3.0.4.1-nsis-3.0.4.1', 'Bin', 'makensis.exe',
    )
    const templates = process.env.CC_HAHA_TEST_NSIS_TEMPLATES
      ?? path.resolve('desktop/node_modules/app-builder-lib/templates/nsis')
    if (!existsSync(compiler) || !existsSync(path.join(templates, 'include/allowOnlyOneInstallerInstance.nsh'))) {
      throw new Error('Native NSIS regression requires electron-builder dependencies and its cached compiler, or CC_HAHA_TEST_MAKENSIS/CC_HAHA_TEST_NSIS_TEMPLATES')
    }
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-nsis-psmodulepath-'))
    // Stands in for PowerShell 7's Microsoft.PowerShell.Security: listed ahead
    // of the Windows PowerShell modules, it shadows Get-ExecutionPolicy and
    // fails to load in 5.1, as the real PowerShell 7 module does.
    const foreignModules = path.join(root, 'foreign-modules')
    const security = path.join(foreignModules, 'Microsoft.PowerShell.Security')
    mkdirSync(security, { recursive: true })
    writeFileSync(path.join(security, 'Microsoft.PowerShell.Security.psd1'), [
      '@{',
      "  ModuleVersion = '99.0.0'",
      "  RootModule = 'Broken.psm1'",
      "  FunctionsToExport = @('Get-ExecutionPolicy')",
      '  CmdletsToExport = @()',
      '}',
      '',
    ].join('\r\n'))
    writeFileSync(path.join(security, 'Broken.psm1'), "throw 'Simulated PowerShell 7 module loaded by Windows PowerShell'\r\n")
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const baseEnv = Object.fromEntries(
      Object.entries(createSandboxedTestEnvironment(path.join(root, 'home')))
        .filter(([key]) => key.toLowerCase() !== 'psmodulepath'),
    )
    const env = {
      ...baseEnv,
      PSModulePath: `${foreignModules};${systemRoot}\\system32\\WindowsPowerShell\\v1.0\\Modules`,
    }
    // Both fixtures ask Windows PowerShell, without loading any module, whether
    // the foreign module directory is still on its module path. Importing
    // Microsoft.PowerShell.Security by name cannot tell the two apart: 5.1 loads
    // its in-box core modules from $PSHOME, so that import succeeds either way,
    // while command auto-loading (Get-ExecutionPolicy) still picks the foreign
    // copy. electron-builder's full IS_POWERSHELL_AVAILABLE check is left out:
    // it starts PowerShell without -NoProfile against the sandbox's cold module
    // analysis cache, and on CI runners it took from 8 s to over 30 s, too
    // variable for the release smoke this test gates.
    const backtick = '`'
    try {
      for (const fixture of [
        { name: 'inherited-module-path', reset: false, expected: 'foreign=1' },
        { name: 'reset-module-path', reset: true, expected: 'foreign=0' },
      ]) {
        const executable = path.join(root, `${fixture.name}.exe`)
        const journal = path.join(root, `${fixture.name}.log`)
        const script = String.raw`
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Isolated PowerShell module path regression"
OutFile "${executable}"
!addincludedir "${templates}\include"
!define APP_GUID "cc-haha-nsis-test-no-user-state"
!define UNINSTALL_APP_KEY "cc-haha-nsis-test-no-user-state"
!define APP_FILENAME "isolated-test"
!define PRODUCT_FILENAME "isolated-test"
!define BUILD_RESOURCES_DIR "${path.resolve('desktop/build')}"
!include "${path.resolve('desktop/build/installer.nsh')}"
!include "allowOnlyOneInstallerInstance.nsh"
LoadLanguageFile "${'${NSISDIR}'}\Contrib\Language files\English.nlf"
LangString uninstallFailed 1033 "Uninstall failed"
Var PowerShellPath
Var journalHandle
Section
  StrCpy $PowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${fixture.reset ? '!insertmacro CcHahaUseDefaultPowerShellModulePath' : ''}
  FileOpen $journalHandle "${journal}" w
  nsExec::Exec ${backtick}"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -Command "if ($$env:PSModulePath -like '*foreign-modules*') { exit 1 } else { exit 0 }"${backtick}
  Pop $0
  FileWrite $journalHandle "foreign=$0$\n"
  FileClose $journalHandle
SectionEnd
`
        const source = path.join(root, `${fixture.name}.nsi`)
        writeFileSync(source, script)
        const compile = spawnSync(compiler, ['/V2', source], { env, encoding: 'utf8', timeout: 15_000 })
        expect(compile.error, compile.stderr || compile.stdout).toBeUndefined()
        expect(compile.status, compile.stderr || compile.stdout).toBe(0)
        const run = spawnSync(executable, ['/S'], { env, timeout: 30_000, windowsHide: true })
        expect(run.error).toBeUndefined()
        expect(run.status, fixture.name).toBe(0)
        // Without the reset the child still sees the foreign path, proving the
        // fixture reproduces the inheritance the reset removes.
        expect(readFileSync(journal, 'utf8'), fixture.name).toContain(fixture.expected)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  test.skipIf(process.platform !== 'win32')('blocks the no-PowerShell fallback only for helpers that run from the install directory (#1879)', async () => {
    const compiler = process.env.CC_HAHA_TEST_MAKENSIS ?? path.join(
      process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis',
      'nsis-3.0.4.1-nsis-3.0.4.1', 'Bin', 'makensis.exe',
    )
    const templates = process.env.CC_HAHA_TEST_NSIS_TEMPLATES
      ?? path.resolve('desktop/node_modules/app-builder-lib/templates/nsis')
    if (!existsSync(compiler) || !existsSync(path.join(templates, 'include/getProcessInfo.nsh'))) {
      throw new Error('Native NSIS regression requires electron-builder dependencies and its cached compiler, or CC_HAHA_TEST_MAKENSIS/CC_HAHA_TEST_NSIS_TEMPLATES')
    }
    const root = mkdtempSync(path.join(tmpdir(), 'cc-haha-nsis-fallback-'))
    const env = createSandboxedTestEnvironment(path.join(root, 'home'))
    // Setup knows the install directory through a junction (a Programs folder
    // moved to another drive), while Windows reports process paths resolved.
    const realInstallDir = path.join(root, 'Moved Programs', 'Claude Code Haha')
    const installDir = path.join(root, 'Claude Code Haha')
    // A sibling whose name starts with the install directory's: Windows
    // Terminal's console host and the app's bundled one share an image name.
    const foreignDir = `${realInstallDir} Tools`
    const bundledDir = path.join(installDir, 'resources')
    mkdirSync(foreignDir, { recursive: true })
    mkdirSync(realInstallDir, { recursive: true })
    symlinkSync(realInstallDir, installDir, 'junction')
    mkdirSync(bundledDir, { recursive: true })
    const probeSource = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'ping.exe')
    const probes: ChildProcess[] = []
    const stopProbe = (probe: ChildProcess) => new Promise<void>((resolve, reject) => {
      if (!probe.pid || probe.exitCode !== null || probe.signalCode !== null) return resolve()
      probe.once('exit', () => resolve())
      probe.once('error', reject)
      probe.kill()
    })
    const startProbe = async (directory: string, imageName = 'OpenConsole.exe') => {
      const executable = path.join(directory, imageName)
      copyFileSync(probeSource, executable)
      const probe = spawn(executable, ['-t', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
      probes.push(probe)
      await new Promise<void>((resolve, reject) => {
        probe.once('spawn', () => resolve())
        probe.once('error', reject)
      })
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(probe.exitCode).toBeNull()
      return probe.pid!
    }
    const installer = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
    const before = readFallbackMacros(readFileSync('scripts/pr/fixtures/installer-fallback-before-residual-matches.nsh', 'utf8').replace(/\r\n/g, '\n'), { includeFind: true, frozenResidual: true })
    const current = readFallbackMacros(installer, { includeFind: true })
    const builds = [['before', before], ['current', current]].map(([version, macros]) => {
      const executable = path.join(root, `fallback-${version}.exe`)
      const source = path.join(root, `fallback-${version}.nsi`)
      const journal = path.join(root, `fallback-${version}.log`)
      const rendered = renderResidualFindNativeHarness(macros!, before, executable, journal, installDir)
      return { version: version!, macros: macros!, executable, source, journal, rendered }
    })
    const check = (caseName: string, expectedSafe: number, expectedBefore = expectedSafe) => {
      const traces: Record<string, string> = {}
      for (const build of builds) {
        for (const file of [build.journal, `${build.journal}.csv`, `${build.journal}.residual.csv`]) rmSync(file, { force: true })
        const startedAtUtc = new Date().toISOString()
        const run = spawnSync(build.executable, ['/S'], { env, timeout: 60_000, windowsHide: true })
        const files = residualRunFiles(build.journal)
        const trace = files.log ?? ''
        const expected = build.version === 'before' ? expectedBefore : expectedSafe
        preserveResidualEvidence(`native-${build.version}-${caseName}`, {
          mode: 'real-nsis-tasklist-findstr-census-file-identity-and-owned-ping-processes',
          startedAtUtc, finishedAtUtc: new Date().toISOString(), case: caseName,
          sourceSha256: sha256(build.rendered), macroSha256: sha256(build.macros),
          productionSourceSha256: sha256(installer), expectedSafeResult: expectedSafe,
          expectedObservedResult: expected, observedResults: trace.match(/results=([^;]+);/)?.[1] ?? null,
          ownedLiveProbePids: probes.filter(probe => probe.exitCode === null && probe.signalCode === null).map(probe => probe.pid),
          exitCode: run.status, error: run.error?.message,
        }, files)
        expect(run.error, `${build.version}/${caseName}`).toBeUndefined()
        expect(run.status, `${build.version}/${caseName}`).toBe(0)
        expect(trace, `${build.version}/${caseName}`).toStartWith(`results=${expected};`)
        expect(trace).toContain('originalFilter=0;')
        expect(trace).toContain('stack=stack-canary;zero=caller-zero;one=caller-one;two=caller-two;three=caller-three;seven=caller-seven;')
        traces[build.version] = trace
      }
      return traces
    }
    try {
      for (const build of builds) {
        writeFileSync(build.source, build.rendered)
        const compileStartedAtUtc = new Date().toISOString()
        const compile = spawnSync(compiler, ['/V2', build.source], { env, encoding: 'utf8', timeout: 15_000 })
        preserveResidualEvidence(`native-${build.version}-compile`, {
          mode: 'real-nsis-tasklist-findstr-census-file-identity-and-owned-ping-processes',
          compileStartedAtUtc, compileFinishedAtUtc: new Date().toISOString(),
          sourceSha256: sha256(build.rendered), macroSha256: sha256(build.macros),
          productionSourceSha256: sha256(installer), ownedProbeSourceSha256: sha256(readFileSync(probeSource)),
          status: compile.status, error: compile.error?.message,
          executableSha256: existsSync(build.executable) ? sha256(readFileSync(build.executable)) : null,
        }, { nsi: build.rendered, 'compile.log': `${compile.stdout ?? ''}${compile.stderr ?? ''}` })
        expect(compile.error, compile.stderr || compile.stdout).toBeUndefined()
        expect(compile.status, compile.stderr || compile.stdout).toBe(0)
      }

      const foreignPid = await startProbe(foreignDir)
      const foreignOnly = check('external-OpenConsole', 1)
      expect(foreignOnly.before).toContain('other software outside the install directory')
      expect(foreignOnly.current).toContain('verified outside the install directory')
      expect(foreignOnly.current).not.toContain(`PID ${foreignPid})`)

      const bundledPid = await startProbe(bundledDir)
      const withBundled = check('internal-OpenConsole-through-junction', 0)
      expect(withBundled.current).toContain(`OpenConsole.exe (PID ${bundledPid});`)
      expect(withBundled.current).not.toContain(`PID ${foreignPid})`)
      expect(withBundled.current).toContain('Close them manually.')
      await stopProbe(probes[1]!)
      await stopProbe(probes[0]!)

      const substringPid = await startProbe(bundledDir, 'foorg.exe')
      const internalSubstring = check('internal-foorg-through-junction', 0, 1)
      expect(internalSubstring.before).toContain('originalFilter=0;')
      expect(internalSubstring.before).toContain('foorg.exe')
      expect(internalSubstring.current).toContain('no verified external path')
      expect(internalSubstring.current).toContain(`"foorg.exe","${substringPid}"`)
      await stopProbe(probes[2]!)

      const externalRgPid = await startProbe(foreignDir, 'rg.exe')
      const externalRg = check('external-exact-rg', 1)
      expect(externalRg.current).toContain('verified outside the install directory')
      const mixedFoorgPid = await startProbe(bundledDir, 'foorg.exe')
      const mixed = check('external-exact-rg-with-internal-foorg', 0, 1)
      expect(mixed.before).toContain('other software outside the install directory')
      expect(mixed.before).toContain('foorg.exe')
      expect(mixed.current).toContain(`"foorg.exe","${mixedFoorgPid}"`)
      expect(mixed.current).toContain('no verified external path')
      expect(probes[3]!.pid).toBe(externalRgPid)
      expect(probes[3]!.exitCode).toBeNull()
      expect(probes[4]!.exitCode).toBeNull()
      await stopProbe(probes[4]!)
      await stopProbe(probes[3]!)

      // Names only this app uses still block wherever the process runs from.
      const sidecarPid = await startProbe(foreignDir, 'claude-sidecar.exe')
      const withSidecar = check('external-unique-sidecar', 0)
      expect(withSidecar.current).toContain(`claude-sidecar.exe (PID ${sidecarPid});`)
    } finally {
      for (const probe of probes) await stopProbe(probe)
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  test('uses a directory-boundary-aware process helper', () => {
    // A Windows checkout has CRLF line endings.
    const installerHook = readFileSync('desktop/build/installer.nsh', 'utf8').replace(/\r\n/g, '\n')
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
    // The USERNAME filter makes tasklist look up every process owner, which can
    // block forever and froze setup and the silent uninstaller.
    expect(installerHook).not.toContain('USERNAME eq')
    expect(installerHook).toContain(
      'nsExec::Exec /TIMEOUT=30000 \'"$CmdPath" /D /C tasklist /FO CSV /NH > "$PLUGINSDIR\\cc-haha-processes.csv"\'',
    )
    expect(installerHook).toContain('nsExec::ExecToStack /TIMEOUT=30000 \'"$SYSDIR\\findstr.exe" /I /L')
    expect(installerHook).toContain('tasklist process enumeration failed')
    expect(installerHook).toContain('fallback process filtering failed')
    expect(installerHook).toMatch(
      /tasklist process enumeration failed[\s\S]*StrCpy \$\{_RETURN\} 0/,
    )
    expect(installerHook).toMatch(
      /fallback process filtering failed[\s\S]*StrCpy \$\{_RETURN\} 0/,
    )
    // A timed-out or unlaunchable nsExec pushes "timeout"/"error". LogicLib's
    // == and != compare strings, so those block setup; an integer test (= or
    // <>) would read them as 0 and let setup continue on a partial CSV.
    expect(installerHook).toMatch(
      /tasklist \/FO CSV \/NH > [^\n]*\n\s*Pop \$\{_RETURN\}\n\s*\$\{If\} \$\{_RETURN\} != 0\n/,
    )
    const filter = installerHook.match(/!macro CcHahaFilterFallbackProcesses[^\n]*\n[\s\S]*?\n!macroend/)?.[0]
    expect(filter).toMatch(/findstr\.exe[^\n]*\n\s*Pop \$\{_RETURN\}\n\s*Pop \$\{_OUTPUT\}\n/)
    expect(installerHook).toMatch(/!insertmacro CcHahaFilterFallbackProcesses[^\n]*\n\s*\$\{If\} \$\{_RETURN\} == 0\n/)
    expect(installerHook).toContain('possibly in another user\'s session')
    expect(installerHook).toContain('claude-sidecar-x86_64-pc-windows-msvc.exe')
    expect(installerHook).toContain('claude-sidecar-aarch64-pc-windows-msvc.exe')
    expect(installerHook).toContain('/C:"OpenConsole.exe"')
    expect(installerHook).toContain('/C:"winpty-agent.exe"')
    expect(installerHook).toContain('/C:"rg.exe"')
    expect(installerHook).toContain('bundled terminal/search helper')
    expect(installerHook).toContain('Differently named child processes cannot be attributed')
    // A name hit is attributed by executable path before it blocks setup, and
    // the two name lists stay in sync (#1879).
    expect(installerHook).toMatch(
      /\$\{If\} \$\{_RETURN\} == 0\n[^\n]*possibly in another user's session[^\n]*\n\s*!insertmacro CcHahaAttributeFallbackMatches "\$\{_FILE\}" \$\{_RETURN\}\n\s*\$\{If\} \$\{_RETURN\} == 1\n\s*!insertmacro CcHahaVerifyFallbackRemainder "\$\{_FILE\}" \$\{_RETURN\}\n\s*\$\{EndIf\}\n\s*\$\{ElseIf\} \$\{_RETURN\} == 1\n/,
    )
    const attribution = installerHook.slice(
      installerHook.indexOf('!macro CcHahaAttributeFallbackMatches'),
      installerHook.indexOf('!macro CcHahaFindInstallProcess'),
    )
    const findstrNames = [...installerHook.matchAll(/\/C:"([^"$]+\.exe)"/g)].map(([, name]) => name!)
    expect(findstrNames.length).toBeGreaterThan(0)
    for (const name of findstrNames) {
      expect(attribution).toContain(`$R5 == "${name}"`)
    }
    expect(attribution).toContain('$R5 == "${_FILE}"')
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
    // Only a helper inside the install directory blocks the no-CLR fallback; a
    // same-named one next to it (other software) stays alive through the next
    // no-CLR stage without changing its outcome: exit 20 on the elevated CI
    // runner (22 before the fix), a completed reinstall for a trusted user.
    expect(installerSmoke).toContain("$installHelperProbe = Join-Path $installDir 'OpenConsole.exe'")
    expect(installerSmoke).toMatch(
      /No-CLR install-directory bundled-helper process reinstall' -ExpectedExitCode 22/,
    )
    expect(installerSmoke).toContain('No-CLR exact-image fallback terminated an install-directory bundled-helper')
    expect(installerSmoke).toContain("$bundledHelperProbe = Join-Path $siblingDir 'OpenConsole.exe'")
    expect(installerSmoke).not.toContain('No-CLR external bundled-helper process reinstall')
    expect(installerSmoke).toMatch(
      /\$bundledHelperProcess = Start-Process[\s\S]*?default-mode reinstall without CLR[\s\S]*?No-CLR exact-image fallback terminated an external bundled-helper/,
    )
  })
})
