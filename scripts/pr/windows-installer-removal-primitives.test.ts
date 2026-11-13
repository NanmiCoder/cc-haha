import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { release, tmpdir, version } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from './test-environment'

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function mayCleanOwnedSandbox(nativeStarted: boolean, native: Record<string, any> | undefined) {
  return !nativeStarted || (native?.version === 4 && native.safeForControllerCleanup === true &&
    native.cleanupState?.rootInitiallyVerified === true && native.cleanupState?.allHandlesClosed === true &&
    native.cleanupState?.pendingNativeIo === false && native.cleanupState?.reparseUncertain === false &&
    native.cleanupState?.unsafeEffectObserved === false)
}

// Preflight the complete bounded tree before deleting anything. No recursive
// rm, reparse traversal, or automatic cleanup after a crashed/unknown native run.
function removeOwnedPlainTree(root: string) {
  const plan: { path: string; directory: boolean; dev: number; ino: number }[] = []
  function inspect(path: string, depth: number) {
    if (depth > 16 || plan.length >= 2048) throw new Error('Owned cleanup exceeds its bounded tree')
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Owned cleanup refuses reparse or unknown entries')
    if (stat.isDirectory()) for (const entry of readdirSync(path)) inspect(join(path, entry), depth + 1)
    plan.push({ path, directory: stat.isDirectory(), dev: stat.dev, ino: stat.ino })
  }
  inspect(root, 0)
  for (const entry of plan) {
    const stat = lstatSync(entry.path)
    if (stat.isSymbolicLink() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.isDirectory() !== entry.directory) {
      throw new Error('Owned cleanup refuses changed identity')
    }
    if (entry.directory) rmdirSync(entry.path)
    else unlinkSync(entry.path)
  }
}

test('retains an owned native arena for missing, pending, reparse or incomplete-close evidence', () => {
  const known = { version: 4, safeForControllerCleanup: true, cleanupState: { rootInitiallyVerified: true,
    allHandlesClosed: true, pendingNativeIo: false, reparseUncertain: false, unsafeEffectObserved: false } }
  expect(mayCleanOwnedSandbox(false, undefined)).toBe(true)
  expect(mayCleanOwnedSandbox(true, undefined)).toBe(false)
  expect(mayCleanOwnedSandbox(true, known)).toBe(true)
  for (const key of ['rootInitiallyVerified', 'allHandlesClosed', 'pendingNativeIo', 'reparseUncertain', 'unsafeEffectObserved']) {
    const changed = structuredClone(known)
    changed.cleanupState[key as keyof typeof changed.cleanupState] = !changed.cleanupState[key as keyof typeof changed.cleanupState]
    expect(mayCleanOwnedSandbox(true, changed)).toBe(false)
  }
  expect(mayCleanOwnedSandbox(true, { ...known, safeForControllerCleanup: false })).toBe(false)
})

