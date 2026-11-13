import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { release, tmpdir, version } from 'node:os'
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
    const report: Record<string, unknown> = { version: 3, status: 'starting', platform: process.platform,
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
      const run = spawnSync(executable, [fixture, raw, versionsInput], { env, encoding: 'utf8', timeout: 30_000, windowsHide: true })
      report.run = { status: run.status, error: run.error?.message, stdout: run.stdout, stderr: run.stderr }
      expect(run.error).toBeUndefined()
      expect(existsSync(raw), 'Native observations must come from the executed owned fixture').toBe(true)
      copyFileSync(raw, join(evidence, 'native.raw.json'))
      const native = JSON.parse(readFileSync(raw, 'utf8'))
      report.native = native
      expect(run.status, JSON.stringify(native, null, 2)).toBe(0)
      expect(native.version).toBe(3)
      expect(native.status).toBe('passed')
      expect(native.chosenPrimitive).toBe('NtSetInformationFile(FileRenameInformation=10)+readonly-directory-guards+metadata-target-alias+OpenFileById-prune')
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
      const chosen = 'chosen-nt-readonly-byid-roundtrip'
      expect(native.caseResults.find((item: { name: string }) => item.name === chosen)).toEqual({
        name: chosen, role: 'required', completed: true, capabilityCredit: true, fullRoundtrip: true,
      })
      for (const name of ['relative-forward-existing-file-handle', 'rename-kept-source-object', 'prune-child-byid-same-handle-disposition',
        'prune-parent-byid-same-handle-disposition', 'relative-restore-after-prune', 'restore-kept-source-object', 'restore-preserved-owned-payload-bytes']) {
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
        item.api === 'NtSetInformationFile(FileRenameInformation)' && item.caseName !== chosen && item.caseName !== oldNt)).toHaveLength(0)
      expect(native.observations.filter((item: { caseName: string; api: string }) =>
        item.caseName === chosen && item.api === 'SetFileInformationByHandle(FileRenameInfo)')).toHaveLength(0)
      for (const call of ntCalls) {
        expect(call.caseName).toBe(chosen)
        expect(call.diagnosticOnly).toBe(false)
        expect(call.informationClass).toBe(10)
        expect(call.success && call.callSucceeded && call.ioSucceeded && call.completed).toBe(true)
        expect(Number.parseInt(call.ioNtStatus, 16)).toBeLessThan(0x80000000)
        expect(call.ioNtStatus).not.toBe('00000103')
        if (call.callWasPending) expect(call.wait.result).toBe(0)
        else {
          expect(Number.parseInt(call.callNtStatus, 16)).toBeLessThan(0x80000000)
          expect(call.callNtStatus).not.toBe('00000103')
        }
        expect(call.errorSource).toContain('derived')
        expect(call.detail.contractLength).toBe(true)
        expect(call.detail.bufferBytesIncludingNul).toBe(architecture === 'x86' ? 38 : 46)
      }
      const aliases = native.observations.filter((item: { caseName: string; api: string; name: string }) =>
        item.caseName === chosen && item.api === 'CreateFileW' && item.name.endsWith('metadata-alias'))
      expect(aliases).toHaveLength(2)
      for (const alias of aliases) {
        expect(alias.success).toBe(true)
        expect(alias.detail.access).toBe(0xa0)
        expect(alias.detail.share).toBe(7)
      }
      const aliasIdentities = native.checks.filter((item: { caseName: string; name: string }) =>
        item.caseName === chosen && item.name === 'independent-metadata-alias-same-object')
      expect(aliasIdentities).toHaveLength(2)
      for (const check of aliasIdentities) {
        expect(check.status).toBe('passed')
        expect(check.detail.independentCreateFile).toBe(true)
        expect(check.detail.duplicateHandle).toBe(false)
        expect(check.detail.strongAccess).toBe(0xa1)
        expect(check.detail.strongShare).toBe(1)
      }
      const strongDirectories = native.observations.filter((item: { api: string; name: string }) => item.api === 'CreateFileW' &&
        /(?:^|-)strong-(?:parent|child|stage)$|^restored-(?:parent|child)$/.test(item.name))
      expect(strongDirectories.length).toBeGreaterThan(0)
      for (const call of strongDirectories) {
        expect(call.detail.access).toBe(0x10087)
        expect(call.detail.share).toBe(1)
      }
      const readonlyGuards = native.observations.filter((item: { api: string; name: string }) => item.api === 'CreateFileW' &&
        /^(?:move|restore)-guard-/.test(item.name))
      expect(readonlyGuards.length).toBeGreaterThan(0)
      for (const call of readonlyGuards) {
        expect(call.success).toBe(true)
        expect(call.detail.access).toBe(0xa1)
        expect(call.detail.share).toBe(1)
      }
      const chosenObservations = native.observations.filter((item: { caseName: string }) => item.caseName === chosen)
      expect(chosenObservations.filter((item: { api: string }) => item.api === 'OpenFileById')).toHaveLength(2)
      expect(chosenObservations.filter((item: { api: string }) => item.api === 'SetFileInformationByHandle(FileDispositionInfo)')).toHaveLength(2)
      const volume = chosenObservations.find((item: { api: string }) => item.api === 'GetVolumeInformationByHandleW')
      expect(volume.success).toBe(true)
      expect(volume.detail.fileSystem).toBe('NTFS')
      for (const kind of ['child', 'parent']) {
        const name = `prune-${kind}-byid`
        const openIndex = chosenObservations.findIndex((item: { api: string; name: string }) => item.api === 'OpenFileById' && item.name === name)
        const validationIndex = chosenObservations.findIndex((item: { api: string; name: string }) =>
          item.api === 'ValidateByIdPruneCandidate' && item.name === name)
        const guardCloseIndex = chosenObservations.findIndex((item: { api: string; name: string }) =>
          item.api === 'CloseHandle' && item.name === `move-guard-${kind}`)
        const weakCloseIndex = chosenObservations.findIndex((item: { api: string; name: string }) =>
          item.api === 'CloseHandle' && item.name === `weak-${kind}`)
        const dispositionIndex = chosenObservations.findIndex((item: { api: string; name: string }) =>
          item.api === 'SetFileInformationByHandle(FileDispositionInfo)' && item.name === `${name}-disposition`)
        expect(guardCloseIndex).toBeGreaterThan(-1)
        expect(openIndex).toBeGreaterThan(guardCloseIndex)
        expect(validationIndex).toBeGreaterThan(openIndex)
        expect(weakCloseIndex).toBeGreaterThan(validationIndex)
        expect(dispositionIndex).toBeGreaterThan(weakCloseIndex)
        const open = chosenObservations[openIndex]
        expect(open.success).toBe(true)
        expect(open.detail.access).toBe(0x10080)
        expect(open.detail.share).toBe(1)
        expect(open.detail.flags).toBe(0x02200000)
        expect(open.detail.descriptorSize).toBe(24)
        expect(open.detail.descriptorType).toBe(0)
        expect(open.detail.securityAttributesNull && open.detail.guardClosed).toBe(true)
        const validated = chosenObservations[validationIndex]
        expect(validated.success && validated.weakStillLive && validated.weakSameIdentity && validated.noReparse && validated.directory).toBe(true)
        expect(validated.deletePending).toBe(false)
        expect(validated.reason).toBe('matched')
        expect(validated.actualId).toBe(validated.expectedId)
        expect(validated.actualVolume).toBe(validated.expectedVolume)
        expect(validated.actualVolume).toBe(volume.detail.serial)
        expect(validated.actualCanonical).toBe(validated.expectedCanonical)
        expect(validated.weakId).toBe(validated.actualId)
        expect(validated.weakVolume).toBe(validated.actualVolume)
        expect(validated.weakCanonical).toBe(validated.actualCanonical)
        expect(chosenObservations[weakCloseIndex].detail.handle).toBe(open.detail.weakHandle)
        expect(chosenObservations[weakCloseIndex].success).toBe(true)
        const disposition = chosenObservations[dispositionIndex]
        expect(disposition.success).toBe(true)
        expect(disposition.detail.handle).toBe(open.detail.handle)
        expect(disposition.detail.bytes).toBe(1)
        expect(disposition.detail.delete).toBe(true)
        expect(chosenObservations.slice(guardCloseIndex, dispositionIndex).some((item: { api: string }) => item.api === 'CreateFileW')).toBe(false)
      }
      const childDispositionIndex = chosenObservations.findIndex((item: { api: string; name: string }) =>
        item.api === 'SetFileInformationByHandle(FileDispositionInfo)' && item.name === 'prune-child-byid-disposition')
      for (const name of ['move-guard-parent', 'move-guard-stage', 'move-guard-case-root', 'move-guard-fixture-root']) {
        expect(chosenObservations.findIndex((item: { api: string; name: string }) => item.api === 'CloseHandle' && item.name === name))
          .toBeGreaterThan(childDispositionIndex)
      }
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
