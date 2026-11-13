import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from './test-environment'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function fileEvidence(file: string) {
  if (!existsSync(file)) return { path: file, exists: false }
  const stat = lstatSync(file)
  return { path: file, exists: true, bytes: stat.size, sha256: stat.isFile() ? sha256(readFileSync(file)) : null }
}

function directories(directory: string) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^\d+(?:\.\d+)+$/.test(entry.name))
    .map(entry => entry.name).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
}

// Read installed tool metadata only. This does not initialize VS, run cl,
// install an SDK, or assume the windows-latest image has a working x86 target.
function inspectToolchain(env: Record<string, string>) {
  const programFiles = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const vswhere = join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe')
  const lookup = existsSync(vswhere) ? spawnSync(vswhere,
    ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json'],
    { env, encoding: 'utf8', timeout: 15_000, windowsHide: true }) : null
  let installation: { installationPath?: string; installationVersion?: string } | undefined
  let parseError: string | undefined
  try { installation = lookup?.status === 0 ? JSON.parse(lookup.stdout)[0] : undefined } catch (error) { parseError = String(error) }
  const versionFile = installation?.installationPath && join(installation.installationPath, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt')
  const version = versionFile && existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : undefined
  const validVersion = version && /^\d+(?:\.\d+)+$/.test(version) ? version : undefined
  const vc = installation?.installationPath && validVersion && join(installation.installationPath, 'VC/Tools/MSVC', validVersion)
  const sdk = join(programFiles, 'Windows Kits/10')
  const sdks = directories(join(sdk, 'Include')).map(version => ({ version, files: [
    fileEvidence(join(sdk, 'Include', version, 'um/Windows.h')),
    fileEvidence(join(sdk, 'Include', version, 'shared/minwindef.h')),
    fileEvidence(join(sdk, 'Include', version, 'ucrt/stdio.h')),
    fileEvidence(join(sdk, 'Lib', version, 'um/x86/kernel32.lib')),
    fileEvidence(join(sdk, 'Lib', version, 'ucrt/x86/libucrt.lib')),
  ] }))
  const files = vc ? [fileEvidence(join(vc, 'bin/Hostx64/x86/cl.exe')), fileEvidence(join(vc, 'bin/Hostx64/x86/link.exe')),
    fileEvidence(join(vc, 'lib/x86/libcmt.lib')), fileEvidence(join(vc, 'lib/x86/libvcruntime.lib'))] : []
  return { status: vc && files.every(file => file.exists) && sdks.some(sdk => sdk.files.every(file => file.exists)) ? 'located-not-compiled' : 'not-located',
    hostArchitecture: process.arch, targetArchitecture: 'x86', vswhere: fileEvidence(vswhere),
    lookup: lookup && { status: lookup.status, error: lookup.error?.message, stderr: lookup.stderr, stdout: lookup.stdout }, parseError,
    installation, versionFile: versionFile && fileEvidence(versionFile), msvcVersion: validVersion, files, sdks }
}

for (const architecture of ['x86', 'x64'] as const) {
  test.skipIf(process.platform !== 'win32')(`probes ${architecture} sharing, bound RenameInfo and weak-release prune/restore using owned temp only`, () => {
    if (process.env.CI !== 'true') throw new Error('Run this owned primitive probe only on a disposable Windows CI runner')
    const sandbox = mkdtempSync(join(tmpdir(), `cc-haha-removal-primitives-${architecture}-`))
    const env = createSandboxedTestEnvironment(join(sandbox, 'home'))
    const fixture = join(sandbox, 'fixture')
    mkdirSync(fixture)
    const evidence = resolve('artifacts/windows-installer/removal-primitives', architecture)
    mkdirSync(evidence, { recursive: true })
    for (const name of ['native.raw.json', 'compile.log', 'toolchain.json', 'report.json']) rmSync(join(evidence, name), { force: true })
    const source = resolve('scripts/pr/windows-installer-removal-primitives.cs')
    const copiedSource = join(sandbox, 'probe.cs')
    const executable = join(sandbox, 'probe.exe')
    const raw = join(sandbox, 'native.raw.json')
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
    const framework = join(systemRoot, architecture === 'x86' ? 'Microsoft.NET/Framework/v4.0.30319' : 'Microsoft.NET/Framework64/v4.0.30319')
    const compiler = join(framework, 'csc.exe')
    const compileCommand = [compiler, '/nologo', '/target:exe', `/platform:${architecture}`, '/optimize+', `/out:${executable}`, copiedSource]
    const report: Record<string, unknown> = { version: 1, status: 'starting', platform: process.platform,
      architecture, source: fileEvidence(source), compiler: fileEvidence(compiler),
      compileCommand, sandbox, ownedFixtureRoot: fixture, officialOldPeExecuted: false, productPeExecuted: false,
      realAccountsCreated: 0, realProfilesCreated: 0, crossProcessPinnedAck: 'not_run', junctionRaces: 'not_run',
      completeFailureRestore: 'unknown', productRemoval: 'not_run', f1: 'not_run' }
    try {
      const tools = inspectToolchain(env)
      writeFileSync(join(evidence, 'toolchain.json'), `${JSON.stringify(tools, null, 2)}\n`)
      report.toolchain = tools
      expect(existsSync(compiler), `The actual system ${architecture} Framework C# compiler is required`).toBe(true)
      copyFileSync(source, copiedSource)
      const compile = spawnSync(compiler, compileCommand.slice(1), { env, encoding: 'utf8', timeout: 30_000, windowsHide: true })
      report.compile = { status: compile.status, error: compile.error?.message }
      writeFileSync(join(evidence, 'compile.log'), `${compile.stdout ?? ''}${compile.stderr ?? ''}${compile.error ?? ''}`)
      expect(compile.error, compile.stderr || compile.stdout).toBeUndefined()
      expect(compile.status, compile.stderr || compile.stdout).toBe(0)
      const bytes = readFileSync(executable)
      expect(bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4)).toBe(architecture === 'x86' ? 0x14c : 0x8664)
      report.executable = fileEvidence(executable)
      const versionsInput = join(sandbox, 'tool-versions-input.json')
      const binaries = [compiler, ...(tools.vswhere.exists ? [tools.vswhere.path] : []),
        ...tools.files.filter(file => file.exists && /\.exe$/i.test(file.path)).map(file => file.path)]
      writeFileSync(versionsInput, `${binaries.join('\n')}\n`)
      const run = spawnSync(executable, [fixture, raw, versionsInput], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true })
      report.run = { status: run.status, error: run.error?.message, stdout: run.stdout, stderr: run.stderr }
      expect(run.error).toBeUndefined()
      expect(existsSync(raw), 'Native observations must come from the executed owned fixture').toBe(true)
      copyFileSync(raw, join(evidence, 'native.raw.json'))
      const native = JSON.parse(readFileSync(raw, 'utf8'))
      report.native = native
      expect(run.status, JSON.stringify(native, null, 2)).toBe(0)
      expect(native.status).toBe('passed')
      expect(native.processPointerBytes).toBe(architecture === 'x86' ? 4 : 8)
      expect(native.renameNameOffset).toBe(architecture === 'x86' ? 12 : 20)
      expect(native.renameInformationBytes).toBe(architecture === 'x86' ? 16 : 24)
      expect(native.ownedFixtureRoot.toLowerCase()).toBe(resolve(fixture).toLowerCase())
      expect(native.executable.toLowerCase()).toBe(resolve(executable).toLowerCase())
      for (const name of ['weak-and-strong-same-object', 'preopened-writer-denies-strong', 'preopened-deleter-denies-strong',
        'relative-forward-existing-file-handle', 'prune-parent-after-weak-release', 'relative-restore-after-prune']) {
        expect(native.checks.some((check: { name: string; status: string }) => check.name === name && check.status === 'passed')).toBe(true)
      }
      for (const caseName of ['weak-lifetime', 'shared-reader-lifetime']) {
        expect(native.checks.some((check: { caseName?: string; name: string; status: string }) =>
          check.caseName === caseName && check.name === 'retained-handle-keeps-pending-object-live' && check.status === 'passed')).toBe(true)
      }
      expect(native.crossProcessPinnedAck).toBe('not_run')
      expect(native.completeFailureRestore).toBe('unknown')
      report.status = 'passed'
    } catch (error) {
      report.status = 'failed'
      report.error = String(error)
      throw error
    } finally {
      try {
        rmSync(sandbox, { recursive: true, force: true })
        report.cleanup = { status: existsSync(sandbox) ? 'failed' : 'passed', temporaryRootRemoved: !existsSync(sandbox) }
      } catch (error) {
        report.cleanup = { status: 'failed', error: String(error) }
        report.status = 'failed'
        throw error
      } finally { writeFileSync(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`) }
    }
  }, 90_000)
}