test('owned cleanup rejects a junction or symlink before touching its owned outside marker', () => {
  const arena = mkdtempSync(join(tmpdir(), 'cc-haha-probe-cleanup-'))
  const inside = join(arena, 'inside'), outside = join(arena, 'outside')
  mkdirSync(inside)
  mkdirSync(outside)
  writeFileSync(join(outside, 'marker'), 'owned outside marker')
  const alias = join(inside, 'alias')
  symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    expect(() => removeOwnedPlainTree(inside)).toThrow('refuses reparse')
    expect(readFileSync(join(outside, 'marker'), 'utf8')).toBe('owned outside marker')
    expect(existsSync(alias)).toBe(true)
  } finally {
    // Remove just this known test link, then use the same non-follow cleanup.
    unlinkSync(alias)
    removeOwnedPlainTree(arena)
  }
})

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
  test.skipIf(process.platform !== 'win32')(`probes ${architecture} readonly MOVE guards and by-ID PRUNE using owned temp only`, () => {
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
    const compileCommand = [compiler, '/nologo', '/langversion:5', '/target:exe', `/platform:${architecture}`, '/optimize+', `/out:${executable}`, copiedSource]
    let nativeStarted = false
    let native: Record<string, any> | undefined
    let originalFailure = false
    const report: Record<string, unknown> = { version: 4, status: 'starting', platform: process.platform,
      operatingSystem: { release: release(), version: version() },
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
      nativeStarted = true
      const run = spawnSync(executable, [fixture, raw, versionsInput], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true })
      report.run = { status: run.status, error: run.error?.message, stdout: run.stdout, stderr: run.stderr }
      if (existsSync(raw)) copyFileSync(raw, join(evidence, 'native.raw.json'))
      expect(run.error).toBeUndefined()
      expect(existsSync(raw), 'Native observations must come from the executed owned fixture').toBe(true)
      native = JSON.parse(readFileSync(raw, 'utf8'))
      if (!native) throw new Error('Missing native evidence')
      report.native = native
      expect(run.status, JSON.stringify({ status: native.status, failedChecks: native.checks.filter((item: any) => item.status === 'failed'), cleanup: native.cleanupState })).toBe(0)
      expect(native.version).toBe(4)
      expect(native.status).toBe('passed')
      expect(native.chosenPrimitive).toBe('NtRename+readonly-share3+relative-NtCreate-sentinel+same-handle-byID-prune')
      expect(native.chosenPrimitiveStatus).toBe('passed')
      expect(native.processPointerBytes).toBe(architecture === 'x86' ? 4 : 8)
      expect(native.renameNameOffset).toBe(architecture === 'x86' ? 12 : 20)
      expect(native.renameInformationBytes).toBe(architecture === 'x86' ? 16 : 24)
      expect(native.ioStatusBlockBytes).toBe(architecture === 'x86' ? 8 : 16)
      expect(native.ioInformationOffset).toBe(architecture === 'x86' ? 4 : 8)
      expect(native.fileIdDescriptorBytes).toBe(24)
      expect(native.fileIdDescriptorUnionOffset).toBe(8)
      expect(native.ownedFixtureRoot.toLowerCase()).toBe(resolve(fixture).toLowerCase())
      expect(native.executable.toLowerCase()).toBe(resolve(executable).toLowerCase())
      for (const name of ['weak-and-strong-same-object', 'preopened-writer-denies-strong', 'preopened-deleter-denies-strong']) {
        expect(native.checks.some((check: { name: string; status: string }) => check.name === name && check.status === 'passed')).toBe(true)
      }
      const chosen = 'chosen-sentinel-share3-roundtrip'
      expect(native.caseResults.find((item: { name: string }) => item.name === chosen)).toEqual({
        name: chosen, role: 'required', completed: true, capabilityCredit: true, fullRoundtrip: true,
      })
      for (const name of ['relative-forward-existing-file-handle', 'rename-kept-source-object', 'prune-child-same-handle-disposition',
        'prune-parent-same-handle-disposition', 'relative-restore-after-prune', 'restore-kept-source-object', 'restore-preserved-owned-payload-bytes']) {
        expect(native.checks.some((check: { caseName: string; name: string; status: string }) =>
          check.caseName === chosen && check.name === name && check.status === 'passed')).toBe(true)
      }
      expect(native.checks.some((check: { name: string; status: string }) =>
        check.name === 'file-id-descriptor-sdk-layout' && check.status === 'passed')).toBe(true)
      const oldNt = 'control-nt-strong-metadata-roundtrip'
      const oldNtResult = native.caseResults.find((item: { name: string }) => item.name === oldNt)
      expect(oldNtResult.role).toBe('diagnostic')
      expect(oldNtResult.capabilityCredit).toBe(false)
      const oldNtCalls = native.observations.filter((item: { caseName: string; api: string }) =>
        item.caseName === oldNt && item.api === 'NtSetInformationFile(FileRenameInformation)')
      expect(oldNtCalls.length).toBeGreaterThan(0)
      for (const call of oldNtCalls) expect(call.diagnosticOnly).toBe(true)
      const diagnostics = ['control-win32-strong-original-buffer', 'control-win32-metadata-original-buffer', 'control-win32-metadata-contract-roundtrip']
      for (const name of diagnostics) {
        const result = native.caseResults.find((item: { name: string }) => item.name === name)
        expect(result.role).toBe('diagnostic')
        expect(result.capabilityCredit).toBe(false)
        const calls = native.observations.filter((item: { caseName: string; api: string }) => item.caseName === name && item.api === 'SetFileInformationByHandle(FileRenameInfo)')
        expect(calls.length).toBeGreaterThan(0)
        for (const call of calls) expect(call.diagnosticOnly).toBe(true)
      }
      for (const name of diagnostics.slice(0, 2)) {
        const calls = native.observations.filter((item: { caseName: string; api: string }) =>
          item.caseName === name && item.api === 'SetFileInformationByHandle(FileRenameInfo)')
        expect(calls).toHaveLength(1)
        expect(calls[0].detail.contractLength).toBe(false)
        expect(calls[0].detail.nameBytesExcludingNul).toBe(22)
        expect(calls[0].detail.bufferBytesIncludingNul).toBe(architecture === 'x86' ? 36 : 44)
        const aliases = native.observations.filter((item: { caseName: string; api: string; name: string }) =>
          item.caseName === name && item.api === 'CreateFileW' && item.name === 'control-metadata-alias')
        expect(aliases).toHaveLength(name === diagnostics[0] ? 0 : 1)
      }
      const win32Roundtrip = native.caseResults.find((item: { name: string }) => item.name === 'control-win32-metadata-contract-roundtrip')
      for (const call of native.observations.filter((item: { caseName: string; api: string }) =>
        item.caseName === win32Roundtrip.name && item.api === 'SetFileInformationByHandle(FileRenameInfo)')) {
        expect(call.detail.contractLength).toBe(true)
        expect(call.detail.bufferBytesIncludingNul).toBe(architecture === 'x86' ? 38 : 46)
      }
      if (win32Roundtrip.completed) {
        expect(win32Roundtrip.fullRoundtrip).toBe(true)
        for (const name of ['relative-forward-existing-file-handle', 'prune-parent-after-weak-release', 'relative-restore-after-prune', 'restore-preserved-owned-payload-bytes']) {
          expect(native.diagnosticChecks.some((check: { caseName: string; name: string; status: string; capabilityCredit: boolean }) =>
            check.caseName === win32Roundtrip.name && check.name === name && check.status === 'observed-true' && check.capabilityCredit === false)).toBe(true)
        }
      }
      const ntCalls = native.observations.filter((item: { caseName: string; api: string }) =>
        item.caseName === chosen && item.api === 'NtSetInformationFile(FileRenameInformation)')
      expect(ntCalls).toHaveLength(2)
      expect(native.observations.filter((item: { caseName: string; api: string }) =>
        item.caseName === chosen && item.api === 'SetFileInformationByHandle(FileRenameInfo)')).toHaveLength(0)
      for (const call of ntCalls) {
        expect(call.diagnosticOnly).toBe(false)
        expect(call.informationClass).toBe(10)
        expect(call.success && call.callSucceeded && call.ioSucceeded && call.completed).toBe(true)
        expect(Number.parseInt(call.ioNtStatus, 16)).toBeLessThan(0x80000000)
        expect(call.ioNtStatus).not.toBe('00000103')
        if (call.callWasPending) expect(call.wait.result).toBe(0)
        else expect(Number.parseInt(call.callNtStatus, 16)).toBeLessThan(0x80000000)
        expect(call.errorSource).toContain('derived')
        expect(call.detail.contractLength).toBe(true)
        expect(call.detail.bufferBytesIncludingNul).toBe(architecture === 'x86' ? 38 : 46)
      }
      expect(native.directoryEntryNameOffset).toBe(104)
      expect(native.directoryEntryIdOffset).toBe(96)
      expect(native.controlledThreatBoundary).toContain('fresh private sandbox only')
      expect(native.controlledThreatBoundary).toContain('not installed ancestry')
      for (const key of ['sandboxBinding', 'fixtureBinding', 'outsideBinding']) {
        expect(native[key].directory && !native[key].reparse && !native[key].deletePending).toBe(true)
        expect(native[key].volume).toBe(native.sandboxBinding.volume)
        expect(native[key].fileId).toMatch(/^[0-9a-f]{16}$/)
        expect(native[key].canonical.toLowerCase()).toContain(resolve(sandbox).toLowerCase())
      }
      expect(mayCleanOwnedSandbox(true, native)).toBe(true)
      const oldShare1 = native.caseResults.find((item: { name: string }) => item.name === 'control-nt-readonly-share1-roundtrip')
      expect(oldShare1.role).toBe('diagnostic')
      expect(oldShare1.capabilityCredit).toBe(false)
      const chosenObservations = native.observations.filter((item: { caseName: string }) => item.caseName === chosen)
      expect(chosenObservations.some((item: { api: string }) => item.api === 'CreateFileW' || item.api === 'CreateDirectoryW')).toBe(false)
      const aliases = chosenObservations.filter((item: { api: string; name: string }) => item.api === 'OpenFileById' && /chosen-(?:stage|restore)-alias$/.test(item.name))
      expect(aliases).toHaveLength(2)
      for (const alias of aliases) {
        expect(alias.success).toBe(true)
        expect(alias.detail.access).toBe(0xa0)
        expect(alias.detail.share).toBe(7)
      }
      const guards = chosenObservations.filter((item: { api: string; name: string }) => item.api === 'OpenFileById' && item.name.endsWith('-readonly-guard'))
      expect(guards).toHaveLength(6)
      for (const guard of guards) {
        expect(guard.success).toBe(true)
        expect(guard.detail.access).toBe(0xa1)
        expect(guard.detail.share).toBe(3)
      }
      const creates = chosenObservations.filter((item: { api: string }) => item.api === 'NtCreateFile(FILE_CREATE)')
      expect(creates.filter((item: { directory: boolean }) => item.directory)).toHaveLength(6)
      for (const call of creates) {
        expect(call.success && call.completed && call.securityDescriptorNull).toBe(true)
        expect(call.ioInformation).toBe(2)
        expect(call.objectAttributes).toBe(0x1040)
        expect(call.createDisposition).toBe(2)
        expect(call.createOptions).toBe(call.directory ? 0x200021 : 0x200060)
        expect(call.leaf).toMatch(/^[a-z0-9][a-z0-9.-]*$/)
        expect(call.fallback).toBe(false)
        if (call.name.endsWith('-sentinel')) {
          expect(call.access).toBe(0x110080)
          expect(call.share).toBe(1)
        }
      }
      expect(chosenObservations.filter((item: { api: string }) => item.api === 'SetFileInformationByHandle(FileDispositionInfo)')).toHaveLength(4)
      for (const kind of ['child', 'parent']) {
        const name = `prune-${kind}`
        const position = (api: string, label: string) => chosenObservations.findIndex((item: { api: string; name: string }) => item.api === api && item.name === label)
        const closeGuard = position('CloseHandle', `move-${kind}-readonly-guard`)
        const open = position('OpenFileById', `${name}-delete-pin`)
        const validate = position('ValidateSentinelPruneCandidate', name)
        const closeWeak = position('CloseHandle', `move-${kind}-directory`)
        const deleteSentinel = position('SetFileInformationByHandle(FileDispositionInfo)', `${name}-sentinel-disposition`)
        const closeSentinel = position('CloseHandle', `move-${kind}-sentinel`)
        const deleteDirectory = position('SetFileInformationByHandle(FileDispositionInfo)', `${name}-directory-disposition`)
        const closePin = position('CloseHandle', `${name}-delete-pin`)
        expect(closeGuard).toBeGreaterThan(-1)
        for (const [earlier, later] of [[closeGuard, open], [open, validate], [validate, closeWeak], [closeWeak, deleteSentinel],
          [deleteSentinel, closeSentinel], [closeSentinel, deleteDirectory], [deleteDirectory, closePin]]) expect(later).toBeGreaterThan(earlier)
        const acquired = chosenObservations[open]
        expect(acquired.success).toBe(true)
        expect(acquired.detail.access).toBe(0x10081)
        expect(acquired.detail.share).toBe(3)
        expect(acquired.detail.flags).toBe(0x02200000)
        expect(acquired.detail.descriptorSize).toBe(24)
        expect(acquired.detail.descriptorType).toBe(0)
        const validated = chosenObservations[validate]
        expect(validated.success).toBe(true)
        expect(validated.removalMutationPerformed).toBe(false)
        expect(validated.actual).toEqual(validated.expected)
        expect(validated.weak).toEqual(validated.expected)
        expect(chosenObservations[deleteDirectory].detail.handle).toBe(acquired.detail.handle)
        expect(chosenObservations[deleteDirectory].success && chosenObservations[closePin].success).toBe(true)
        expect(chosenObservations.slice(deleteSentinel, deleteDirectory).some((item: { api: string }) =>
          /CreateFile|CreateDirectory|Rename/.test(item.api))).toBe(false)
      }
      const barrierCases = ['pre-junction-relative-create', 'sentinel-blocks-junction', 'last-sentinel-junction-disposition', 'last-sentinel-new-child-rejected']
      for (const name of barrierCases) {
        const result = native.caseResults.find((item: { name: string }) => item.name === name)
        expect(result.role).toBe('required')
        expect(result.completed && result.capabilityCredit).toBe(true)
      }
      const sets = native.observations.filter((item: { api: string }) => item.api === 'DeviceIoControl(FSCTL_SET_REPARSE_POINT)')
      expect(sets.length).toBeGreaterThanOrEqual(4)
      expect(new Set(sets.map((item: any) => item.detail.bufferBase64)).size).toBe(1)
      for (const call of sets) {
        expect(call.detail.access).toBe(0x180)
        expect(call.detail.share).toBe(7)
        expect(call.detail.synchronous && call.detail.bytesReturnedPointerNonNull).toBe(true)
      }
      const blocked = sets.find((item: { caseName: string }) => item.caseName === 'sentinel-blocks-junction')
      expect(blocked.success).toBe(false)
      expect(blocked.win32Error).toBe(145)
      for (const name of ['pre-junction-relative-create', 'last-sentinel-junction-disposition']) {
        expect(sets.find((item: { caseName: string }) => item.caseName === name).success).toBe(true)
        const get = native.observations.find((item: any) => item.caseName === name && item.api === 'DeviceIoControl(FSCTL_GET_REPARSE_POINT)' && item.detail.exactTarget)
        expect(get.success && get.detail.sameIdentity).toBe(true)
        expect(get.detail.reparseTag).toBe('a0000003')
      }
      const hostile = native.observations.find((item: any) => item.name === 'hostile-root-sentinel' && item.api === 'NtCreateFile(FILE_CREATE)')
      expect(hostile.objectAttributes).toBe(0x1040)
      expect(hostile.createOptions).toBe(0x200060)
      expect(hostile.access).toBe(0x110080)
      expect(hostile.share).toBe(1)
      expect(native.checks.find((item: any) => item.name === 'pre-junction-create-no-outside-effect').status).toBe('passed')
      expect(native.checks.find((item: any) => item.name === 'pre-junction-root-admission-still-rejected').detail.admissionGranted).toBe(false)
      const finalCase = native.observations.filter((item: any) => item.caseName === 'last-sentinel-junction-disposition')
      const finalPin = finalCase.find((item: any) => item.api === 'OpenFileById' && item.name === 'last-sentinel-delete-pin')
      const finalDisposition = finalCase.find((item: any) => item.api === 'SetFileInformationByHandle(FileDispositionInfo)' && item.name === 'last-sentinel-directory-disposition')
      expect(finalDisposition.success).toBe(true)
      expect(finalDisposition.detail.handle).toBe(finalPin.detail.handle)
      const lateChild = native.observations.find((item: any) => item.name === 'late-child-directory-disposition' && item.api === 'SetFileInformationByHandle(FileDispositionInfo)')
      expect(lateChild.success).toBe(false)
      expect(lateChild.win32Error).toBe(145)
      const unprotected = native.caseResults.find((item: any) => item.name === 'control-nt-no-sentinel-pre-junction')
      expect(unprotected.role).toBe('diagnostic')
      expect(unprotected.capabilityCredit).toBe(false)
      for (const [caseName, reason] of [['byid-reject-canonical-drift', 'canonical-drift'], ['byid-reject-id-mismatch', 'id-mismatch']]) {
        const result = native.caseResults.find((item: { name: string }) => item.name === caseName)
        expect(result.role).toBe('required')
        expect(result.completed).toBe(true)
        const observations = native.observations.filter((item: { caseName: string }) => item.caseName === caseName)
        expect(observations.filter((item: { api: string }) => item.api === 'OpenFileById')).toHaveLength(1)
        const validation = observations.find((item: { api: string }) => item.api === 'ValidateByIdPruneCandidate')
        expect(validation.success).toBe(false)
        expect(validation.reason).toBe(reason)
        expect(validation.weakStillLive).toBe(true)
        expect(validation.removalMutationPerformed).toBe(false)
        if (reason === 'canonical-drift') {
          expect(validation.actualId).toBe(validation.expectedId)
          expect(validation.actualCanonical).not.toBe(validation.expectedCanonical)
          expect(observations.some((item: { api: string; success: boolean }) =>
            item.api === 'MoveFileExW(owned-fixture-barrier)' && item.success)).toBe(true)
        } else expect(validation.actualId).not.toBe(validation.expectedId)
        expect(observations.some((item: { api: string }) => item.api === 'SetFileInformationByHandle(FileDispositionInfo)')).toBe(false)
        expect(native.checks.some((check: { caseName: string; name: string; status: string }) =>
          check.caseName === caseName && check.name === 'rejection-keeps-owned-sentinels' && check.status === 'passed')).toBe(true)
      }
      for (const caseName of ['weak-lifetime', 'shared-reader-lifetime']) {
        expect(native.checks.some((check: { caseName?: string; name: string; status: string }) =>
          check.caseName === caseName && check.name === 'retained-handle-keeps-pending-object-live' && check.status === 'passed')).toBe(true)
      }
      expect(native.crossProcessPinnedAck).toBe('not_run')
      expect(native.completeFailureRestore).toBe('unknown')
      report.status = 'passed'
    } catch (error) {
      originalFailure = true
      report.status = 'failed'
      report.error = String(error)
      throw error
    } finally {
      let cleanupFailure: unknown
      try {
        if (mayCleanOwnedSandbox(nativeStarted, native)) {
          removeOwnedPlainTree(sandbox)
          report.cleanup = { status: existsSync(sandbox) ? 'failed' : 'passed', temporaryRootRemoved: !existsSync(sandbox), recursiveRmUsed: false }
        } else {
          report.cleanup = { status: 'unknown', temporaryRootRemoved: false, retainedOwnedRoot: sandbox,
            reason: 'Native completion, reparse state or handle closure is unknown', recursiveRmUsed: false }
          cleanupFailure = new Error('Owned native arena retained because cleanup is not proven safe')
        }
      } catch (error) {
        cleanupFailure = error
        report.cleanup = { status: 'failed', temporaryRootRemoved: false, retainedOwnedRoot: sandbox, error: String(error), recursiveRmUsed: false }
      } finally {
        if (cleanupFailure) report.status = 'failed'
        writeFileSync(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
      }
      if (cleanupFailure && !originalFailure) throw cleanupFailure
    }
  }, 90_000)
}
